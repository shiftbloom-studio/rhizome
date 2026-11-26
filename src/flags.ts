// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The flag vars below (LEDGER, STANDING_ORDERS, OPEN_LOOPS, DISPUTE_RESOLUTION) default to ON.
// A var that is set ("on" or "off") always wins, so env stays the kill switch. An unset var takes the value
// of its PostHog flag when POSTHOG_FLAGS=on (with POSTHOG_KEY and POSTHOG_HOST): enabled -> "on",
// disabled -> "off". Without POSTHOG_FLAGS, or when PostHog is unreachable, slow (over 1.5 s), or the flag
// is missing or failed to evaluate, the var is "on".
//
// Flags are evaluated once for the whole deployment (one fixed distinct_id), not per person: the Worker
// lists tools and the Durable Object enforces them, and both must agree. Nothing about people is sent.

export const FLAGS = {
  LEDGER: "rhizome-ledger",
  STANDING_ORDERS: "rhizome-standing-orders",
  OPEN_LOOPS: "rhizome-open-loops",
  DISPUTE_RESOLUTION: "rhizome-dispute-resolution",
} as const;

export type FlagVar = keyof typeof FLAGS;
export type FlagEnv = { POSTHOG_FLAGS?: string; POSTHOG_KEY?: string; POSTHOG_HOST?: string } & { [K in FlagVar]?: string };
type Values = Partial<Record<FlagVar, boolean>>;

const DISTINCT_ID = "rhizome-deployment";
const TTL_MS = 60_000;
const TIMEOUT_MS = 1_500;

/** The flags endpoint, or null when PostHog flags are off or not configured. */
export function flagsUrl(env: FlagEnv): string | null {
  if ((env.POSTHOG_FLAGS ?? "").trim().toLowerCase() !== "on") return null;
  if (!/^phc_[A-Za-z0-9_-]{10,}$/.test(env.POSTHOG_KEY?.trim() ?? "")) return null;
  try {
    const url = new URL(env.POSTHOG_HOST?.trim() ?? "");
    return url.protocol === "https:" ? `${url.origin}/flags?v=2` : null;
  } catch {
    return null;
  }
}

/** Reads `{ flags: { key: { enabled } } }` (flags v2). Unknown or errored flags are left out. */
export function parseFlags(body: unknown): Values {
  const flags = (body as { flags?: Record<string, { enabled?: unknown; failed?: unknown }> } | null)?.flags;
  const out: Values = {};
  if (!flags || typeof flags !== "object") return out;
  for (const [v, key] of Object.entries(FLAGS) as [FlagVar, string][]) {
    const f = flags[key];
    if (f && typeof f.enabled === "boolean" && f.failed !== true) out[v] = f.enabled;
  }
  return out;
}

/** The env with every unset flag var resolved: the PostHog value when there is one, otherwise "on".
 * Set vars and non-flag fields are untouched. */
export function applyFlags<T extends FlagEnv>(env: T, values: Values | null): T {
  const from = flagsUrl(env) ? values : null;
  let out: T | null = null;
  for (const v of Object.keys(FLAGS) as FlagVar[]) {
    if ((env[v] ?? "").trim() !== "") continue;
    out ??= { ...env };
    (out as FlagEnv)[v] = from?.[v] === false ? "off" : "on";
  }
  return out ?? env;
}

/** Per-isolate cache: the first use waits for PostHog (at most 1.5 s), later ones refresh in the background. */
export class FlagCache {
  private values: Values | null = null;
  private at = -Infinity;
  private pending: Promise<void> | null = null;

  constructor(private fetcher: typeof fetch = (...a) => fetch(...a), private now = () => Date.now()) {}

  /** Fetches when stale. Never throws; a failed fetch keeps the last values and retries after the TTL. */
  refresh(env: FlagEnv): Promise<void> {
    const url = flagsUrl(env);
    if (!url || this.now() - this.at < TTL_MS) return Promise.resolve();
    this.pending ??= this.fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY!.trim(), distinct_id: DISTINCT_ID }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
      .then(async (r) => {
        if (r.ok) this.values = { ...this.values, ...parseFlags(await r.json()) };
        else void r.body?.cancel();
      })
      .catch(() => {})
      .finally(() => {
        this.at = this.now();
        this.pending = null;
      });
    return this.pending;
  }

  /** Waits only before the first answer; afterwards it refreshes in the background (waitUntil). */
  async ready(env: FlagEnv, bg?: { waitUntil(p: Promise<unknown>): void }): Promise<void> {
    if (!flagsUrl(env)) return;
    if (this.at === -Infinity) return this.refresh(env);
    const p = this.refresh(env);
    if (typeof bg?.waitUntil === "function") bg.waitUntil(p);
  }

  apply<T extends FlagEnv>(env: T): T {
    return applyFlags(env, this.values);
  }
}
