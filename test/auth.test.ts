// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseExpiresAt } from "../src/auth";

describe("parseExpiresAt", () => {
  const now = Date.UTC(2026, 0, 1);
  it("treats empty values as no expiry", () => {
    expect(parseExpiresAt(undefined, now)).toBeNull();
    expect(parseExpiresAt(null, now)).toBeNull();
    expect(parseExpiresAt("", now)).toBeNull();
  });
  it("accepts epoch ms and ISO dates in the future", () => {
    expect(parseExpiresAt(now + 1000, now)).toBe(now + 1000);
    expect(parseExpiresAt("2026-02-01T00:00:00Z", now)).toBe(Date.UTC(2026, 1, 1));
  });
  it("rejects past dates and garbage", () => {
    expect(() => parseExpiresAt(now - 1, now)).toThrow(/future/);
    expect(() => parseExpiresAt("soon", now)).toThrow(/ISO/);
    expect(() => parseExpiresAt({}, now)).toThrow();
  });
});
