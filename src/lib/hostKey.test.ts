import { describe, expect, it } from "vitest";
import { isUnknownHostKeyError } from "./hostKey";

describe("isUnknownHostKeyError", () => {
  it("recognises the tunnel's unknown-host failure, however it was wrapped", () => {
    const message =
      "SSH host key not trusted yet: bastion.example.com:22 isn't in your known_hosts file, so ssh refused to connect.";
    expect(isUnknownHostKeyError(message)).toBe(true);
    expect(isUnknownHostKeyError(new Error(message))).toBe(true);
  });

  it("does not offer to trust a key that changed, or anything else", () => {
    expect(isUnknownHostKeyError("SSH host key has changed: bastion.example.com presented a different key")).toBe(false);
    expect(isUnknownHostKeyError("Permission denied (publickey).")).toBe(false);
  });
});
