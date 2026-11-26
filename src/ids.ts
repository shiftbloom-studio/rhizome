// SPDX-License-Identifier: AGPL-3.0-or-later

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const MASK = 63; // smallest 2^k - 1 >= ALPHABET.length - 1

/** `len` uniformly random ALPHABET chars (rejection sampling, no modulo bias). */
function randomChars(len: number): string {
  let out = "";
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      const v = b & MASK;
      if (v < ALPHABET.length) out += ALPHABET[v];
      if (out.length === len) break;
    }
  }
  return out;
}

/** Time-sortable, URL-safe id: 9 chars of milliseconds + 12 random chars. Globally unique per index. */
export function newId(): string {
  const time = Date.now().toString(36).padStart(9, "0");
  return time + randomChars(12);
}

/** Random secret with a readable prefix, e.g. `rz_live_…`. */
export function newSecret(prefix: string): string {
  return `${prefix}${randomChars(32)}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
