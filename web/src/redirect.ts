// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The sign-in page to send the browser to, or null when `signIn` would leave
 * this origin. Parsing with URL catches what a prefix check misses, such as
 * "/\t/evil.example", which browsers read as "//evil.example".
 */
export function sameOriginSignIn(signIn: string | null | undefined, origin: string, next: string): string | null {
  if (!signIn) return null;
  let url: URL;
  try {
    url = new URL(signIn, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  url.searchParams.set("next", next);
  return url.pathname + url.search + url.hash;
}
