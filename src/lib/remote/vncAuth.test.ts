import { describe, expect, it } from "vitest";
import { vncCredentials, vncMissingCredential } from "./vncAuth";

/**
 * The credential bag handed to noVNC, and the sentence shown when it is short of something.
 *
 * The case that matters is macOS: its Screen Sharing server offers Apple's Diffie-Hellman first,
 * that scheme logs into an account, and a bag without a username leaves the handshake waiting
 * forever. So what these hold down is that a filled username survives to noVNC, that a blank one is
 * *absent* rather than empty — the difference between being asked and being rejected — and that the
 * field named back to the user is one they actually left blank.
 */
describe("vncCredentials", () => {
  it("passes a username through, because Apple DH logs into an account", () => {
    expect(vncCredentials("server", "hunter2")).toEqual({ username: "server", password: "hunter2" });
  });

  it("omits a blank username instead of sending a nameless account", () => {
    expect(vncCredentials("", "hunter2")).toEqual({ password: "hunter2" });
  });

  it("omits a blank password, so the server asks rather than refuses", () => {
    expect(vncCredentials("server", "")).toEqual({ username: "server" });
  });

  it("trims a username, where edge whitespace is only ever a typo", () => {
    expect(vncCredentials("  server ", "hunter2").username).toBe("server");
  });

  it("keeps a password verbatim, where whitespace may be deliberate", () => {
    expect(vncCredentials("server", " pass ").password).toBe(" pass ");
  });
});

describe("vncMissingCredential", () => {
  it("names the username when a Mac asks for both and none was saved", () => {
    expect(vncMissingCredential(["username", "password"], { password: "hunter2" })).toBe("username");
  });

  it("names the password when a Mac asks for both and the username is set", () => {
    expect(vncMissingCredential(["username", "password"], { username: "server" })).toBe("password");
  });

  it("names the password for a scheme that only wants one", () => {
    expect(vncMissingCredential(["password"], { username: "server" })).toBe("password");
  });

  it("names the password when the event says nothing at all", () => {
    expect(vncMissingCredential(undefined, {})).toBe("password");
  });
});
