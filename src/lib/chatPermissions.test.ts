import { describe, expect, it } from "vitest";
import { DEFAULT_CHAT_PERMISSIONS, permissionsArg } from "./chatPermissions";

describe("chat permissions", () => {
  it("defaults to restricted", () => {
    expect(DEFAULT_CHAT_PERMISSIONS).toBe("restricted");
  });

  it("sends full only for a turn that is not a plan turn", () => {
    expect(permissionsArg("full", false)).toBe("full");
    expect(permissionsArg("full", true)).toBeNull();
    expect(permissionsArg("restricted", false)).toBeNull();
    expect(permissionsArg(undefined, false)).toBeNull();
  });
});
