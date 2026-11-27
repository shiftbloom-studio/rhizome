// SPDX-License-Identifier: AGPL-3.0-or-later
// The explorer page gets a fresh script nonce, so injected inline scripts can carry it.
import { describe, expect, it } from "vitest";
import { withScriptNonce } from "../src/index";

const page = () => new Response("<!doctype html><title>x</title>", { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "script-src 'self'" } });
const nonceOf = (r: Response) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(r.headers.get("content-security-policy") ?? "")?.[1];

describe("explorer CSP", () => {
  it("sets a fresh nonce on every page and keeps the policy strict", async () => {
    const a = withScriptNonce(page());
    const b = withScriptNonce(page());
    const csp = a.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{24}';/);
    expect(csp.split(";").find((d) => d.trim().startsWith("script-src"))).not.toContain("unsafe");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(nonceOf(a)).not.toBe(nonceOf(b));
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(await a.text()).toContain("<title>x</title>");
  });

  it("leaves other files alone", () => {
    const js = new Response("1", { headers: { "content-type": "text/javascript", "content-security-policy": "x" } });
    expect(withScriptNonce(js).headers.get("content-security-policy")).toBe("x");
  });
});
