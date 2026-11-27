import { describe, expect, it } from "vitest";
import { byCodeUnit, chunk, estimateTokens, ftsQuery, roundChunks, rrf, transcript, trimChars, trimEndChars } from "../src/text";

describe("chunk", () => {
  it("keeps short text in one chunk", () => {
    expect(chunk("hello world")).toEqual(["hello world"]);
  });
  it("returns nothing for blank text", () => {
    expect(chunk("   ")).toEqual([]);
  });
  it("splits long text with overlap and bounded size", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Sentence number ${i} talks about memory.`).join(" ");
    const parts = chunk(text, 300, 50);
    expect(parts.length).toBeGreaterThan(5);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(300);
    expect(parts.join(" ")).toContain("Sentence number 79");
  });
});

describe("ftsQuery", () => {
  it("quotes terms, ORs them and prefixes the last", () => {
    expect(ftsQuery("Which license?")).toBe('"which" OR "license"*');
  });
  it("strips FTS syntax so user input cannot break the query", () => {
    expect(ftsQuery('a "b" OR c* NEAR(d)')).toBe('"or" OR "near"*');
  });
  it("handles umlauts", () => {
    expect(ftsQuery("Lizenz für Projekte")).toBe('"lizenz" OR "für" OR "projekte"*');
  });
  it("returns null without searchable words", () => {
    expect(ftsQuery("? !")).toBeNull();
  });
});

describe("rrf", () => {
  it("rewards ids that rank high in several lists", () => {
    const s = rrf([["a", "b", "c"], ["b", "a"], ["b"]]);
    expect([...s.entries()].sort((x, y) => y[1] - x[1])[0]![0]).toBe("b");
  });
});

describe("misc", () => {
  it("estimates tokens", () => expect(estimateTokens("12345678")).toBe(2));
  it("flattens a transcript", () =>
    expect(transcript([{ role: "user", content: "hi" }, { role: "assistant", content: "hey" }])).toBe("[user] hi\n[assistant] hey"));
});

describe("roundChunks", () => {
  const m = (role: string, content: string) => ({ role, content });
  it("keeps each question with its answer", () => {
    const long = (s: string) => s.repeat(40);
    const out = roundChunks([m("user", long("Which license? ")), m("assistant", long("AGPL. ")), m("user", long("And the runtime? ")), m("assistant", long("Node 26. "))]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatch(/^\[user\] Which license\?/);
    expect(out[0]).toContain("[assistant] AGPL.");
    expect(out[1]).toMatch(/^\[user\] And the runtime\?/);
  });
  it("joins short rounds and cuts long ones", () => {
    expect(roundChunks([m("user", "hi"), m("assistant", "hello"), m("user", "thanks"), m("assistant", "sure")])).toEqual([
      "[user] hi\n[assistant] hello\n[user] thanks\n[assistant] sure",
    ]);
    const out = roundChunks([m("user", "word ".repeat(600)), m("assistant", "ok")]);
    expect(out.length).toBeGreaterThan(2);
    expect(out.every((c) => c.length <= 1200)).toBe(true);
  });
  it("treats several user messages in a row as one round", () => {
    expect(roundChunks([m("user", "a"), m("user", "b"), m("assistant", "c")])).toEqual(["[user] a\n[user] b\n[assistant] c"]);
  });
});

describe("trimChars", () => {
  it("strips the given characters from both ends only", () => {
    expect(trimChars("--a-b--", "-")).toBe("a-b");
    expect(trimChars("----", "-")).toBe("");
    expect(trimEndChars("C:\\work\\rhizome\\//", "\\/")).toBe("C:\\work\\rhizome");
  });
  it("stays fast on long runs", () => {
    const long = `${"-".repeat(100_000)}x${"-".repeat(100_000)}`;
    expect(trimChars(long, "-")).toBe("x");
  });
});

describe("byCodeUnit", () => {
  it("sorts like a plain sort", () => {
    const list = ["b", "B", "a", "ä", "10", "9", "A"];
    expect([...list].sort(byCodeUnit)).toEqual([...list].sort());
  });
});
