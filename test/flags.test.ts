// SPDX-License-Identifier: AGPL-3.0-or-later
// Feature flags from PostHog with env as fallback and override (src/flags.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyFlags, FlagCache, flagsUrl, parseFlags } from "../src/flags";
import { MemoryObject } from "../src/memory-object";
import { DEFAULT_GRANTS } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

const ON = { POSTHOG_FLAGS: "on", POSTHOG_KEY: "phc_testtoken1234567890", POSTHOG_HOST: "https://us.i.posthog.com" };
const answer = (flags: Record<string, unknown>) => new Response(JSON.stringify({ flags }), { headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("flag config", () => {
  it("is off unless POSTHOG_FLAGS=on with a project token and an https host", () => {
    expect(flagsUrl({})).toBeNull();
    expect(flagsUrl({ ...ON, POSTHOG_FLAGS: "off" })).toBeNull();
    expect(flagsUrl({ ...ON, POSTHOG_KEY: "phx_personal_key_000" })).toBeNull();
    expect(flagsUrl({ ...ON, POSTHOG_HOST: "http://us.i.posthog.com" })).toBeNull();
    expect(flagsUrl(ON)).toBe("https://us.i.posthog.com/flags?v=2");
  });
  it("reads enabled flags and skips unknown, failed or malformed ones", () => {
    expect(parseFlags({ flags: { "rhizome-ledger": { enabled: true }, "rhizome-open-loops": { enabled: false }, "rhizome-standing-orders": { enabled: true, failed: true }, other: { enabled: true } } }))
      .toEqual({ LEDGER: true, OPEN_LOOPS: false });
    expect(parseFlags(null)).toEqual({});
    expect(parseFlags({ flags: { "rhizome-ledger": { enabled: "yes" } } })).toEqual({});
  });
  it("fills only unset vars, so env stays the override and kill switch", () => {
    const env = { ...ON, LEDGER: "off", STANDING_ORDERS: "" };
    const out = applyFlags(env, { LEDGER: true, STANDING_ORDERS: true, OPEN_LOOPS: false });
    expect(out).toMatchObject({ LEDGER: "off", STANDING_ORDERS: "on", OPEN_LOOPS: "off" });
    expect((out as Record<string, unknown>).DISPUTE_RESOLUTION).toBeUndefined();
    expect(env.STANDING_ORDERS).toBe("");
    expect(applyFlags({ LEDGER: undefined }, { LEDGER: true })).toEqual({ LEDGER: undefined });
  });
});

describe("flag cache", () => {
  it("waits for the first answer, then refreshes only after a minute", async () => {
    let t = 0;
    const fetcher = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init!.body))).toEqual({ api_key: ON.POSTHOG_KEY, distinct_id: "rhizome-deployment" });
      return answer({ "rhizome-open-loops": { enabled: true } });
    });
    const cache = new FlagCache(fetcher as never, () => t);
    await cache.ready(ON);
    expect(cache.apply(ON)).toMatchObject({ OPEN_LOOPS: "on" });
    await cache.ready(ON);
    expect(fetcher).toHaveBeenCalledTimes(1);
    t = 61_000;
    const waits: Promise<unknown>[] = [];
    await cache.ready(ON, { waitUntil: (p) => void waits.push(p) });
    await Promise.all(waits);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("keeps flags unset (off) when PostHog fails, and sends nothing when off", async () => {
    const down = vi.fn(async () => { throw new Error("offline"); });
    const cache = new FlagCache(down as never, () => 0);
    await cache.ready(ON);
    expect((cache.apply(ON) as Record<string, unknown>).OPEN_LOOPS).toBeUndefined();
    const off = vi.fn();
    await new FlagCache(off as never).ready({});
    expect(off).not.toHaveBeenCalled();
  });
});

describe("in the memory object", () => {
  it("turns on open loops from PostHog when OPEN_LOOPS is unset, and env off wins", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer({ "rhizome-open-loops": { enabled: true } })));
    const client = { id: "c1", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants: DEFAULT_GRANTS } as never;
    const make = async (vars: Record<string, string>) => {
      const s = fakeState();
      const mo = new MemoryObject(s.state as never, { ...fakeEnv(() => "{}").env, ...vars } as never);
      await new Promise((r) => setTimeout(r, 0));
      return mo;
    };
    const on = await make(ON);
    expect(() => on.openLoop(client, { scope: "profile", content: "Ask about the invoice." })).not.toThrow();
    const killed = await make({ ...ON, OPEN_LOOPS: "off" });
    expect(() => killed.openLoop(client, { scope: "profile", content: "Ask about the invoice." })).toThrow(/not allowed/);
  });
});
