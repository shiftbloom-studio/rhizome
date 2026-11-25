// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MemoryObject } from "./memory-object";

export interface Env {
  /** One Durable Object per human. Holds every scope of that person's memory. */
  MEMORY: DurableObjectNamespace<MemoryObject>;
  /** Control plane: users, agent clients, hashed API keys. No memory content. */
  CONTROL_DB: D1Database;
  /** Raw episodes, verbatim. The lossless source every derived index can be rebuilt from. */
  EPISODES: R2Bucket;
  /** Semantic index. Namespace = user id, metadata `scope` and `kind` are indexed. */
  VECTORS: VectorizeIndex;
  AI: Ai;
  /** Optional per-key rate limiter. */
  RATE_LIMITER?: RateLimit;

  /** Secret. Required for the /v1/admin endpoints. */
  ADMIN_TOKEN?: string;
  EMBEDDING_MODEL?: string;
  RERANK_MODEL?: string;
}

export const DEFAULT_EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const DEFAULT_RERANK_MODEL = "@cf/baai/bge-reranker-base";

/** Workers AI call with a loose type: model ids are configuration, not literals. */
export async function runAi<T>(ai: Ai, model: string, input: unknown): Promise<T> {
  const run = ai.run as unknown as (model: string, input: unknown) => Promise<unknown>;
  return (await run.call(ai, model, input)) as T;
}
