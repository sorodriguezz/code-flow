import { describe, expect, it } from "vitest";
import { defaultAuth } from "../../types/api";
import { authFillFrom, authFillSupported } from "./fill";

describe("authFillFrom", () => {
  it("fills the credential verbatim — the form sends it, so it has to be the real value", () => {
    const filled = authFillFrom(defaultAuth("basic"), { username: "  svc-user ", password: " p@ss " });
    expect(filled.auth.basic).toEqual({ username: "svc-user", password: " p@ss " });
    expect(filled.filled).toBe(2);
  });

  it("never changes the auth type the request was set to", () => {
    const filled = authFillFrom(defaultAuth("bearer"), { username: "u", password: "pw", apiKey: "key-1" });
    expect(filled.auth.type).toBe("bearer");
    expect(filled.auth.bearer.token).toBe("key-1");
  });

  it("answers nothing for the schemes whose credential is half of something else", () => {
    expect(authFillFrom(defaultAuth("oauth2"), { password: "pw" }).filled).toBe(0);
    expect(authFillSupported("oauth2")).toBe(false);
    expect(authFillSupported("jwt")).toBe(false);
    expect(authFillSupported("apikey")).toBe(true);
  });
});
