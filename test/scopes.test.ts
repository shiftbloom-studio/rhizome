import { describe, expect, it } from "vitest";
import { can, DEFAULT_GRANTS, isValidScope, recallScopes, type Client } from "../src/scopes";

const claude: Client = { id: "c1", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants: DEFAULT_GRANTS };
const readOnly: Client = { ...claude, id: "c2", agent: "chatgpt", provider: "openai", grants: { read: ["profile"], write: [] } };

describe("isValidScope", () => {
  it.each(["profile", "project:rhizome", "agent:claude-code", "project:a.b_c-1"])("accepts %s", (s) => expect(isValidScope(s)).toBe(true));
  it.each(["", "profiles", "project:", "project:Upper", "agent:x:y", "team:x", "project:../x"])("rejects %s", (s) =>
    expect(isValidScope(s)).toBe(false));
});

describe("can", () => {
  it("resolves agent:self to the client's own agent", () => {
    expect(can(claude, "write", "agent:claude-code")).toBe(true);
    expect(can(claude, "read", "agent:hermes")).toBe(false);
  });
  it("matches project wildcards", () => expect(can(claude, "write", "project:anything")).toBe(true));
  it("enforces read-only clients", () => {
    expect(can(readOnly, "read", "profile")).toBe(true);
    expect(can(readOnly, "write", "profile")).toBe(false);
  });
});

describe("recallScopes", () => {
  it("defaults to profile, own agent and the given project", () =>
    expect(recallScopes(claude, undefined, "rhizome")).toEqual(["profile", "agent:claude-code", "project:rhizome"]));
  it("drops scopes the client cannot read", () =>
    expect(recallScopes(readOnly, ["profile", "agent:claude-code", "project:x"])).toEqual(["profile"]));
});
