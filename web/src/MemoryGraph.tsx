// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The memory as a living 3D graph: notes coloured by trust, the conversations
// they came from, and the people, projects and tools they mention. Layout is a
// 3D force simulation that keeps settling while you look at it: related notes
// pull together along their edges, and each scope gathers around its own anchor.

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Html, OrbitControls } from "@react-three/drei";
import { forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ, type SimNode } from "d3-force-3d";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Graph, GraphEdge, GraphNode, NodeType } from "./types";

export const BG = "#FAF6F4";
export const TRUST_COLOR: Record<string, string> = {
  user_explicit: "#C81040",
  user_confirmed: "#FF2E52",
  agent_inference: "#FF8FAB",
  tool: "#FFC2D3",
};
const EPISODE_COLOR = "#B9AEB2";
const ENTITY_COLOR = "#1A1216";
const EDGE_COLOR = "#1A1216";
const RED_EDGES = new Set(["supersedes", "merged_into", "contradicts"]);
const SPARK_COLOR = "#FF2E52";
/** How close (in CSS pixels) the pointer has to be to a node to hover or pick it. */
const PICK_RADIUS = 14;

type Node3 = SimNode & GraphNode & { x: number; y: number; z: number; slot: number };

interface Props {
  graph: Graph;
  highlight: Set<string> | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  reducedMotion: boolean;
  /** A panel covers the right side of the canvas. */
  rightPanel: boolean;
}

/** Bloom Ease from the brand book: cubic-bezier(0.22, 1.1, 0.36, 1). */
function bloomEase(t: number): number {
  // Solve x(s) = t for the bezier parameter, then return y(s).
  const x1 = 0.22, y1 = 1.1, x2 = 0.36, y2 = 1;
  const bx = (s: number) => 3 * (1 - s) ** 2 * s * x1 + 3 * (1 - s) * s ** 2 * x2 + s ** 3;
  const by = (s: number) => 3 * (1 - s) ** 2 * s * y1 + 3 * (1 - s) * s ** 2 * y2 + s ** 3;
  let lo = 0, hi = 1, s = t;
  for (let i = 0; i < 20; i++) {
    s = (lo + hi) / 2;
    if (bx(s) < t) lo = s;
    else hi = s;
  }
  return by(s);
}

function hash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function baseSize(n: GraphNode): number {
  if (n.type === "entity") return 1.2 + Math.min(1.8, Math.log2(1 + n.weight) * 0.45);
  if (n.type === "episode") return 1.1;
  return 1.2 + n.importance * 2.2;
}

function baseColor(n: GraphNode): THREE.Color {
  if (n.type === "entity") return new THREE.Color(ENTITY_COLOR);
  if (n.type === "episode") return new THREE.Color(EPISODE_COLOR);
  const c = new THREE.Color(TRUST_COLOR[n.trust ?? ""] ?? TRUST_COLOR.agent_inference);
  if (n.status === "superseded") c.lerp(new THREE.Color(BG), 0.75);
  return c;
}

export function MemoryGraph(props: Props) {
  return (
    <Canvas
      camera={{ position: [0, 40, 260], fov: 42, near: 1, far: 2000 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false }}
    >
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 420, 1300]} />
      <ambientLight intensity={0.9} />
      <hemisphereLight args={["#ffffff", "#f3e6e9", 0.6]} />
      <directionalLight position={[90, 140, 120]} intensity={1.2} />
      <Scene {...props} />
    </Canvas>
  );
}

function Scene({ graph, highlight, selected, onSelect, reducedMotion, rightPanel }: Props) {
  const { camera } = useThree();
  const controls = useRef<OrbitControlsImpl>(null);
  const meshes = { note: useRef<THREE.InstancedMesh>(null), episode: useRef<THREE.InstancedMesh>(null), entity: useRef<THREE.InstancedMesh>(null) };
  const lines = useRef<THREE.LineSegments>(null);
  const [hovered, setHovered] = useState<Node3 | null>(null);
  const [interacting, setInteracting] = useState(false);
  const born = useRef(performance.now());
  const fly = useRef<{ from: THREE.Vector3; to: THREE.Vector3; camFrom: THREE.Vector3; camTo: THREE.Vector3; start: number } | null>(null);

  // Simulation nodes keep their position across graph reloads, so a refresh doesn't scramble the layout.
  const previous = useRef(new Map<string, { x: number; y: number; z: number }>());
  const { nodes, byType, links, byId } = useMemo(() => {
    const byType: Record<NodeType, Node3[]> = { note: [], episode: [], entity: [] };
    const nodes: Node3[] = graph.nodes.map((n) => {
      const prev = previous.current.get(n.id);
      const r = 40 + hash(n.id) * 80;
      const theta = hash(n.id + "t") * Math.PI * 2;
      const phi = Math.acos(2 * hash(n.id + "p") - 1);
      const node: Node3 = {
        ...n,
        x: prev?.x ?? r * Math.sin(phi) * Math.cos(theta),
        y: prev?.y ?? r * Math.cos(phi),
        z: prev?.z ?? r * Math.sin(phi) * Math.sin(theta),
        slot: byType[n.type].length,
      };
      byType[n.type].push(node);
      return node;
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // "similar" is stored per direction; A→B and B→A draw one line.
    const seen = new Set<string>();
    const links = graph.edges
      .filter((e) => {
        if (!byId.has(e.source) || !byId.has(e.target)) return false;
        const key = e.kind === "similar" ? [e.source, e.target].sort().join("|") + "|similar" : `${e.source}|${e.target}|${e.kind}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((e) => ({ ...e }));
    return { nodes, byType, links, byId };
  }, [graph]);

  // Every scope gets an anchor on a ring, so profile, each project and each agent form their own region.
  const anchors = useMemo(() => {
    const scopes = [...new Set(nodes.map((n) => n.scope).filter((s): s is string => Boolean(s)))].sort();
    const map = new Map<string, { x: number; y: number; z: number }>();
    const radius = scopes.length > 1 ? 55 + scopes.length * 12 : 0;
    scopes.forEach((s, i) => {
      // profile sits in the middle: it is what every project shares.
      if (s === "profile" && scopes.length > 1) return void map.set(s, { x: 0, y: 0, z: 0 });
      const a = (i / scopes.length) * Math.PI * 2;
      map.set(s, { x: Math.cos(a) * radius, y: (hash(s) - 0.5) * radius * 0.5, z: Math.sin(a) * radius });
    });
    return map;
  }, [nodes]);

  const sim = useMemo(() => {
    const s = forceSimulation(nodes, 3)
      .force(
        "link",
        forceLink<Node3>(links as never)
          .id((n) => n.id)
          .distance((l) => {
            const kind = (l as unknown as GraphEdge).kind;
            return kind === "mentions" ? 30 : kind === "derived_from" ? 20 : kind === "similar" ? 16 : 12;
          })
          .strength((l) => {
            const e = l as unknown as GraphEdge;
            return e.kind === "similar" ? 0.15 + 0.4 * e.weight : e.kind === "mentions" ? 0.25 : 0.5;
          }),
      )
      .force("charge", forceManyBody().strength((n) => ((n as Node3).type === "entity" ? -70 : -24)).distanceMax(260))
      .force("center", forceCenter(0, 0, 0))
      .force("scopeX", forceX((n) => anchors.get((n as Node3).scope ?? "")?.x ?? 0).strength((n) => ((n as Node3).scope ? 0.06 : 0)))
      .force("scopeY", forceY((n) => anchors.get((n as Node3).scope ?? "")?.y ?? 0).strength((n) => ((n as Node3).scope ? 0.06 : 0)))
      .force("scopeZ", forceZ((n) => anchors.get((n as Node3).scope ?? "")?.z ?? 0).strength((n) => ((n as Node3).scope ? 0.06 : 0)))
      .alphaDecay(0.018)
      .velocityDecay(0.35)
      .stop();
    // A head start, so the first frame already shows structure.
    s.tick(previous.current.size ? 5 : 80);
    return s;
  }, [nodes, links, anchors]);

  // Frame the whole memory on first load: the camera backs off until every node fits.
  const { size } = useThree();
  useEffect(() => {
    if (previous.current.size || !controls.current || nodes.length === 0) return;
    const d = nodes.map((n) => Math.hypot(n.x, n.y, n.z)).sort((a, b) => a - b);
    const radius = d[Math.floor(d.length * 0.92)] ?? 100;
    const fov = ((camera as THREE.PerspectiveCamera).fov * Math.PI) / 180;
    const distance = Math.min(1200, Math.max(120, (radius * 1.25) / Math.sin(fov / 2)));
    const dir = camera.position.clone().sub(controls.current.target).normalize();
    camera.position.copy(dir.multiplyScalar(distance));
    controls.current.target.set(0, 0, 0);
  }, [nodes, camera]);

  // The side panels cover part of the canvas, so the visual centre moves right.
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const shift = size.width > 900 ? (rightPanel ? -60 : 150) : 0;
    if (shift) cam.setViewOffset(size.width, size.height, -shift, 0, size.width, size.height);
    else cam.clearViewOffset();
    cam.updateProjectionMatrix();
  }, [camera, size, rightPanel]);

  useEffect(() => {
    born.current = performance.now();
    return () => {
      for (const n of nodes) previous.current.set(n.id, { x: n.x, y: n.y, z: n.z });
    };
  }, [nodes]);

  // Neighbourhood of the selection, so the rest can step back.
  const focusSet = useMemo(() => {
    if (!selected) return null;
    const set = new Set([selected]);
    for (const l of links) {
      const s = typeof l.source === "string" ? l.source : (l.source as unknown as Node3).id;
      const t = typeof l.target === "string" ? l.target : (l.target as unknown as Node3).id;
      if (s === selected) set.add(t);
      if (t === selected) set.add(s);
    }
    return set;
  }, [selected, links]);

  // Fly to the selection, or to the centre of the search hits.
  useEffect(() => {
    const targets = selected ? [byId.get(selected)].filter(Boolean) : highlight ? [...highlight].map((id) => byId.get(id)).filter(Boolean) : [];
    if (!targets.length || !controls.current) return;
    const centre = new THREE.Vector3();
    for (const n of targets as Node3[]) centre.add(new THREE.Vector3(n.x, n.y, n.z));
    centre.divideScalar(targets.length);
    const spread = Math.max(...(targets as Node3[]).map((n) => centre.distanceTo(new THREE.Vector3(n.x, n.y, n.z))), 0);
    const distance = selected ? 150 : Math.min(420, 160 + spread * 2.2);
    const dir = camera.position.clone().sub(controls.current.target).normalize();
    fly.current = {
      from: controls.current.target.clone(),
      to: centre,
      camFrom: camera.position.clone(),
      camTo: centre.clone().add(dir.multiplyScalar(distance)),
      start: performance.now(),
    };
  }, [selected, highlight, byId, camera]);

  const temp = useMemo(() => new THREE.Object3D(), []);
  const color = useMemo(() => new THREE.Color(), []);
  const bg = useMemo(() => new THREE.Color(BG), []);
  const edgeBase = useMemo(() => new THREE.Color(EDGE_COLOR), []);
  const red = useMemo(() => new THREE.Color("#C81040"), []);

  // Only "real" relations carry sparks; history edges (supersedes and so on) stay quiet.
  const sparkLinks = useMemo(() => links.map((l, i) => (RED_EDGES.has(l.kind) ? -1 : i)).filter((i) => i >= 0), [links]);
  const sparks = useMemo(
    () => Array.from({ length: Math.min(48, Math.ceil(sparkLinks.length / 2)) }, () => ({ edge: -1, t: Math.random(), speed: 0.004 + Math.random() * 0.006, forward: true })),
    [sparkLinks],
  );
  // Round sparks: points are squares unless they get a round texture.
  const dot = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(16, 16, 15, 0, Math.PI * 2);
    g.fill();
    return new THREE.CanvasTexture(c);
  }, []);
  const sparkGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(Math.max(sparks.length, 1) * 3).fill(-1e6), 3));
    return g;
  }, [sparks]);

  const edgeGeometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(links.length * 6), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(links.length * 6), 3));
    return g;
  }, [links]);

  useFrame(() => {
    const now = performance.now();
    if (sim.alpha() > 0.004) sim.tick(reducedMotion ? 4 : 1);

    if (fly.current && controls.current) {
      const t = Math.min(1, (now - fly.current.start) / (reducedMotion ? 1 : 900));
      const k = bloomEase(t);
      controls.current.target.lerpVectors(fly.current.from, fly.current.to, k);
      camera.position.lerpVectors(fly.current.camFrom, fly.current.camTo, k);
      if (t >= 1) fly.current = null;
    }

    const age = reducedMotion ? 1 : Math.min(1, (now - born.current) / 900);
    const dimmed = (id: string) => (focusSet ? !focusSet.has(id) : highlight ? !highlight.has(id) : false);
    for (const type of ["note", "episode", "entity"] as NodeType[]) {
      const mesh = meshes[type].current;
      if (!mesh) continue;
      for (const n of byType[type]) {
        // Unfurl from the centre, staggered a little per node.
        const local = Math.max(0, Math.min(1, (age - (n.slot % 40) * 0.006) / 0.75));
        let scale = baseSize(n) * bloomEase(local);
        if (n.status === "disputed" && !reducedMotion) scale *= 1 + 0.12 * Math.sin(now / 420);
        if (n.id === selected) scale *= 1.6;
        else if (hovered?.id === n.id) scale *= 1.3;
        temp.position.set(n.x, n.y, n.z);
        temp.scale.setScalar(Math.max(scale, 0.0001));
        temp.updateMatrix();
        mesh.setMatrixAt(n.slot, temp.matrix);
        color.copy(baseColor(n));
        if (dimmed(n.id)) color.lerp(bg, 0.86);
        mesh.setColorAt(n.slot, color);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }

    const pos = edgeGeometry.getAttribute("position") as THREE.BufferAttribute;
    const col = edgeGeometry.getAttribute("color") as THREE.BufferAttribute;
    links.forEach((l, i) => {
      const s = l.source as unknown as Node3;
      const t = l.target as unknown as Node3;
      if (typeof s !== "object" || typeof t !== "object") return;
      pos.setXYZ(i * 2, s.x, s.y, s.z);
      pos.setXYZ(i * 2 + 1, t.x, t.y, t.z);
      const active = focusSet ? focusSet.has(s.id) && focusSet.has(t.id) && (s.id === selected || t.id === selected) : highlight ? highlight.has(s.id) || highlight.has(t.id) : true;
      color.copy(RED_EDGES.has(l.kind) ? red : edgeBase);
      // Stronger similarity draws a darker line, like a well-used connection.
      const fade = focusSet || highlight
        ? active ? 0.3 : 0.97
        : RED_EDGES.has(l.kind) ? 0.45
        : l.kind === "similar" ? Math.min(0.66, Math.max(0.36, 0.66 - (l.weight - 0.55) * 2))
        : l.kind === "mentions" ? 0.62
        : 0.7;
      color.lerp(bg, fade);
      col.setXYZ(i * 2, color.r, color.g, color.b);
      col.setXYZ(i * 2 + 1, color.r, color.g, color.b);
    });
    pos.needsUpdate = true;
    col.needsUpdate = true;
    edgeGeometry.computeBoundingSphere();

    // Sparks run along the edges, like signals through a network. With a selection, only along its edges.
    if (reducedMotion || !sparkLinks.length) return;
    const spos = sparkGeometry.getAttribute("position") as THREE.BufferAttribute;
    const pool = focusSet ? sparkLinks.filter((i) => {
      const l = links[i]!;
      return (l.source as unknown as Node3).id === selected || (l.target as unknown as Node3).id === selected;
    }) : sparkLinks;
    // With a selection, two sparks per edge at most, so a node with few edges doesn't look crowded.
    const active = focusSet ? Math.min(sparks.length, pool.length * 2) : sparks.length;
    sparks.forEach((sp, i) => {
      if (i >= active) {
        spos.setXYZ(i, 0, 0, -1e6);
        return;
      }
      sp.t += sp.speed;
      if (sp.t >= 1 || sp.edge < 0 || (focusSet && !pool.includes(sp.edge))) {
        sp.edge = pool.length ? pool[Math.floor(Math.random() * pool.length)]! : -1;
        sp.t = sp.t >= 1 ? 0 : Math.random();
        sp.forward = Math.random() < 0.5;
      }
      const l = sp.edge >= 0 ? links[sp.edge] : undefined;
      const a = l?.source as unknown as Node3 | undefined;
      const b = l?.target as unknown as Node3 | undefined;
      if (!a || !b || typeof a !== "object" || typeof b !== "object") {
        spos.setXYZ(i, 0, 0, -1e6);
        return;
      }
      const k = sp.forward ? sp.t : 1 - sp.t;
      spos.setXYZ(i, a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, a.z + (b.z - a.z) * k);
    });
    spos.needsUpdate = true;
  });

  // Picking happens in screen space: the nearest node within a few pixels of the pointer.
  // Raycasting the tiny instanced spheres missed most clicks while the layout was moving.
  const { gl } = useThree();
  const projected = useMemo(() => new THREE.Vector3(), []);
  const nearestAt = (clientX: number, clientY: number): Node3 | null => {
    const rect = gl.domElement.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: Node3 | null = null;
    let bestD = Infinity;
    for (const n of nodes) {
      projected.set(n.x, n.y, n.z).project(camera);
      if (projected.z > 1) continue; // behind the camera
      const px = ((projected.x + 1) / 2) * rect.width;
      const py = ((1 - projected.y) / 2) * rect.height;
      const d = Math.hypot(px - x, py - y);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return bestD <= PICK_RADIUS ? best : null;
  };
  const pickRef = useRef(nearestAt);
  pickRef.current = nearestAt;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;
    const move = (e: PointerEvent) => {
      if (e.buttons) return; // dragging the camera
      const n = pickRef.current(e.clientX, e.clientY);
      setHovered((h) => (h?.id === n?.id ? h : n));
      el.style.cursor = n ? "pointer" : "";
    };
    const press = (e: PointerEvent) => void (down = { x: e.clientX, y: e.clientY });
    const release = (e: PointerEvent) => {
      // A drag rotates the camera, it is not a click.
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return void (down = null);
      down = null;
      selectRef.current(pickRef.current(e.clientX, e.clientY)?.id ?? null);
    };
    const leave = () => {
      setHovered(null);
      el.style.cursor = "";
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", press);
    el.addEventListener("pointerup", release);
    el.addEventListener("pointerleave", leave);
    return () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", press);
      el.removeEventListener("pointerup", release);
      el.removeEventListener("pointerleave", leave);
    };
  }, [gl]);

  // Names of the most mentioned entities stay visible as landmarks.
  const landmarks = useMemo(() => [...byType.entity].sort((a, b) => b.weight - a.weight).slice(0, 12), [byType]);
  const sel = selected ? byId.get(selected) : undefined;

  return (
    <>
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        autoRotate={!reducedMotion && !interacting && !selected}
        autoRotateSpeed={0.35}
        minDistance={20}
        maxDistance={900}
        onStart={() => setInteracting(true)}
        onEnd={() => setTimeout(() => setInteracting(false), 4000)}
      />
      <lineSegments ref={lines} geometry={edgeGeometry} frustumCulled={false}>
        <lineBasicMaterial vertexColors />
      </lineSegments>
      {!reducedMotion && sparks.length > 0 && (
        <points geometry={sparkGeometry} frustumCulled={false}>
          <pointsMaterial color={SPARK_COLOR} map={dot} alphaTest={0.4} size={1.6} sizeAttenuation transparent opacity={0.9} depthWrite={false} />
        </points>
      )}
      <instancedMesh
        key={`note-${byType.note.length}`}
        ref={meshes.note}
        args={[undefined, undefined, Math.max(byType.note.length, 1)]}
        count={byType.note.length}
        frustumCulled={false}
      >
        <icosahedronGeometry args={[1, 3]} />
        <meshStandardMaterial roughness={0.5} metalness={0.05} />
      </instancedMesh>
      <instancedMesh
        key={`episode-${byType.episode.length}`}
        ref={meshes.episode}
        args={[undefined, undefined, Math.max(byType.episode.length, 1)]}
        count={byType.episode.length}
        frustumCulled={false}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshStandardMaterial roughness={0.7} metalness={0} flatShading />
      </instancedMesh>
      <instancedMesh
        key={`entity-${byType.entity.length}`}
        ref={meshes.entity}
        args={[undefined, undefined, Math.max(byType.entity.length, 1)]}
        count={byType.entity.length}
        frustumCulled={false}
      >
        <sphereGeometry args={[1, 24, 16]} />
        <meshStandardMaterial roughness={0.35} metalness={0.1} />
      </instancedMesh>

      {anchors.size > 1 &&
        [...anchors.keys()].map((scope) => (
          <ScopeLabel key={scope} nodes={byType.note.filter((n) => n.scope === scope)} faded={Boolean(focusSet || highlight)}>
            {scope}
          </ScopeLabel>
        ))}
      {landmarks.map((n) => (
        <Follow key={n.id} node={n}>
          <span className={`landmark${focusSet && !focusSet.has(n.id) ? " faded" : ""}`}>{n.label}</span>
        </Follow>
      ))}
      {hovered && hovered.id !== selected && (
        <Follow node={hovered}>
          <div className="tip">
            <span className="tip-kind">{hovered.type === "note" ? `${hovered.kind} · ${hovered.trust?.replace("_", " ")}` : hovered.type === "episode" ? `conversation · ${hovered.agent}` : hovered.kind}</span>
            <span className="tip-text">{hovered.label}</span>
          </div>
        </Follow>
      )}
      {sel && (
        <Follow node={sel}>
          <span className="selected-ring" />
        </Follow>
      )}
    </>
  );
}

/** A scope's name, floating above the middle of its notes. */
function ScopeLabel({ nodes, faded, children }: { nodes: Node3[]; faded: boolean; children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => {
    if (!group.current || nodes.length === 0) return;
    let x = 0, y = -Infinity, z = 0;
    for (const n of nodes) {
      x += n.x;
      z += n.z;
      y = Math.max(y, n.y);
    }
    group.current.position.set(x / nodes.length, y + 8, z / nodes.length);
  });
  if (nodes.length === 0) return null;
  return (
    <group ref={group}>
      <Html center zIndexRange={[15, 0]} style={{ pointerEvents: "none" }}>
        <span className={`scope-label${faded ? " faded" : ""}`}>{children}</span>
      </Html>
    </group>
  );
}

/** HTML that follows a node while the simulation moves it. */
function Follow({ node, children }: { node: Node3; children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  useFrame(() => group.current?.position.set(node.x, node.y, node.z));
  return (
    <group ref={group} position={[node.x, node.y, node.z]}>
      <Html center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        {children}
      </Html>
    </group>
  );
}
