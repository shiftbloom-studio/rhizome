// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { sameOriginSignIn } from "../web/src/redirect";

const ORIGIN = "https://memory.example.com";

describe("sameOriginSignIn", () => {
  it("keeps the server's sign-in path and adds where to come back to", () => {
    expect(sameOriginSignIn("/auth/login", ORIGIN, "/ui/?q=1")).toBe("/auth/login?next=%2Fui%2F%3Fq%3D1");
  });
  it("returns null without a sign-in page", () => {
    expect(sameOriginSignIn(null, ORIGIN, "/")).toBeNull();
    expect(sameOriginSignIn("", ORIGIN, "/")).toBeNull();
  });
  it("refuses anything that leaves the origin", () => {
    for (const bad of [
      "https://evil.example/login",
      "//evil.example/login",
      "/\\evil.example/login",
      "\\\\evil.example/login",
      "/\t/evil.example/login",
      "/\n/evil.example/login",
      " //evil.example",
      "javascript:alert(1)",
      "http://memory.example.com/auth/login",
    ]) {
      expect(sameOriginSignIn(bad, ORIGIN, "/"), JSON.stringify(bad)).toBeNull();
    }
  });
});
