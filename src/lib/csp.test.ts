import { describe, expect, it } from "vitest";
import { CSP_DIRECTIVES, contentSecurityPolicy } from "./csp";

describe("the app's Content-Security-Policy", () => {
  it("never lets an inline or remote script run", () => {
    const scripts = CSP_DIRECTIVES["script-src"];
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts.some((source) => source.includes(":") && source !== "'self'")).toBe(false);
    expect(CSP_DIRECTIVES["object-src"]).toEqual(["'none'"]);
    expect(CSP_DIRECTIVES["base-uri"]).toEqual(["'self'"]);
    expect(CSP_DIRECTIVES["form-action"]).toEqual(["'none'"]);
  });

  it("keeps what the app really uses", () => {
    // `new Function` in the API script sandbox.
    expect(CSP_DIRECTIVES["script-src"]).toContain("'unsafe-eval'");
    // Tauri IPC on every platform, and noVNC's loopback bridge.
    for (const source of ["ipc:", "http://ipc.localhost", "ws://127.0.0.1:*"]) {
      expect(CSP_DIRECTIVES["connect-src"]).toContain(source);
    }
    // Inline style attributes, and pictures in rendered markdown and HTML previews.
    expect(CSP_DIRECTIVES["style-src"]).toContain("'unsafe-inline'");
    expect(CSP_DIRECTIVES["img-src"]).toEqual(expect.arrayContaining(["data:", "blob:", "https:"]));
    expect(CSP_DIRECTIVES["worker-src"]).toEqual(expect.arrayContaining(["'self'", "blob:"]));
    expect(CSP_DIRECTIVES["frame-src"]).toContain("'self'");
  });

  it("sends nothing beyond this machine", () => {
    const connect = CSP_DIRECTIVES["connect-src"];
    expect(connect).not.toContain("https:");
    expect(connect).not.toContain("ws:");
    expect(connect).not.toContain("wss:");
    expect(connect.filter((source) => source.startsWith("ws")).every((source) => /\/\/(127\.0\.0\.1|localhost):\*$/.test(source))).toBe(
      true,
    );
  });

  it("serializes as one directive per clause", () => {
    const policy = contentSecurityPolicy();
    expect(policy.startsWith("default-src 'self'; ")).toBe(true);
    expect(policy.split("; ")).toHaveLength(Object.keys(CSP_DIRECTIVES).length);
    expect(policy).not.toMatch(/[\r\n"]/);
  });
});
