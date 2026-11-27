// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MemoryObject } from "./memory-object";

export interface Env {
  /** One Durable Object per human. Holds every scope of that person's memory. */
  MEMORY: DurableObjectNamespace<MemoryObject>;
  /** Control plane: users, agent clients, hashed API keys. No memory content. */
  CONTROL_DB: D1Database;
  /** Raw episodes, verbatim. The lossless source every derived index can be rebuilt from. */
  EPISODES: R2Bucket;
  /** Semantic index. Namespace = user id, metadata `scope` and `kind` are indexed, and `day` (event day) for VECTOR_FILTERS. */
  VECTORS: VectorizeIndex;
  AI: Ai;
  /** Optional per-key rate limiter. */
  RATE_LIMITER?: RateLimit;

  /** Secret. Required for the /v1/admin endpoints. */
  ADMIN_TOKEN?: string;
  EMBEDDING_MODEL?: string;
  RERANK_MODEL?: string;
  /** Model that turns episodes into notes. Default: DeepSeek V4.1 Flash on Workers AI. */
  EXTRACTION_MODEL?: string;
  /** Model for nightly reflection (profile distillation, project summaries). Default: GLM 5.3. */
  REFLECTION_MODEL?: string;
  /**
   * "on": nightly reflection settles disputed notes by trust and time, and asks the
   * extraction model about the pairs the trust ladder cannot decide (at most 20 a night). Default: on (unset follows the
   * PostHog flag, src/flags.ts); "off" turns it off.
   */
  DISPUTE_RESOLUTION?: string;
  /**
   * "on": dreaming (src/dreaming.ts). When the person has been away for 10 minutes, and after each nightly
   * reflection, a cheap model walks every note in neighbourhoods of related notes: merges repeats, marks notes a
   * later one replaced, rewrites unclear notes and writes rollup notes that list every instance of one kind of thing.
   * Default: on (unset follows the PostHog flag rhizome-dreaming, src/flags.ts); "off" turns it off. Needs extraction.
   */
  DREAMING?: string;
  /** Model for dreaming. Default: EXTRACTION_MODEL, else DeepSeek V4.1 Flash on Workers AI, without thinking. */
  DREAM_MODEL?: string;
  /** Model calls (neighbourhoods) for dreaming per person and UTC day. Default: 100 (about 4,000 neurons). */
  DREAM_DAILY_LIMIT?: string;
  /**
   * "on": the ledger records which connector was given which memory and tells it once,
   * on its next get_context or recall, when that memory was replaced or deleted. Default: on (unset follows the
   * PostHog flag, src/flags.ts); "off" turns it off.
   */
  LEDGER?: string;
  /**
   * "on": anonymous MCP usage analytics to PostHog (tool name, outcome, latency, sizes,
   * client software). Needs POSTHOG_KEY and POSTHOG_HOST. See src/analytics.ts. Default: off.
   */
  MCP_ANALYTICS?: string;
  /**
   * "on": feature flags from PostHog (src/flags.ts). Flag vars that are not set (LEDGER, STANDING_ORDERS,
   * OPEN_LOOPS, DISPUTE_RESOLUTION, DREAMING) take the value of rhizome-ledger, rhizome-standing-orders,
   * rhizome-open-loops, rhizome-dispute-resolution and rhizome-dreaming. Needs POSTHOG_KEY and POSTHOG_HOST. Default: off
   * (then those vars, when unset, are on).
   */
  POSTHOG_FLAGS?: string;
  /** PostHog project API key (phc_...). Set as a secret or deploy variable, never committed. */
  POSTHOG_KEY?: string;
  /** PostHog ingestion host, e.g. https://eu.i.posthog.com or https://us.i.posthog.com. */
  POSTHOG_HOST?: string;
  /** "on": open loops. Agents can open a loop with a due time, get_context leads with what is due, close_loop ends it. Default: on (unset follows the PostHog flag, src/flags.ts); "off" turns it off. */
  OPEN_LOOPS?: string;
  /**
   * "on": records (src/records.ts). Every note is filed into a typed row (category, tags, quantity,
   * date) by RECORDS_MODEL; the recall step "records" then adds every note of the kind a query asks
   * for, and the query_records tool lists, counts and sums them. Default: on (unset follows the
   * PostHog flag, src/flags.ts); "off" turns it off.
   */
  RECORDS?: string;
  /** Model that files notes into records. Default: Llama 4 Scout on Workers AI. */
  RECORDS_MODEL?: string;
  /**
   * "on": recall inside a time window also asks Vectorize with a range filter on the event day.
   * Needs a number metadata index `day` on the index (see README). Default: off.
   */
  VECTOR_FILTERS?: string;
  /** "off" disables fact extraction from episodes. */
  EXTRACTION?: string;
  /** "on" turns on standing orders: rules checked against agents' tool calls (src/orders.ts). Default: on (unset follows the PostHog flag, src/flags.ts); "off" turns it off. */
  STANDING_ORDERS?: string;
  /** Recall steps, comma separated: abstain, diversity, evidence, time, keys, turns, records, "all" or "none". Default: all. */
  RECALL_FEATURES?: string;
  /** How conversations are cut for search: "fixed" (1,200 characters, default) or "rounds" (one question and its answers). */
  CHUNKING?: string;
  /** Maximum episodes per person and UTC day that go through fact extraction. Default: 200. */
  EXTRACTION_DAILY_LIMIT?: string;

  /** Static files of the memory explorer. */
  ASSETS?: Fetcher;
  /** Cloudflare Access application audience tag. Without it the explorer API is disabled. */
  ACCESS_AUD?: string;
  /** Cloudflare Access team domain, e.g. example.cloudflareaccess.com. */
  ACCESS_TEAM_DOMAIN?: string;

  /** How people sign in to the explorer and the consent page: "access" (default), "password" or "proxy". See src/identity.ts. */
  AUTH_MODE?: string;
  /** AUTH_MODE=password: the one email address that may sign in, and its password (secret). */
  LOGIN_EMAIL?: string;
  LOGIN_PASSWORD?: string;
  /** Secret, at least 32 characters. Signs session cookies (password) and consent tokens (proxy). */
  SESSION_SECRET?: string;
  /** AUTH_MODE=proxy: request header with the signed-in email, e.g. Remote-Email or Tailscale-User-Login. */
  PROXY_AUTH_HEADER?: string;
  /** AUTH_MODE=proxy: at least 32 characters, sent by the proxy in x-rhizome-proxy-secret. Required unless PROXY_TRUSTED_IPS is used. */
  PROXY_AUTH_SECRET?: string;
  /** AUTH_MODE=proxy on Node only: addresses or IPv4 ranges the proxy connects from (checked against the TCP peer). */
  PROXY_TRUSTED_IPS?: string;
  /** Optional stricter limiter for /auth/login. Falls back to RATE_LIMITER. */
  LOGIN_RATE_LIMITER?: RateLimit;

  /** Operator details for the imprint and privacy pages. Set at deploy time, never committed. */
  OPERATOR_NAME?: string;
  OPERATOR_BUSINESS?: string;
  OPERATOR_STREET?: string;
  OPERATOR_CITY?: string;
  OPERATOR_COUNTRY_EN?: string;
  OPERATOR_COUNTRY_DE?: string;
  OPERATOR_EMAIL?: string;
  OPERATOR_PHONE?: string;
  SUPERVISORY_AUTHORITY?: string;
}

export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const DEFAULT_RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** Workers AI call with a loose type: model ids are configuration, not literals. */
export async function runAi<T>(ai: Ai, model: string, input: unknown): Promise<T> {
  const run = ai.run as unknown as (model: string, input: unknown) => Promise<unknown>;
  return (await run.call(ai, model, input)) as T;
}
