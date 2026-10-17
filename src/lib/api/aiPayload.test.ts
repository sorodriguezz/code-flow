import { describe, expect, it } from "vitest";
import { exchangeForAi, MASK, maskUrl, requestAskForAi, secretValues, stripFence } from "./aiPayload";
import { parseDraftedRequest } from "./aiRequest";
import type { ApiResponse, ApiVariable } from "../../types/api";

const secret: ApiVariable = { id: "1", key: "token", initialValue: "s3cr3t-token", currentValue: "s3cr3t-token", secret: true, enabled: true, description: "" };
const plain: ApiVariable = { id: "2", key: "baseUrl", initialValue: "https://api.example.com", currentValue: "https://api.example.com", secret: false, enabled: true, description: "" };

const response: ApiResponse = {
  status: 401,
  status_text: "Unauthorized",
  http_version: "HTTP/1.1",
  headers: [["Set-Cookie", "sid=abc"], ["Content-Type", "application/json"]],
  body_text: JSON.stringify({ error: "bad token", access_token: "zzz", echo: "s3cr3t-token" }),
  body_base64: null,
  size_bytes: 80,
  duration_ms: 12,
  timings: { dns_ms: 1, connect_ms: 2, tls_ms: -1, first_byte_ms: 8, download_ms: 1, total_ms: 12 },
  redirects: [],
  set_cookies: [],
  sent: {
    method: "GET",
    url: "https://api.example.com/me?api_key=k123&page=2",
    headers: [["Authorization", "Bearer s3cr3t-token"], ["X-Trace", "s3cr3t-token"]],
    body_preview: "",
  },
  tests: [],
  consoleLines: [],
  visualizer: null,
  error: null,
};

describe("aiPayload", () => {
  it("masks credentials by name and secret values wherever they landed", () => {
    const text = exchangeForAi(response, secretValues([[secret, plain]]));
    expect(text).not.toContain("s3cr3t-token");
    expect(text).not.toContain("k123");
    expect(text).not.toContain("sid=abc");
    expect(text).not.toContain("zzz");
    expect(text).toContain("page=2");
    expect(text).toContain("bad token");
    expect(text).toContain(MASK);
  });

  it("masks a password in the URL's authority", () => {
    expect(maskUrl("https://ana:hunter22@example.com/x", [])).toBe(`https://ana:${MASK}@example.com/x`);
  });

  it("lists variables for a drafted request, never a secret's value", () => {
    const ask = requestAskForAi("list users", [[secret, plain]]);
    expect(ask).toContain("{{baseUrl}} = https://api.example.com");
    expect(ask).toContain(`{{token}} = ${MASK}`);
  });

  it("strips the fence a model was told not to write", () => {
    expect(stripFence("```js\npm.test('x', () => {});\n```")).toBe("pm.test('x', () => {});");
  });
});

describe("parseDraftedRequest", () => {
  it("reads the JSON answer into a request", () => {
    const drafted = parseDraftedRequest(
      'Here you go:\n{"name":"Crear usuario","method":"post","url":"{{baseUrl}}/users?notify=true","headers":[{"key":"Content-Type","value":"application/json"},{"key":"bad key","value":"x"}],"body":{"mode":"json","content":"{\\"email\\":\\"a@b.c\\"}"}}',
    );
    expect(drafted?.name).toBe("Crear usuario");
    expect(drafted?.spec.method).toBe("POST");
    expect(drafted?.spec.url).toBe("{{baseUrl}}/users?notify=true");
    expect(drafted?.spec.params.map((p) => [p.key, p.value])).toEqual([["notify", "true"]]);
    expect(drafted?.spec.headers.map((h) => h.key)).toEqual(["Content-Type"]);
    expect(drafted?.spec.body.mode).toBe("raw");
    expect(JSON.parse(drafted?.spec.body.raw ?? "")).toEqual({ email: "a@b.c" });
    expect(drafted?.spec.preScript).toBe("");
  });

  it("refuses an answer with no usable URL", () => {
    expect(parseDraftedRequest("no idea")).toBeNull();
    expect(parseDraftedRequest('{"method":"GET","url":""}')).toBeNull();
  });
});
