// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workers AI limits and which errors are worth another try. No Node imports:
// the benchmark on Node (bench/ai.ts) and on Cloudflare (bench/worker.ts) share it.

/**
 * Models that need the Workers Paid plan get 20 requests per minute per account,
 * all other text models 300 (developers.cloudflare.com/workers-ai/platform/limits).
 * The defaults stay a little below.
 */
export const PAID_MODELS = /deepseek-v4|glm-5|kimi-k2|inkling/i;

export function defaultRpm(model: string): number {
  return PAID_MODELS.test(model) ? 18 : 300;
}

/** The Cloudflare API allows 1,200 requests per five minutes per token, and blocks all calls for five minutes after that. */
export const DEFAULT_API_LIMIT = 1000;

export class RetryableError extends Error {}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  const e = err as { name?: string; message?: string } | undefined;
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
  const message = String(e?.message ?? err);
  const status = /HTTP (\d{3})/.exec(message)?.[1];
  if (status) return status === "429" || status === "408" || status.startsWith("5");
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(message);
}

/**
 * Errors of the Workers AI binding worth another try: rate limits, capacity (3040),
 * time-outs and server errors. A spent daily allocation (3036) or a bad request is not.
 */
export function isRetryableAiError(err: unknown): boolean {
  if (isRetryable(err)) return true;
  const message = String((err as { message?: string } | undefined)?.message ?? err);
  if (/\b3036\b|\b40[0-4]\b/.test(message)) return false;
  return /\b(3040|429|5\d\d)\b|capacity|rate.?limit|too many requests|timed? ?out|temporar|internal server error|upstream|overloaded|network connection lost/i.test(message);
}
