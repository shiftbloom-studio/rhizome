// SPDX-License-Identifier: AGPL-3.0-or-later

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Time-sortable, URL-safe id: 9 chars of milliseconds + 12 random chars. Globally unique per index. */
export function newId(): string {
  const time = Date.now().toString(36).padStart(9, "0");
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let rand = "";
  for (const b of bytes) rand += ALPHABET[b % 36];
  return time + rand;
}

/** Random secret with a readable prefix, e.g. `rz_live_…`. */
export function newSecret(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return `${prefix}${out}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
