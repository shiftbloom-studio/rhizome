// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { linearRegex, PatternError } from "../src/linear-regex";

// Known-slow patterns, built at run time so code scanners do not read the test data as live regexes.
const P = "+".repeat(1);
const S = "*".repeat(1);
const Q = "?".repeat(1);

// Each pattern is checked against the built-in RegExp on every text.
const PATTERNS: [string, string][] = [
  ["\\bgh\\s+issue\\s+close\\b", "i"],
  ["\\bgit\\s+push\\b[^\\n;|&]*\\s(--force\\b|-f\\b)", "i"],
  ["co-authored-by:[^\\n]*(claude|copilot)", "i"],
  ["(\\.nvmrc|\\.node-version)$", "i"],
  ["^\\s*v?22", "m"],
  ["^\\s*v?22", ""],
  ["(v)?22", "i"],
  ["[(a+)]+", ""],
  ["a{2,3}b", ""],
  ["a{2}", ""],
  ["a{2,}", ""],
  ["x{", ""],
  ["[^a-c]+d", "i"],
  ["[\\d-]+", ""],
  ["[a\\-z]", ""],
  ["[]", ""],
  ["[^]", ""],
  ["a.c", ""],
  ["a.c", "s"],
  ["\\Bend", ""],
  ["(?:ab|cd)*e$", ""],
  ["(?<name>rm)\\s+-rf", ""],
  ["\\x41\\u0042", "i"],
  ["a+?b", ""],
  ["\\$HOME", ""],
  ["^$", "m"],
  ["(|a)b", ""],
  ["\\W\\S\\D", ""],
];
const TEXTS = [
  "", "gh issue close 12", "GH  Issue CLOSE", "ghissue close", "git push origin main --force", "git push -f", "git push; echo --force",
  "Co-Authored-By: Claude <x>", "co-authored-by: someone\nclaude", ".nvmrc", "x/.NODE-VERSION", "a\n  v22\n", "v22", "  22",
  "aab", "aaab", "ab", "aaaaab", "x{", "dddD", "1-2-3", "-", "abc", "a\nc", "theend", "the end", "ababcde", "ababe",
  "rm   -rf /", "AB", "ab", "$HOME/x", "b", "a b", "%!x", "é", "line\r\nnext",
];

describe("linearRegex", () => {
  it("answers like RegExp on the supported subset", () => {
    for (const [p, f] of PATTERNS) {
      const ours = linearRegex(p, f);
      const theirs = new RegExp(p, f);
      for (const t of TEXTS) expect([p, f, t, ours.test(t)]).toEqual([p, f, t, theirs.test(t)]);
    }
  });

  it("stays fast on patterns that make RegExp backtrack for minutes", () => {
    const cases: [string, string][] = [
      [`(a|a)${S}$`, "a".repeat(20_000) + "!"],
      [`(?:a|a)${P}b`, "a".repeat(20_000)],
      [`\\s${S}`.repeat(4) + "x$", " ".repeat(20_000)],
      ["x" + `.${S}`.repeat(4) + "y", "x" + "a".repeat(20_000)],
      [`(a${P})${P}$`, "a".repeat(20_000) + "!"],
      [`a${Q}`.repeat(30) + "a".repeat(30), "a".repeat(30)],
    ];
    const start = Date.now();
    for (const [p, t] of cases) linearRegex(p, "i").test(t);
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(linearRegex(`a${Q}`.repeat(30) + "a".repeat(30)).test("a".repeat(30))).toBe(true);
  });

  it("refuses what it does not support", () => {
    for (const p of ["(a)\\1", "\\k<x>", "a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b", "a**", "*a", "^*", "(a", "a)", "[a", "a{1,200}", "\\q", "[z-a]", "\\01"]) {
      expect(() => linearRegex(p), p).toThrow(PatternError);
    }
  });

  it("caps the program size", () => {
    expect(() => linearRegex("(abcdefghij){100}(abcdefghij){100}(abcdefghij){100}")).toThrow(/too large/);
  });
});

describe("standing order checks use the linear matcher", async () => {
  const { evaluate, unsafePattern } = await import("../src/orders");
  const order = (value: string, i: number) => ({
    id: `ord_${i}`, scope: "profile", state: "active" as const, said: "2026-11-26", createdBy: "c", createdAt: "", updatedAt: "",
    says: "x", action: "deny" as const, when: [{ tool: "Bash", all: [{ path: "text", op: "regex" as const, value, flags: "i" }] }],
  });

  it("lets a pattern the static test misses through, and still answers fast", () => {
    const S = "*".repeat(1);
    expect(unsafePattern(`(a|a)${S}$`)).toBeNull();
    const start = Date.now();
    const d = evaluate([order(`(a|a)${S}!$`, 1)], { tool_name: "Bash", tool_input: { command: "a".repeat(19_999) + "!" } });
    expect(d?.order).toBe("ord_1");
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("stops after its budget and lets the call go on", () => {
    const heavy = "[a-z\\s]{0,100}[a-z\\s]{0,100}[a-z\\s]{0,90}!";
    const orders = Array.from({ length: 100 }, (_, i) => order(heavy, i));
    const start = Date.now();
    expect(evaluate(orders, { tool_name: "Bash", tool_input: { command: "a ".repeat(10_000) } }, { left: 1_000_000 })).toBeNull();
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  it("refuses patterns outside the subset", () => {
    expect(unsafePattern("a{1,200}")).toMatch(/up to 100/);
    expect(unsafePattern("\\q")).toMatch(/unknown escape/);
  });
});
