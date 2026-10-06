import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: { id: string; request: { method: string; url: string; headers: [string, string][] } }[] = [];

vi.mock("../tauri/apiCommands", () => ({
  apiLoadTree: vi.fn(async () => ({
    collections: [
      {
        id: "c1",
        name: "Usuarios",
        auth: JSON.stringify({ type: "bearer", bearer: { token: "{{token}}" } }),
        variables: JSON.stringify([{ id: "v1", key: "base", initialValue: "", currentValue: "https://api.example.com", enabled: true }]),
        pre_script: "",
        post_script: "",
      },
    ],
    folders: [{ id: "f1", collection_id: "c1", parent_id: null, name: "Lectura", auth: JSON.stringify({ type: "inherit" }), pre_script: "", post_script: "" }],
    requests: [
      {
        id: "r1",
        collection_id: "c1",
        folder_id: "f1",
        name: "Un usuario",
        protocol: "http",
        spec: JSON.stringify({ protocol: "http", method: "GET", url: "{{base}}/users/{{id}}", auth: { type: "inherit" } }),
      },
    ],
  })),
  apiListEnvironments: vi.fn(async () => [
    { id: "e1", name: "Prod", is_global: false, variables: JSON.stringify([{ id: "v2", key: "token", initialValue: "", currentValue: "tok-123", enabled: true }]) },
  ]),
  apiLoadSettings: vi.fn(async () => null),
  apiListCookies: vi.fn(async () => []),
  apiCancelHttp: vi.fn(async () => {}),
  apiScriptTrustLookup: vi.fn(async () => []),
  apiSendHttpTracked: vi.fn(async (id: string, request: { method: string; url: string; headers: [string, string][] }) => {
    sent.push({ id, request });
    return {
      status: 200,
      status_text: "OK",
      http_version: "HTTP/1.1",
      headers: [["Content-Type", "application/json"]],
      body_text: '{"id": 7, "name": "Ana"}',
      body_base64: null,
      size_bytes: 24,
      duration_ms: 12,
      timings: {},
      redirects: [],
      set_cookies: [],
      sent: {},
    };
  }),
}));
vi.mock("../tauri/commands", () => ({ getSetting: vi.fn(async () => "e1") }));

describe("a saved request sent from a flow", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("goes the API client's way: variables, the environment, inherited auth, a parsed answer", async () => {
    const { runSavedRequest } = await import("./savedRequest");
    const answer = await runSavedRequest({ workspaceId: "w1", requestId: "r1", environmentId: "", variables: { id: "7" } });
    expect(sent).toHaveLength(1);
    expect(sent[0].request.method).toBe("GET");
    expect(sent[0].request.url).toBe("https://api.example.com/users/7");
    const auth = sent[0].request.headers.find(([name]) => name.toLowerCase() === "authorization");
    expect(auth?.[1]).toBe("Bearer tok-123");
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ id: 7, name: "Ana" });
    expect(answer.headers["content-type"]).toBe("application/json");
    expect(answer.name).toBe("Un usuario");
  });

  it("says when the request or the environment is gone", async () => {
    const { runSavedRequest } = await import("./savedRequest");
    await expect(runSavedRequest({ workspaceId: "w1", requestId: "nope", environmentId: "", variables: {} })).rejects.toThrow(/no longer/);
    await expect(runSavedRequest({ workspaceId: "w1", requestId: "r1", environmentId: "gone", variables: {} })).rejects.toThrow(/environment/);
  });
});
