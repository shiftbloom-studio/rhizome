// SPDX-License-Identifier: AGPL-3.0-or-later
// Walls: named groups of projects, one per client. A walled project is only
// searched when an agent names it. Off until the person sets a wall here.
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Held, Wall } from "./types";

const SLUG = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export function Walls({ scopes, onNotice, onChanged }: { scopes: string[]; onNotice: (msg: string) => void; onChanged: () => void }) {
  const [walls, setWalls] = useState<Wall[] | null>(null);
  const [held, setHeld] = useState<Held[]>([]);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [w, h] = await Promise.all([api.walls(), api.held()]);
      setWalls(w.walls);
      setHeld(h.held);
    } catch (e) {
      onNotice(String((e as Error).message));
    }
  }, [onNotice]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!walls) return null;
  const projects = scopes.filter((s) => s.startsWith("project:"));
  const taken = new Map(walls.flatMap((w) => w.scopes.map((s) => [s, w.name] as const)));
  const editing = walls.find((w) => w.name === name.trim());
  const valid = SLUG.test(name.trim()) && picked.length > 0;

  const edit = (w: Wall) => {
    setName(w.name);
    setPicked(w.scopes);
  };
  const toggle = (s: string) => setPicked(picked.includes(s) ? picked.filter((x) => x !== s) : [...picked, s]);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await api.setWall(name.trim(), picked);
      onNotice(`Wall ${name.trim()} saved.`);
      setName("");
      setPicked([]);
      await load();
    } catch (err) {
      onNotice(String((err as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const decide = async (h: Held, decision: "release" | "dismiss") => {
    try {
      await api.decideHeld(h.id, decision);
      onNotice(decision === "release" ? `Moved to ${h.to}.` : `Kept in ${h.from}.`);
      await load();
      onChanged();
    } catch (err) {
      onNotice(String((err as Error).message));
    }
  };
  const remove = async (w: Wall) => {
    try {
      await api.removeWall(w.name);
      onNotice(`Wall ${w.name} removed. Its projects are searched as before.`);
      if (name.trim() === w.name) {
        setName("");
        setPicked([]);
      }
      await load();
    } catch (err) {
      onNotice(String((err as Error).message));
    }
  };

  return (
    <section>
      <h2 className="label">walls</h2>
      <p className="muted small">Group one client's projects behind a wall. Agents search them only when they name the project.</p>
      {walls.length > 0 && (
        <ul className="walls">
          {walls.map((w) => (
            <li key={w.name}>
              <div className="wall-head">
                <strong>{w.name}</strong>
                <span>
                  <button type="button" className="link" onClick={() => edit(w)}>Edit</button>
                  {" · "}
                  <button type="button" className="link" onClick={() => void remove(w)}>Remove</button>
                </span>
              </div>
              <div className="chips">{w.scopes.map((s) => <span key={s} className="chip on">{s}</span>)}</div>
            </li>
          ))}
        </ul>
      )}
      {held.length > 0 && (
        <div className="held">
          <h3 className="label red">held · {held.length}</h3>
          <p className="muted small">Learned inside a wall and kept there. Release one to let it go where it wanted to.</p>
          <ul>
            {held.map((h) => (
              <li key={h.id}>
                <span className="text">{h.content}</span>
                <span className="meta label">{h.from} → {h.to}</span>
                <span className="actions-row">
                  <button type="button" className="link" onClick={() => void decide(h, "release")}>Release to {h.to}</button>
                  {" · "}
                  <button type="button" className="link" onClick={() => void decide(h, "dismiss")}>Keep in {h.from}</button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {projects.length > 0 ? (
        <form className="remember" onSubmit={save}>
          <input className="wall-name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="wall name, e.g. acme" aria-label="Wall name" maxLength={48} />
          <div className="chips">
            {projects.map((s) => {
              const other = taken.get(s);
              const locked = other !== undefined && other !== name.trim();
              return (
                <button key={s} type="button" className={`chip${picked.includes(s) ? " on" : ""}`} disabled={locked} title={locked ? `behind the wall ${other}` : undefined} onClick={() => toggle(s)}>
                  {s}
                </button>
              );
            })}
          </div>
          <div className="row">
            <button className="btn" disabled={busy || !valid}>{editing ? "Update wall" : "Save wall"}</button>
          </div>
        </form>
      ) : (
        <p className="muted small">No projects yet.</p>
      )}
    </section>
  );
}
