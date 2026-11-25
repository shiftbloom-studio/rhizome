// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeAll, describe, expect, it, vi } from "vitest";
import { verifyAccess } from "../src/access";

const TEAM = "team.example.com";
const AUD = "aud-123";
let privateKey: CryptoKey;

const b64 = (data: Uint8Array | string) =>
  btoa(typeof data === "string" ? data : String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(payload: Record<string, unknown>, kid = "k1"): Promise<string> {
  const head = b64(JSON.stringify({ alg: "RS256", kid }));
  const body = b64(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64(sig)}`;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  privateKey = pair.privateKey;
  const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }))));
});

const now = Date.UTC(2026, 10, 25, 12);
const valid = { aud: [AUD], iss: `https://${TEAM}`, exp: now / 1000 + 600, email: "Person@Example.com", sub: "s1" };

describe("verifyAccess", () => {
  it("accepts a valid token and lowercases the email", async () => {
    expect(await verifyAccess(await sign(valid), TEAM, AUD, now)).toEqual({ email: "person@example.com", sub: "s1" });
  });
  it("rejects another audience, issuer, expired tokens and unknown keys", async () => {
    expect(await verifyAccess(await sign({ ...valid, aud: ["other"] }), TEAM, AUD, now)).toBeNull();
    expect(await verifyAccess(await sign({ ...valid, iss: "https://evil.example.com" }), TEAM, AUD, now)).toBeNull();
    expect(await verifyAccess(await sign({ ...valid, exp: now / 1000 - 120 }), TEAM, AUD, now)).toBeNull();
    expect(await verifyAccess(await sign(valid, "k2"), TEAM, AUD, now)).toBeNull();
  });
  it("rejects a tampered payload and garbage", async () => {
    const [h, , s] = (await sign(valid)).split(".");
    const forged = `${h}.${b64(JSON.stringify({ ...valid, email: "admin@example.com" }))}.${s}`;
    expect(await verifyAccess(forged, TEAM, AUD, now)).toBeNull();
    expect(await verifyAccess("not.a.jwt", TEAM, AUD, now)).toBeNull();
    expect(await verifyAccess(undefined, TEAM, AUD, now)).toBeNull();
  });
});
