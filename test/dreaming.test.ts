// SPDX-License-Identifier: AGPL-3.0-or-later
// Dreaming: the guards on what the model proposes (src/dreaming.ts) and the care
// pass in the MemoryObject (cursor, budget, idle wait, audit, rollups, forget).
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DREAM_IDLE_MS, DREAM_PROMPT, dreamInput, numbers, planDream, type DreamNote } from "../src/dreaming";
import { MemoryObject } from "../src/memory-object";
import type { Client } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

const day = (s: string) => Date.parse(`${s}T12:00:00Z`);
const note = (id: string, content: string, t: string, extra: Partial<DreamNote> = {}): DreamNote => ({
  id, content, kind: "fact", trust: "user_explicit", t: day(t), vec: [1, 0, 0], ...extra,
});

describe("planDream guards", () => {
  const group = [
    note("a", "The user attended Rachel and Mike's wedding.", "2023-03-12"),
    note("b", "User went to Emily and Sarah's wedding.", "2023-06-03"),
    note("c", "User went to a wedding of Emily and Sarah.", "2023-06-03", { trust: "agent_inference" }),
    note("d", "The user works as a nurse at St. Mary's.", "2023-01-10", { vec: [0.7, 0.7, 0] }),
    note("e", "User started a new job at Valley Clinic.", "2023-08-01", { vec: [0.7, 0.7, 0] }),
    note("f", "it cost around 450 dollars", "2023-06-03", { trust: "agent_inference", kind: "note" }),
    note("g", "The user paid 200 for the dress.", "2023-06-03", { vec: [0, 1, 0] }),
    note("r", "Weddings attended:\n- Rachel and Mike (2023-03-12)", "2023-03-12", { rollupOf: ["a", "x"], trust: "agent_inference" }),
  ];

  it("keeps sound proposals", () => {
    const plan = planDream(
      {
        merge: [{ keep: 1, drop: [2] }],
        supersede: [{ old: 3, new: 4 }],
        rewrite: [{ note: 5, text: "The wedding on 2023-06-03 cost around 450 dollars." }],
        kind: [{ note: 0, kind: "fact" }, { note: 6, kind: "decision" }],
        rollups: [{ members: [0, 1, 7], text: "Weddings attended:\n- Rachel and Mike (2023-03-12)\n- Emily and Sarah (2023-06-03)" }],
      },
      group,
    );
    expect(plan.merge).toEqual([{ keep: "b", drop: ["c"] }]);
    expect(plan.supersede).toEqual([{ old: "d", new: "e" }]);
    expect(plan.rewrite).toEqual([{ id: "f", content: "The wedding on 2023-06-03 cost around 450 dollars." }]);
    // Same kind as before is no change.
    expect(plan.kind).toEqual([{ id: "g", kind: "decision" }]);
    // The earlier rollup is replaced, and its members outside the group stay listed.
    expect(plan.rollups).toEqual([{ members: ["a", "b", "x"], replaces: ["r"], content: expect.stringContaining("Emily"), t: day("2023-06-03") }]);
    expect(plan.rejected).toEqual([]);
  });

  it("turns down merges of distant notes, merges that lose a number, and notes used twice", () => {
    const plan = planDream({ merge: [{ keep: 0, drop: [6] }, { keep: 1, drop: [5] }, { keep: 1, drop: [2] }, { keep: 2, drop: [0] }] }, group);
    expect(plan.merge).toEqual([{ keep: "b", drop: ["c"] }]);
    expect(plan.rejected).toEqual(["merge g into a: similarity 0.00", "merge f into b: numbers differ"]);
  });

  it("turns down replacements by an older, less trusted or unrelated note", () => {
    const plan = planDream({ supersede: [{ old: 4, new: 3 }, { old: 1, new: 2 }, { old: 0, new: 6 }] }, [...group.slice(0, 2), { ...group[2]!, t: day("2023-07-01") }, ...group.slice(3)]);
    expect(plan.supersede).toEqual([]);
    expect(plan.rejected).toEqual([
      "supersede e by d: replacement is older",
      "supersede b by c: replacement is less trusted",
      "supersede a by g: not about the same thing",
    ]);
  });

  it("rewrites keep every number, add only the note's date and never touch the person's own words", () => {
    const plan = planDream(
      {
        rewrite: [
          { note: 5, text: "The dress cost around 45 dollars." },
          { note: 5, text: "On 2024-01-01 it cost around 450 dollars." },
          { note: 0, text: "Rachel and Mike married; the user was there." },
          { note: 5, text: "The wedding of Emily and Sarah cost around 450 dollars." },
        ],
      },
      group,
    );
    expect(plan.rewrite).toEqual([{ id: "f", content: "The wedding of Emily and Sarah cost around 450 dollars." }]);
    expect(plan.rejected).toEqual(["rewrite f: numbers changed", "rewrite f: numbers changed", "rewrite a: the person's own words"]);
  });

  it("rollups need two members and may only use their numbers and dates", () => {
    const plan = planDream(
      {
        rollups: [
          { members: [0], text: "Weddings:\n- Rachel and Mike (2023-03-12)" },
          { members: [0, 1], text: "Weddings (3 in total):\n- Rachel and Mike (2023-03-12)\n- Emily and Sarah (2023-10-01)" },
          { members: [0, 1, 99], text: "Weddings attended:\n- Rachel and Mike (2023-03-12)\n- Emily and Sarah (2023-06-03)" },
        ],
      },
      group,
    );
    expect(plan.rollups).toHaveLength(1);
    expect(plan.rollups[0]!.members).toEqual(["a", "b"]);
    expect(plan.rejected[0]).toMatch(/rollup: 1 members/);
    // The reason names no numbers: rejections are logged, and the log keeps no memory text.
    expect(plan.rejected[1]).toBe("rollup: 2 numbers not in its members");
  });

  it("never lets a guess take over the person's own wording in a merge", () => {
    const plan = planDream({ merge: [{ keep: 2, drop: [1] }] }, group);
    expect(plan.merge).toEqual([]);
    expect(plan.rejected).toEqual(["merge b into c: would replace more trusted wording"]);
  });

  it("does not replace a rollup with one that drops its entries", () => {
    const trips = [note("t1", "The user flew to Lisbon.", "2023-03-12"), note("t2", "The user took a train to Porto.", "2023-07-04"), group[7]!];
    const lossy = planDream({ rollups: [{ members: [1, 2], text: "Trips:\n- Porto (2023-07-04)" }] }, trips);
    expect(lossy.rollups).toEqual([]);
    expect(lossy.rejected).toEqual(["rollup: would drop entries of rollup r"]);
  });

  it("ignores garbage", () => {
    expect(planDream(null, group)).toMatchObject({ merge: [], supersede: [], rewrite: [], kind: [], rollups: [] });
    expect(planDream({ merge: "x", rollups: [{ members: "0,1", text: 5 }], kind: [{ note: 0, kind: "weird" }] }, group).kind).toEqual([]);
  });

  it("shows rollups with the numbers of their members", () => {
    expect(dreamInput(group).split("\n").at(-1)).toBe("7. (2023-03-12, ROLLUP of 0) Weddings attended: | - Rachel and Mike (2023-03-12)");
    expect([...numbers("On 2023-03-12, 1,5 kg and 03")]).toEqual(["2023", "3", "12", "1.5"]);
  });
});

// --------------------------------------------------------------- pipeline

const grants = { read: ["profile", "project:*"], write: ["profile", "project:*"] };
const claude: Client = { id: "c1", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants };

let now = Date.UTC(2026, 10, 27, 12);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

let dreamInputs: string[] = [];
/** Runs while the model "thinks", e.g. to forget a note mid-call. */
let duringCall: (() => void) | null = null;
/** The dreaming model: merges the two tea notes, replaces the old job, rolls up the weddings. */
function generate(_model: string, system: string, user: string): string {
  if (system !== DREAM_PROMPT) return "{}";
  dreamInputs.push(user);
  if (duringCall && user.includes("Rachel")) {
    duringCall();
    duringCall = null;
  }
  const lines = user.split("\n").filter((l) => /^\d+\. /.test(l));
  const date = (i: number) => lines.find((l) => l.startsWith(`${i}.`))!.slice(4, 14);
  const find = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => Number(l.split(".")[0]));
  const weddings = find(/wedding/i)
    .filter((i) => !/ROLLUP/.test(lines.find((l) => l.startsWith(`${i}.`))!))
    .sort((a, b) => date(a).localeCompare(date(b)));
  const rollup = find(/ROLLUP/);
  // The person's own wording is the one to keep.
  const tea = find(/green tea/).sort((a, b) => Number(/user_explicit/.test(lines[b]!)) - Number(/user_explicit/.test(lines[a]!)));
  // Dates of the weddings, with those an earlier rollup lists.
  const listed = (ws: number[], rs: number[]) =>
    [...new Set([...ws.map(date), ...rs.flatMap((i) => [...lines.find((l) => l.startsWith(`${i}.`))!.slice(30).matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]))])].sort();
  const job = find(/works as a nurse|new job as a nurse/).sort((a, b) => date(a).localeCompare(date(b)));
  const fragment = find(/it cost 450/);
  return JSON.stringify({
    rewrite: fragment.map((i) => ({ note: i, text: "The garden wedding of Emily and Sarah cost 450 dollars." })),
    merge: tea.length === 2 ? [{ keep: tea[0], drop: [tea[1]] }] : [],
    supersede: job.length === 2 ? [{ old: job[0], new: job[1] }] : [],
    rollups:
      weddings.length + rollup.length >= 2 && weddings.length
        ? [{ members: [...weddings, ...rollup], text: "Weddings attended:\n" + listed(weddings, rollup).map((d) => `- ${d}`).join("\n") }]
        : [],
  });
}

describe("dreaming in the MemoryObject", () => {
  let mo: MemoryObject;
  let fake: ReturnType<typeof fakeEnv>;
  let db: ReturnType<typeof fakeState>["db"];
  const make = (env: Record<string, string> = {}) => {
    const s = fakeState();
    db = s.db;
    fake = fakeEnv(generate);
    mo = new MemoryObject(s.state as never, { ...fake.env, ...env } as never);
  };
  const settle = async () => {
    for (let i = 0; i < 30; i++) {
      now += 5_000;
      await mo.alarm();
    }
  };
  const add = (content: string, t: string, trust: "user_explicit" | "agent_inference" = "user_explicit") =>
    mo.addNote(claude, { scope: "profile", content, kind: "fact", trust, tEvent: day(t) });
  const active = () => db.prepare("SELECT content FROM items WHERE kind = 'note' AND status = 'active' ORDER BY content").all().map((r) => (r as { content: string }).content);

  beforeEach(async () => {
    dreamInputs = [];
    make();
    await add("The user attended the wedding of Rachel and Mike in the garden.", "2023-03-12");
    await add("The user attended the wedding of Emily and Sarah in the garden.", "2023-06-03");
    await add("The user attended the wedding of cousin Jenna in the garden.", "2023-10-14");
    await add("The user drinks green tea every single morning at home.", "2023-02-01");
    await add("The user drinks green tea every morning at home, always.", "2023-05-01", "agent_inference");
    await add("The user works as a nurse at the hospital in town.", "2023-01-10");
    await add("The user started a new job as a nurse at the clinic in town.", "2023-08-01");
    await settle();
  });

  it("walks all notes after a replayed reflection: merges, replaces, rolls up, audits", async () => {
    await mo.requestReflection(claude, day("2023-11-01"));
    await settle();
    expect(dreamInputs.length).toBeGreaterThan(0);
    const all = active();
    expect(all.filter((c) => c.includes("green tea"))).toHaveLength(1);
    expect(all.some((c) => c.includes("works as a nurse"))).toBe(false);
    const rollups = db.prepare("SELECT id, content, origin, client_id, t_event FROM items WHERE status = 'active' AND origin = 'reflection'").all() as Record<string, unknown>[];
    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({ origin: "reflection", client_id: "system:dreaming", t_event: day("2023-10-14") });
    expect(String(rollups[0]!.content)).toBe("Weddings attended:\n- 2023-03-12\n- 2023-06-03\n- 2023-10-14");
    expect(db.prepare("SELECT COUNT(*) AS n FROM links WHERE src = ? AND kind = 'rolls_up'").get(rollups[0]!.id as string)).toEqual({ n: 3 });
    const actions = (db.prepare("SELECT action FROM audit WHERE client_id = 'system:dreaming'").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["dream", "dream.merge", "dream.supersede", "dream.rollup"]));
    // The pass is done and the rollup reached the outbox and the index.
    expect(mo.stats(claude).pendingJobs).toBe(0);
    expect(fake.vectors.has(String(rollups[0]!.id))).toBe(true);
    // A second pass over the tidied memory rewrites the rollup instead of adding a second one.
    await add("The user attended the wedding of Tom and Ana in the garden.", "2023-10-20");
    await settle();
    await mo.requestReflection(claude, day("2023-11-02"));
    await settle();
    const after = db.prepare("SELECT content FROM items WHERE status = 'active' AND origin = 'reflection'").all() as { content: string }[];
    expect(after).toHaveLength(1);
    expect(after[0]!.content.split("\n")).toHaveLength(5);
  });

  it("logs rewrites by id only, so forget leaves no memory text behind", async () => {
    await add("it cost 450 dollars, the wedding in the garden", "2023-06-03", "agent_inference");
    await settle();
    await mo.requestReflection(claude, day("2023-11-01"));
    await settle();
    const row = db.prepare("SELECT id FROM items WHERE content LIKE 'The garden wedding of Emily%'").get() as { id: string };
    expect(row).toBeTruthy();
    await mo.forget(claude, row.id);
    const log = (db.prepare("SELECT detail FROM audit").all() as { detail: string | null }[]).map((r) => r.detail ?? "").join("\n");
    expect(log).not.toMatch(/it cost 450|garden wedding of Emily|450 dollars/);
  });

  it("discards a group's proposals when one of its notes is forgotten during the model call", async () => {
    const rachel = db.prepare("SELECT id FROM items WHERE content LIKE '%Rachel%'").get() as { id: string };
    duringCall = () => {
      // What forget does to the row, while the model call is in flight.
      db.prepare("DELETE FROM items WHERE id = ?").run(rachel.id);
    };
    await mo.requestReflection(claude, day("2023-11-01"));
    await settle();
    const rollups = db.prepare("SELECT content FROM items WHERE origin = 'reflection'").all() as { content: string }[];
    expect(rollups.every((r) => !r.content.includes("2023-03-12"))).toBe(true);
    expect((db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'dream.discarded'").get() as { n: number }).n).toBeGreaterThan(0);
  });

  it("keeps a rollup of another category that shares only one note", async () => {
    const rachel = db.prepare("SELECT id FROM items WHERE content LIKE '%Rachel%'").get() as { id: string };
    db.prepare(
      `INSERT INTO items (id, kind, scope, content, note_kind, trust, client_id, agent, provider, t_event, created_at, origin)
       VALUES ('trips', 'note', 'profile', 'Trips:\n- Rachel and Mike wedding trip (2023-03-12)\n- Lisbon (2022-01-01)', 'fact', 'agent_inference', 'system:dreaming', 'rhizome', 'dreaming', 0, 0, 'reflection')`,
    ).run();
    db.prepare("INSERT INTO links (src, dst, kind, weight, created_at) VALUES ('trips', ?, 'rolls_up', 1, 0), ('trips', 'lisbon', 'rolls_up', 1, 0)").run(rachel.id);
    await mo.requestReflection(claude, day("2023-11-01"));
    await settle();
    expect(db.prepare("SELECT status FROM items WHERE id = 'trips'").get()).toEqual({ status: "active" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE origin = 'reflection' AND status = 'active' AND content LIKE 'Weddings%'").get()).toEqual({ n: 1 });
  });

  it("forgetting a note deletes the rollups that list it", async () => {
    await mo.requestReflection(claude, day("2023-11-01"));
    await settle();
    const rollup = db.prepare("SELECT id FROM items WHERE origin = 'reflection'").get() as { id: string };
    const member = db.prepare("SELECT dst FROM links WHERE src = ? AND kind = 'rolls_up' LIMIT 1").get(rollup.id) as { dst: string };
    const listing = (db.prepare("SELECT src FROM links WHERE dst = ? AND kind = 'rolls_up'").all(member.dst) as { src: string }[]).map((r) => r.src);
    await mo.forget(claude, member.dst);
    // Every rollup that listed the note is gone with its links; rollups that never listed it may stay.
    for (const id of listing) {
      expect(db.prepare("SELECT COUNT(*) AS n FROM items WHERE id = ?").get(id)).toEqual({ n: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM links WHERE src = ? OR dst = ?").get(id, id)).toEqual({ n: 0 });
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM links WHERE dst = ? AND kind = 'rolls_up'").get(member.dst)).toEqual({ n: 0 });
  });

  it("waits until the person has been away, then dreams on its own", async () => {
    // beforeEach's writes are under ten minutes old: nothing yet.
    expect(dreamInputs).toHaveLength(0);
    now += DREAM_IDLE_MS;
    await settle();
    expect(dreamInputs.length).toBeGreaterThan(0);
    // The pass is done and nothing new came in: no second pass.
    const calls = dreamInputs.length;
    now += 3 * DREAM_IDLE_MS;
    await settle();
    expect(dreamInputs).toHaveLength(calls);
  });

  it("stops at the daily budget and goes on from there the next day", async () => {
    make({ DREAM_DAILY_LIMIT: "1" });
    for (const [c, t] of [
      ["The user attended the wedding of Rachel and Mike in the garden.", "2023-03-12"],
      ["The user attended the wedding of Emily and Sarah in the garden.", "2023-06-03"],
      ["Python scripts rotate server logs.", "2023-01-10"],
      ["Python scripts rotate server logs weekly via cron.", "2023-08-01"],
    ] as const) await add(c, t);
    await settle();
    await mo.requestReflection(claude, day("2023-11-01"));
    await settle();
    expect(dreamInputs).toHaveLength(1);
    now += 86_400_000;
    await mo.requestReflection(claude, day("2023-11-02"));
    await settle();
    expect(dreamInputs).toHaveLength(2);
  });

  it("does nothing when DREAMING is off", async () => {
    make({ DREAMING: "off" });
    await add("The user attended the wedding of Rachel and Mike in the garden.", "2023-03-12");
    await add("The user attended the wedding of Emily and Sarah in the garden.", "2023-06-03");
    await settle();
    await mo.requestReflection(claude, day("2023-11-01"));
    now += 2 * DREAM_IDLE_MS;
    await settle();
    expect(dreamInputs).toHaveLength(0);
  });
});
