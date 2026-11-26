// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  capTrust,
  closeValidity,
  cosine,
  decodeVector,
  encodeVector,
  entityKey,
  importance,
  nearest,
  parseJsonObject,
  relatedNotes,
  relatedSection,
  shouldArchive,
  targetScope,
  validateExtraction,
  validateNoteEntities,
  validateRelations,
} from "../src/intel";

const DAY = 86_400_000;

describe("vectors", () => {
  it("round-trips through a blob", () => {
    const v = [0.25, -1, 3.5];
    expect(Array.from(decodeVector(encodeVector(v)))).toEqual(v);
    expect(Array.from(decodeVector(new Uint8Array(encodeVector(v))))).toEqual(v);
  });
  it("computes cosine similarity", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
  it("finds the nearest candidates above a threshold", () => {
    const c = [{ id: "a", vec: [1, 0] }, { id: "b", vec: [0.9, 0.1] }, { id: "c", vec: [0, 1] }];
    const near = nearest([1, 0], c, 2, 0.5);
    expect(near.map((n) => n.item.id)).toEqual(["a", "b"]);
  });
});

describe("importance", () => {
  const now = Date.UTC(2026, 10, 25);
  it("ranks what the person said above what an agent guessed", () => {
    const base = { kind: "note" as const, confirmations: 1, accessCount: 0, lastTouched: now };
    expect(importance({ ...base, trust: "user_explicit" }, now)).toBeGreaterThan(importance({ ...base, trust: "agent_inference" }, now));
  });
  it("decays agent guesses faster than the person's own statements", () => {
    const old = { kind: "note" as const, confirmations: 1, accessCount: 0, lastTouched: now - 180 * DAY };
    const fresh = { ...old, lastTouched: now };
    const lossUser = importance({ ...fresh, trust: "user_explicit" }, now) - importance({ ...old, trust: "user_explicit" }, now);
    const lossAgent = importance({ ...fresh, trust: "agent_inference" }, now) - importance({ ...old, trust: "agent_inference" }, now);
    expect(lossAgent).toBeGreaterThan(lossUser);
  });
  it("grows with confirmations and use", () => {
    const base = { kind: "note" as const, trust: "agent_inference", lastTouched: now };
    expect(importance({ ...base, confirmations: 4, accessCount: 10 }, now)).toBeGreaterThan(importance({ ...base, confirmations: 1, accessCount: 0 }, now));
  });
  it("stays within 0 and 1", () => {
    const v = importance({ kind: "note", trust: "user_explicit", confirmations: 1000, accessCount: 1e6, lastTouched: now }, now);
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBeGreaterThan(0);
  });
  it("archives only old, unused, unimportant chunks", () => {
    const old = { kind: "chunk" as const, trust: "agent_inference", confirmations: 1, accessCount: 0, lastTouched: now - 400 * DAY, importance: 0.1 };
    expect(shouldArchive(old, now)).toBe(true);
    expect(shouldArchive({ ...old, accessCount: 1 }, now)).toBe(false);
    expect(shouldArchive({ ...old, kind: "note" }, now)).toBe(false);
    expect(shouldArchive({ ...old, lastTouched: now - 30 * DAY }, now)).toBe(false);
  });
});

describe("entities", () => {
  it("normalises names to one key", () => {
    expect(entityKey("Cloudflare Workers")).toBe(entityKey("cloudflare-workers"));
    expect(entityKey("Café Müller")).toBe("cafe muller");
    expect(entityKey("  Proxmox 9! ")).toBe("proxmox 9");
  });
});

describe("model output", () => {
  it("parses JSON wrapped in fences and reasoning", () => {
    expect(parseJsonObject('<think>hmm {no}</think>```json\n{"facts":[]}\n```')).toEqual({ facts: [] });
    expect(() => parseJsonObject("no json here")).toThrow();
  });

  it("validates and normalises an extraction", () => {
    const x = validateExtraction({
      facts: [
        { statement: "The user wants AGPL-3.0-or-later for every project.", kind: "preference", scope: "profile", trust: "user_explicit", valid_from: "2026-11-25", entities: ["AGPL-3.0"] },
        { statement: "short", kind: "fact" },
        { statement: "The homelab runs Proxmox 9.", kind: "weird", scope: "elsewhere", trust: "god", valid_from: "last friday", entities: ["Proxmox", 3] },
      ],
      entities: [{ name: "Proxmox", type: "tool" }, { name: "proxmox", type: "tool" }, { name: "", type: "tool" }],
    });
    expect(x.facts).toHaveLength(2);
    expect(x.facts[0]).toMatchObject({ kind: "preference", scope: "profile", trust: "user_explicit", entities: ["AGPL-3.0"] });
    expect(x.facts[0]!.validFrom).toBe(Date.parse("2026-11-25"));
    expect(x.facts[1]).toMatchObject({ kind: "fact", scope: "profile", trust: "agent_inference", validFrom: null, entities: ["Proxmox"] });
    expect(x.entities.map((e) => e.name)).toEqual(["Proxmox", "AGPL-3.0"]);
    expect(x.entities[1]!.type).toBe("concept");
  });

  it("rejects output without a facts array", () => {
    expect(() => validateExtraction({ entities: [] })).toThrow();
    expect(() => validateExtraction(null)).toThrow();
  });

  it("reads resolver relations and defaults the rest to new", () => {
    expect(validateRelations({ results: [{ pair: 1, relation: "update" }, { pair: 7, relation: "same" }, { pair: 0, relation: "maybe" }] }, 3)).toEqual(["new", "update", "new"]);
    expect(() => validateRelations({}, 2)).toThrow();
  });
});

describe("scope and trust rules", () => {
  it("puts facts where they belong", () => {
    expect(targetScope("profile", "project:rhizome")).toBe("profile");
    expect(targetScope("project", "project:rhizome")).toBe("project:rhizome");
    expect(targetScope("project", "profile")).toBe("profile");
    expect(targetScope("agent", "agent:hermes")).toBe("agent:hermes");
    expect(targetScope("agent", "project:x")).toBe("project:x");
  });
  it("never lets an episode without user messages claim the user said something", () => {
    expect(capTrust("user_explicit", false)).toBe("agent_inference");
    expect(capTrust("user_confirmed", false)).toBe("agent_inference");
    expect(capTrust("user_explicit", true)).toBe("user_explicit");
    expect(capTrust("tool", false)).toBe("tool");
  });
});

describe("note tagging", () => {
  it("keeps valid entities per note and drops the rest", () => {
    const out = validateNoteEntities(
      {
        notes: [
          { note: 0, entities: [{ name: "Cloudflare", type: "org" }, { name: "cloudflare", type: "org" }, { name: "Vibes", type: "mood" }] },
          { note: 5, entities: [{ name: "Out of range", type: "tool" }] },
          { note: 1, entities: [{ name: " ", type: "tool" }] },
        ],
      },
      2,
    );
    expect(out).toEqual([[{ name: "Cloudflare", type: "org" }, { name: "Vibes", type: "concept" }], []]);
    expect(() => validateNoteEntities({}, 1)).toThrow();
  });
});

describe("time and related memory", () => {
  it("reads end dates and relation labels from an extraction", () => {
    const x = validateExtraction({
      facts: [
        { statement: "The user hosted the homepage on Vercel.", valid_to: "2026-11-01", relation: "update", related: 2 },
        { statement: "The user disputes something stored earlier.", relation: "contradiction", related: 0 },
        { statement: "The user has a brand new preference here.", relation: "nonsense", related: -1, valid_to: "soon" },
      ],
    });
    expect(x.facts.map((f) => [f.relation, f.related, f.validTo])).toEqual([
      ["update", 2, Date.parse("2026-11-01")],
      ["contradicts", 0, null],
      [null, null, null],
    ]);
  });

  it("ranks related notes by full text and embeddings together", () => {
    const pool = [
      { id: "a", vec: [1, 0, 0] },
      { id: "b", vec: [0, 1, 0] },
      { id: "c", vec: [0.9, 0.1, 0] },
    ];
    expect(relatedNotes([1, 0, 0], pool, ["c", "x"]).map((n) => n.id)).toEqual(["c", "a"]);
    expect(relatedNotes(null, pool, ["b"]).map((n) => n.id)).toEqual(["b"]);
    expect(relatedNotes([1, 0, 0], pool, [], 1).map((n) => n.id)).toEqual(["a"]);
  });

  it("numbers related notes with their start date", () => {
    expect(relatedSection([])).toBe("");
    expect(relatedSection([{ content: "Uses  Node 26\nnow", validFrom: Date.parse("2026-11-25") }, { content: "Short replies", validFrom: null }])).toBe(
      "\n\nRelated memory:\n0. Uses Node 26 now (since 2026-11-25)\n1. Short replies",
    );
  });

  it("ends an old fact where the new one starts, never before it began", () => {
    expect(closeValidity(100, 300, 900)).toBe(300);
    expect(closeValidity(500, 300, 900)).toBe(500);
    expect(closeValidity(null, null, 900)).toBe(900);
    expect(closeValidity(100, null, 900)).toBe(900);
  });
});
