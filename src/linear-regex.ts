// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A regex matcher whose run time grows linearly with the text: the pattern is
// compiled to a small program and run as a Pike VM (all paths in step, one pass
// over the text), so no pattern can backtrack for a long time. Standing orders
// (orders.ts) use it, because a check runs inside the person's memory and the
// built-in RegExp can take minutes on patterns like (a|a)*$ or \s*\s*\s*x$.
//
// It speaks the subset of JavaScript regex syntax that needs no backtracking:
// literals, ., character classes, \d \w \s and their negations, \b \B, ^ $,
// groups ((...), (?:...), (?<name>...)), |, and the quantifiers * + ? {n} {n,} {n,m}
// (lazy forms too: for a yes/no test they match the same). No backreferences,
// no lookarounds. Flags: i, m, s. Code units, like RegExp without the u flag.

type Test = (c: number) => boolean;
type Node =
  | { t: "char"; test: Test }
  | { t: "seq"; items: Node[] }
  | { t: "alt"; items: Node[] }
  | { t: "rep"; node: Node; min: number; max: number }
  | { t: "assert"; kind: "^" | "$" | "b" | "B" };

type Inst =
  | { op: "char"; test: Test }
  | { op: "split"; x: number; y: number }
  | { op: "jmp"; x: number }
  | { op: "assert"; kind: "^" | "$" | "b" | "B" }
  | { op: "match" };

/** Largest program a pattern may compile to (counted repeats such as {1,50} copy their body). */
export const MAX_PROGRAM = 1000;
const MAX_COUNT = 100;

export class PatternError extends Error {}

const isDigit: Test = (c) => c >= 48 && c <= 57;
const isWord: Test = (c) => isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isSpace: Test = (c) =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
const isLineEnd: Test = (c) => c === 10 || c === 13 || c === 0x2028 || c === 0x2029;
const not = (f: Test): Test => (c) => !f(c);

function folded(test: Test): Test {
  return (c) => {
    if (test(c)) return true;
    const s = String.fromCharCode(c);
    const lo = s.toLowerCase();
    const up = s.toUpperCase();
    return (lo.length === 1 && test(lo.charCodeAt(0))) || (up.length === 1 && test(up.charCodeAt(0)));
  };
}

class Parser {
  private i = 0;
  /** The character the last escape stands for, when it is a single one. */
  private lastCode: number | undefined;
  constructor(private src: string, private flags: { i: boolean; s: boolean }) {}

  parse(): Node {
    const node = this.alt();
    if (this.i < this.src.length) throw new PatternError(this.src[this.i] === ")" ? "unmatched )" : "invalid regular expression");
    return node;
  }

  private peek(): string | undefined {
    return this.src[this.i];
  }

  private alt(): Node {
    const items = [this.seq()];
    while (this.peek() === "|") {
      this.i++;
      items.push(this.seq());
    }
    return items.length === 1 ? items[0]! : { t: "alt", items };
  }

  private seq(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.peek() !== "|" && this.peek() !== ")") {
      const atom = this.atom();
      items.push(this.quantified(atom));
    }
    return { t: "seq", items };
  }

  private quantified(atom: Node): Node {
    const q = this.quantifier();
    if (!q) return atom;
    if (atom.t === "assert") throw new PatternError("an anchor or \\b cannot be repeated");
    if (this.peek() === "?") this.i++; // lazy: same yes/no answer
    if (this.quantifierAhead()) throw new PatternError("nothing to repeat");
    return { t: "rep", node: atom, min: q.min, max: q.max };
  }

  private quantifierAhead(): boolean {
    const c = this.peek();
    if (c === "*" || c === "+" || c === "?") return true;
    return c === "{" && /^\{\d+(,\d*)?\}/.test(this.src.slice(this.i));
  }

  private quantifier(): { min: number; max: number } | null {
    const c = this.peek();
    if (c === "*") return this.i++, { min: 0, max: Infinity };
    if (c === "+") return this.i++, { min: 1, max: Infinity };
    if (c === "?") return this.i++, { min: 0, max: 1 };
    if (c !== "{") return null;
    const m = /^\{(\d+)(,(\d*))?\}/.exec(this.src.slice(this.i));
    if (!m) return null; // a literal {, as in RegExp without the u flag
    this.i += m[0].length;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
    if (min > MAX_COUNT || (max !== Infinity && max > MAX_COUNT)) throw new PatternError(`counted repeats go up to ${MAX_COUNT}`);
    if (max < min) throw new PatternError("numbers out of order in {} quantifier");
    return { min, max };
  }

  private lit(test: Test): Node {
    return { t: "char", test: this.flags.i ? folded(test) : test };
  }

  private atom(): Node {
    const c = this.src[this.i++]!;
    switch (c) {
      case "(": {
        if (this.src.startsWith("?:", this.i)) this.i += 2;
        else if (this.src.startsWith("?<", this.i) && !/^\?<[=!]/.test(this.src.slice(this.i))) {
          const m = /^\?<[A-Za-z_$][\w$]*>/.exec(this.src.slice(this.i));
          if (!m) throw new PatternError("invalid group name");
          this.i += m[0].length;
        } else if (this.peek() === "?") throw new PatternError("lookarounds are not allowed");
        const inner = this.alt();
        if (this.peek() !== ")") throw new PatternError("unterminated group");
        this.i++;
        return inner;
      }
      case ")":
        throw new PatternError("unmatched )");
      case "[":
        return this.cls();
      case ".":
        return { t: "char", test: this.flags.s ? () => true : not(isLineEnd) };
      case "^":
        return { t: "assert", kind: "^" };
      case "$":
        return { t: "assert", kind: "$" };
      case "*":
      case "+":
      case "?":
        throw new PatternError("nothing to repeat");
      case "{":
        if (/^\d+(,\d*)?\}/.test(this.src.slice(this.i))) throw new PatternError("nothing to repeat");
        return this.lit((x) => x === 123);
      case "\\":
        return this.escape(false) as Node;
      default: {
        const code = c.charCodeAt(0);
        return this.lit((x) => x === code);
      }
    }
  }

  /** An escape after the backslash. In a class, returns a Test; outside, a Node. */
  private escape(inClass: boolean): Node | Test {
    const c = this.src[this.i++];
    this.lastCode = undefined;
    if (c === undefined) throw new PatternError("\\ at end of pattern");
    const wrap = (t: Test): Node | Test => (inClass ? t : { t: "char", test: t });
    switch (c) {
      case "d": return wrap(isDigit);
      case "D": return wrap(not(isDigit));
      case "w": return wrap(isWord);
      case "W": return wrap(not(isWord));
      case "s": return wrap(isSpace);
      case "S": return wrap(not(isSpace));
      case "b":
        if (!inClass) return { t: "assert", kind: "b" };
        this.lastCode = 8;
        return (x: number) => x === 8;
      case "B":
        if (inClass) throw new PatternError("\\B in a character class");
        return { t: "assert", kind: "B" };
      case "k":
        throw new PatternError("backreferences are not allowed");
    }
    if (/[1-9]/.test(c)) throw new PatternError("backreferences are not allowed");
    let code: number;
    if (c === "n") code = 10;
    else if (c === "r") code = 13;
    else if (c === "t") code = 9;
    else if (c === "f") code = 12;
    else if (c === "v") code = 11;
    else if (c === "0") {
      if (/[0-9]/.test(this.peek() ?? "")) throw new PatternError("octal escapes are not allowed");
      code = 0;
    } else if (c === "x" || c === "u") {
      const len = c === "x" ? 2 : 4;
      const hex = this.src.slice(this.i, this.i + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new PatternError(`\\${c} needs ${len} hex digits`);
      this.i += len;
      code = parseInt(hex, 16);
    } else if (/[A-Za-z]/.test(c)) throw new PatternError(`unknown escape \\${c}`);
    else code = c.charCodeAt(0);
    const t: Test = (x) => x === code;
    this.lastCode = code;
    if (inClass) return t;
    return this.lit(t);
  }

  private classAtom(): { test: Test; code?: number } {
    const c = this.src[this.i++];
    if (c === undefined) throw new PatternError("unterminated character class");
    if (c !== "\\") return { test: (x) => x === c.charCodeAt(0), code: c.charCodeAt(0) };
    const t = this.escape(true) as Test;
    // A single character (not \d, \w, \s and their negations) can start or end a range.
    return { test: t, code: this.lastCode };
  }

  private cls(): Node {
    let negate = false;
    if (this.peek() === "^") {
      negate = true;
      this.i++;
    }
    const parts: Test[] = [];
    while (this.peek() !== "]") {
      if (this.i >= this.src.length) throw new PatternError("unterminated character class");
      const a = this.classAtom();
      if (this.peek() === "-" && this.src[this.i + 1] !== "]" && this.i + 1 < this.src.length) {
        this.i++;
        const b = this.classAtom();
        if (a.code === undefined || b.code === undefined) throw new PatternError("invalid character class range");
        if (b.code < a.code) throw new PatternError("range out of order in character class");
        const lo = a.code;
        const hi = b.code;
        parts.push((x) => x >= lo && x <= hi);
      } else parts.push(a.test);
    }
    this.i++;
    const any: Test = (x) => parts.some((p) => p(x));
    const test = this.flags.i ? folded(any) : any;
    return { t: "char", test: negate ? not(test) : test };
  }
}

function compile(node: Node, prog: Inst[]): void {
  if (prog.length > MAX_PROGRAM) throw new PatternError("pattern is too large");
  switch (node.t) {
    case "char":
      prog.push({ op: "char", test: node.test });
      return;
    case "assert":
      prog.push({ op: "assert", kind: node.kind });
      return;
    case "seq":
      for (const n of node.items) compile(n, prog);
      return;
    case "alt": {
      const jumps: Inst[] = [];
      for (let k = 0; k < node.items.length; k++) {
        if (k < node.items.length - 1) {
          const split: Inst = { op: "split", x: prog.length + 1, y: 0 };
          prog.push(split);
          compile(node.items[k]!, prog);
          const jmp: Inst = { op: "jmp", x: 0 };
          prog.push(jmp);
          jumps.push(jmp);
          split.y = prog.length;
        } else compile(node.items[k]!, prog);
      }
      for (const j of jumps) (j as { x: number }).x = prog.length;
      return;
    }
    case "rep": {
      for (let k = 0; k < node.min; k++) compile(node.node, prog);
      if (node.max === Infinity) {
        const split: Inst = { op: "split", x: prog.length + 1, y: 0 };
        const at = prog.length;
        prog.push(split);
        compile(node.node, prog);
        prog.push({ op: "jmp", x: at });
        split.y = prog.length;
      } else {
        const splits: Inst[] = [];
        for (let k = node.min; k < node.max; k++) {
          const split: Inst = { op: "split", x: prog.length + 1, y: 0 };
          prog.push(split);
          splits.push(split);
          compile(node.node, prog);
        }
        for (const s of splits) (s as { y: number }).y = prog.length;
      }
      if (prog.length > MAX_PROGRAM) throw new PatternError("pattern is too large");
      return;
    }
  }
}

/** Work left for a batch of tests, in steps (one step: one path at one character). */
export interface Budget {
  left: number;
}

/** Thrown by test() when the budget runs out. */
export class BudgetError extends Error {}

export interface LinearRegex {
  /** Whether the pattern matches somewhere in the text. With a budget, throws BudgetError once it is spent. */
  test(text: string, budget?: Budget): boolean;
}

/** Compiles a pattern; throws PatternError for anything outside the supported subset. */
export function linearRegex(source: string, flags = ""): LinearRegex {
  const f = { i: flags.includes("i"), m: flags.includes("m"), s: flags.includes("s") };
  const prog: Inst[] = [];
  compile(new Parser(source, f).parse(), prog);
  prog.push({ op: "match" });
  const n = prog.length;
  return {
    test(text: string, budget?: Budget): boolean {
      const len = text.length;
      const mark = new Int32Array(n).fill(-1);
      let cur: number[] = [];
      let next: number[] = [];
      const wordAt = (p: number) => p >= 0 && p < len && isWord(text.charCodeAt(p));
      // Adds pc and everything reachable from it without reading a character. Returns true on a match.
      const add = (list: number[], start: number, pos: number, stamp: number): boolean => {
        const stack = [start];
        while (stack.length) {
          const pc = stack.pop()!;
          if (mark[pc] === stamp) continue;
          mark[pc] = stamp;
          const inst = prog[pc]!;
          switch (inst.op) {
            case "match":
              return true;
            case "jmp":
              stack.push(inst.x);
              break;
            case "split":
              stack.push(inst.y, inst.x);
              break;
            case "assert": {
              let ok: boolean;
              if (inst.kind === "^") ok = pos === 0 || (f.m && isLineEnd(text.charCodeAt(pos - 1)));
              else if (inst.kind === "$") ok = pos === len || (f.m && isLineEnd(text.charCodeAt(pos)));
              else ok = (wordAt(pos - 1) !== wordAt(pos)) === (inst.kind === "b");
              if (ok) stack.push(pc + 1);
              break;
            }
            case "char":
              list.push(pc);
              break;
          }
        }
        return false;
      };
      for (let pos = 0; pos <= len; pos++) {
        // A new attempt starts at every position (an unanchored search).
        if (add(cur, 0, pos, pos)) return true;
        if (pos === len) break;
        if (budget && (budget.left -= cur.length + 1) < 0) throw new BudgetError("the check ran out of time");
        const c = text.charCodeAt(pos);
        next.length = 0;
        for (const pc of cur) {
          const inst = prog[pc] as { op: "char"; test: Test };
          if (inst.test(c) && add(next, pc + 1, pos + 1, pos + 1)) return true;
        }
        [cur, next] = [next, cur];
      }
      return false;
    },
  };
}
