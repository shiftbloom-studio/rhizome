import { describe, expect, it } from "vitest";
import { chunk, estimateTokens, ftsQuery, rrf, transcript } from "../src/text";

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
