// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Retrieval scores for one question and for a whole run, without an LLM.
//
// Session level, as in LongMemEval: the recalled items are turned into a
// ranking of unique sessions (first appearance wins) and scored against the
// evidence sessions: recall_any@k (one of them in the first k), recall_all@k
// (all of them) and ndcg_any@k.
// Turn level: the share of evidence turns that the first k items cover.
// Delivered: the same scores for what a default recall hands an agent
// (limit 10, 2,000-token budget), which is what an answer gets built from.

export const SESSION_KS = [1, 3, 5, 10] as const;
export const TURN_KS = [5, 10] as const;

/** One recalled item, reduced to the sessions and evidence turns it stands for. */
export interface ItemRef {
  sessions: string[];
  /** `${sessionId}#${turnIndex}` of the turns the item covers. */
  turns: string[];
}

export interface Evidence {
  sessions: Set<string>;
  turns: Set<string>;
}

/** Unique sessions in the order they first appear. */
export function sessionOrder(items: ItemRef[]): string[] {
  const seen = new Set<string>();
  for (const item of items) for (const s of item.sessions) seen.add(s);
  return [...seen];
}

/** DCG weight per 1-based rank, as in LongMemEval's eval_utils.py: 1 for ranks 1 and 2, then 1/log2(rank). */
function weight(rank: number): number {
  return rank <= 2 ? 1 : 1 / Math.log2(rank);
}

export function rankingScores(order: string[], evidence: Set<string>, k: number): { any: number; all: number; ndcg: number } {
  const top = order.slice(0, k);
  const hits = top.map((s) => (evidence.has(s) ? 1 : 0));
  const any = hits.some(Boolean) ? 1 : 0;
  const all = evidence.size > 0 && [...evidence].every((e) => top.includes(e)) ? 1 : 0;
  let dcg = 0;
  hits.forEach((h, i) => (dcg += h * weight(i + 1)));
  let ideal = 0;
  for (let i = 0; i < Math.min(k, evidence.size); i++) ideal += weight(i + 1);
  return { any, all, ndcg: ideal > 0 ? dcg / ideal : 0 };
}

/** Share of the evidence turns covered by the first k items, or undefined without evidence turns. */
export function turnCoverage(items: ItemRef[], turns: Set<string>, k = items.length): number | undefined {
  if (turns.size === 0) return undefined;
  const covered = new Set<string>();
  for (const item of items.slice(0, k)) for (const t of item.turns) if (turns.has(t)) covered.add(t);
  return covered.size / turns.size;
}

/** All scores of one question: the deep ranking (recall with limit 50) and what a default recall delivered. */
export function scoreQuestion(ranked: ItemRef[], delivered: ItemRef[], evidence: Evidence): Record<string, number> {
  const out: Record<string, number> = {};
  const order = sessionOrder(ranked);
  for (const k of SESSION_KS) {
    const s = rankingScores(order, evidence.sessions, k);
    out[`recall_any@${k}`] = s.any;
    out[`recall_all@${k}`] = s.all;
    out[`ndcg_any@${k}`] = s.ndcg;
  }
  for (const k of TURN_KS) {
    const t = turnCoverage(ranked, evidence.turns, k);
    if (t !== undefined) out[`turn_recall@${k}`] = t;
  }
  const got = new Set(sessionOrder(delivered));
  out.delivered_any = [...evidence.sessions].some((s) => got.has(s)) ? 1 : 0;
  out.delivered_all = evidence.sessions.size > 0 && [...evidence.sessions].every((s) => got.has(s)) ? 1 : 0;
  const t = turnCoverage(delivered, evidence.turns);
  if (t !== undefined) out.delivered_turns = t;
  return out;
}

/** One line of results.jsonl. */
export interface ResultRecord {
  id: string;
  type: string;
  abstention: boolean;
  /** Scores, for questions whose evidence sessions are in the history. Abstention questions have none. */
  metrics?: Record<string, number>;
  /** Set when the abstain recall step ran: true when the default recall returned nothing on purpose. */
  abstained?: boolean;
  sessions?: number;
  chunks?: number;
  notes?: number;
  ingestMs?: number;
  recallMs?: number;
  /** Items and estimated tokens a default recall returned (also in metrics, for scored questions). */
  deliveredItems?: number;
  deliveredTokens?: number;
  /** Confidence of the first delivered item, when recall reports one. */
  confidence?: number;
  /** The first ten sessions of the deep ranking. */
  top?: string[];
  error?: string;
}

/** The last record per question id wins, so a rerun of a failed question replaces it. */
export function latestRecords(records: ResultRecord[]): ResultRecord[] {
  const byId = new Map<string, ResultRecord>();
  for (const r of records) byId.set(r.id, r);
  return [...byId.values()];
}

function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN;
}

function median(values: number[]): number {
  if (!values.length) return Number.NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function averages(records: ResultRecord[]): Record<string, number> {
  const values = new Map<string, number[]>();
  for (const r of records) for (const [k, v] of Object.entries(r.metrics ?? {})) values.set(k, [...(values.get(k) ?? []), v]);
  return Object.fromEntries([...values.entries()].map(([k, v]) => [k, mean(v)]));
}

export interface Summary {
  /** Questions with a result, failed ones not included. */
  questions: number;
  failed: number;
  /** Questions that count for the retrieval scores. */
  scored: number;
  overall: Record<string, number>;
  byType: Record<string, { n: number; metrics: Record<string, number> }>;
  /** Only when the abstain step ran: how often recall returned nothing, on abstention and on answerable questions. */
  abstention?: { questions: number; abstained: number; answerable: number; abstainedOnAnswerable: number };
  timing: { ingestMsMedian: number; recallMsMedian: number };
}

export function summarize(all: ResultRecord[]): Summary {
  const records = latestRecords(all);
  const ok = records.filter((r) => !r.error);
  const scored = ok.filter((r) => r.metrics);
  const byType: Summary["byType"] = {};
  for (const type of [...new Set(scored.map((r) => r.type))].sort()) {
    const rs = scored.filter((r) => r.type === type);
    byType[type] = { n: rs.length, metrics: averages(rs) };
  }
  const summary: Summary = {
    questions: ok.length,
    failed: records.length - ok.length,
    scored: scored.length,
    overall: averages(scored),
    byType,
    timing: {
      ingestMsMedian: median(ok.flatMap((r) => (r.ingestMs === undefined ? [] : [r.ingestMs]))),
      recallMsMedian: median(ok.flatMap((r) => (r.recallMs === undefined ? [] : [r.recallMs]))),
    },
  };
  if (ok.some((r) => r.abstained !== undefined)) {
    const abs = ok.filter((r) => r.abstention);
    summary.abstention = {
      questions: abs.length,
      abstained: abs.filter((r) => r.abstained).length,
      answerable: scored.length,
      abstainedOnAnswerable: scored.filter((r) => r.abstained).length,
    };
  }
  return summary;
}

const HEADLINE: [string, string][] = [
  ["recall_any@1", "Evidence session ranked first"],
  ["recall_any@5", "Evidence session in the top 5"],
  ["recall_any@10", "Evidence session in the top 10"],
  ["recall_all@10", "All evidence sessions in the top 10"],
  ["ndcg_any@10", "nDCG@10"],
  ["turn_recall@10", "Evidence turns covered by the top 10 items"],
  ["delivered_any", "Default recall delivers an evidence session"],
  ["delivered_all", "Default recall delivers all evidence sessions"],
  ["delivered_turns", "Evidence turns in the default recall"],
  ["delivered_tokens", "Tokens in the default recall"],
];

/** Counts are shown as they are, rates in percent. */
const isCount = (metric: string) => metric === "delivered_tokens" || metric === "delivered_items";

function fmt(metric: string, v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return "–";
  return isCount(metric) ? String(Math.round(v)) : (100 * v).toFixed(1);
}

export function summaryMarkdown(s: Summary, title = "LongMemEval retrieval"): string {
  const types = Object.keys(s.byType);
  const lines = [
    `## ${title}`,
    "",
    `${s.scored} scored questions` +
      (s.questions > s.scored ? `, ${s.questions - s.scored} without retrieval scores (abstention)` : "") +
      (s.failed ? `, **${s.failed} failed**` : "") +
      `. Rates in percent.`,
    "",
    `| Metric | All | ${types.map((t) => `${t} (${s.byType[t]!.n})`).join(" | ")} |`,
    `| --- | ---: | ${types.map(() => "---:").join(" | ")} |`,
  ];
  for (const [key, label] of HEADLINE) {
    if (s.overall[key] === undefined) continue;
    lines.push(`| ${label} | ${fmt(key, s.overall[key])} | ${types.map((t) => fmt(key, s.byType[t]!.metrics[key])).join(" | ")} |`);
  }
  if (s.abstention) {
    const a = s.abstention;
    lines.push(
      "",
      `Abstention: recall returned nothing for ${a.abstained} of ${a.questions} abstention questions, and for ${a.abstainedOnAnswerable} of ${a.answerable} answerable ones.`,
    );
  }
  lines.push("", `Median ingest per question ${(s.timing.ingestMsMedian / 1000).toFixed(1)} s, median recall ${Math.round(s.timing.recallMsMedian)} ms.`);
  return lines.join("\n") + "\n";
}

/** Exact two-sided McNemar test: b questions only A got right, c only B. */
export function mcnemar(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  // P(X <= min(b, c)) for X ~ Binomial(n, 0.5), summed in log space.
  let logTerm = n * Math.log(0.5);
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i++) {
    tail += Math.exp(logTerm);
    logTerm += Math.log(n - i) - Math.log(i + 1);
  }
  return Math.min(1, 2 * tail);
}

const BINARY = /^(recall_any|recall_all)@\d+$|^delivered_(any|all)$/;

export interface MetricComparison {
  metric: string;
  a: number;
  b: number;
  /** Binary metrics only: questions only B got right, only A got right, and the McNemar p-value. */
  better?: number;
  worse?: number;
  p?: number;
}

/** Paired comparison of two runs over the questions both scored. */
export function compareRuns(aAll: ResultRecord[], bAll: ResultRecord[]): { questions: number; metrics: MetricComparison[] } {
  const a = new Map(latestRecords(aAll).filter((r) => r.metrics && !r.error).map((r) => [r.id, r.metrics!]));
  const pairs = latestRecords(bAll).flatMap((r) => (r.metrics && !r.error && a.has(r.id) ? [[a.get(r.id)!, r.metrics] as const] : []));
  const keys = [...new Set(pairs.flatMap(([x, y]) => Object.keys(x).filter((k) => k in y)))];
  const order = (k: string) => {
    const i = HEADLINE.findIndex(([h]) => h === k);
    return i < 0 ? HEADLINE.length : i;
  };
  keys.sort((x, y) => order(x) - order(y) || x.localeCompare(y));
  const metrics = keys.map((metric) => {
    const both = pairs.filter(([x, y]) => metric in x && metric in y);
    const out: MetricComparison = { metric, a: mean(both.map(([x]) => x[metric]!)), b: mean(both.map(([, y]) => y[metric]!)) };
    if (BINARY.test(metric)) {
      out.better = both.filter(([x, y]) => !x[metric] && y[metric]).length;
      out.worse = both.filter(([x, y]) => x[metric] && !y[metric]).length;
      out.p = mcnemar(out.worse, out.better);
    }
    return out;
  });
  return { questions: pairs.length, metrics };
}

export function comparisonMarkdown(c: ReturnType<typeof compareRuns>, labelA = "A", labelB = "B"): string {
  const lines = [
    `## ${labelB} against ${labelA}`,
    "",
    `${c.questions} questions scored in both runs. Rates in percent; p is McNemar's exact test on the questions that changed.`,
    "",
    `| Metric | ${labelA} | ${labelB} | Change | Better / worse | p |`,
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const m of c.metrics) {
    const delta = (m.b - m.a) * (isCount(m.metric) ? 1 : 100);
    lines.push(
      `| ${m.metric} | ${fmt(m.metric, m.a)} | ${fmt(m.metric, m.b)} | ${delta >= 0 ? "+" : ""}${delta.toFixed(isCount(m.metric) ? 0 : 1)} | ` +
        `${m.better === undefined ? "–" : `${m.better} / ${m.worse}`} | ${m.p === undefined ? "–" : m.p < 0.001 ? "<0.001" : m.p.toFixed(3)} |`,
    );
  }
  return lines.join("\n") + "\n";
}
