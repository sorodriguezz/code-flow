import { describe, expect, it, vi } from "vitest";
import type { ApiCollection, ApiFolder, ApiResponse, ResolvedRequest } from "../../types/api";

// The sandbox reaches the transport only through `pm.sendRequest`, which nothing here calls.
vi.mock("../tauri/apiCommands", () => ({
  apiSendHttp: async () => {
    throw new Error("no network in tests");
  },
}));

const { chainScripts, folderChain, runScriptChain } = await import("./scriptChain");
type ChainOwner = import("./scriptChain").ChainOwner;

const STAMP = "2026-01-01T00:00:00+00:00";

function collection(pre: string, post: string): ApiCollection {
  return {
    id: "c1",
    workspace_id: "w1",
    name: "Orders API",
    description: "",
    auth: "",
    pre_script: pre,
    post_script: post,
    variables: "[]",
    sort_order: 0,
    pinned: false,
    created_at: STAMP,
    updated_at: STAMP,
    scope: "workspace",
  };
}

function folder(id: string, parent: string | null, pre: string, post: string): ApiFolder {
  return {
    id,
    collection_id: "c1",
    parent_id: parent,
    name: id,
    description: "",
    auth: "",
    pre_script: pre,
    post_script: post,
    sort_order: 0,
    created_at: STAMP,
    updated_at: STAMP,
  };
}

function request(): ResolvedRequest {
  return {
    protocol: "http",
    method: "GET",
    url: "https://api.example.test/v1/orders",
    headers: [],
    body: { kind: "none" },
    backendAuth: null,
    options: {
      timeout_ms: 1000,
      follow_redirects: true,
      max_redirects: 5,
      verify_ssl: true,
      keep_auth_on_redirect: false,
      proxy_url: "",
      client_cert_path: "",
      client_key_path: "",
      client_cert_password: "",
      ca_cert_path: "",
      cookies: [],
      max_response_bytes: 0,
      stream: false,
    },
  };
}

function response(): ApiResponse {
  return {
    status: 200,
    status_text: "OK",
    http_version: "HTTP/1.1",
    headers: [["content-type", "application/json"]],
    body_text: '{"id":1}',
    body_base64: null,
    size_bytes: 8,
    duration_ms: 5,
    timings: { dns_ms: -1, connect_ms: -1, tls_ms: -1, first_byte_ms: 1, download_ms: 1, total_ms: 5 },
    redirects: [],
    set_cookies: [],
    sent: { method: "GET", url: "https://api.example.test/v1/orders", headers: [], body_preview: "" },
    tests: [],
    consoleLines: [],
    visualizer: null,
    error: null,
  };
}

const EMPTY_SCOPES = { local: {}, data: {}, environment: [], collection: [], global: [] };

/** A script that appends its tag to the `order` environment variable. */
const append = (tag: string) =>
  `pm.environment.set("order", (pm.environment.get("order") || "") + "${tag}");`;

describe("folderChain", () => {
  it("runs from the outermost folder in", () => {
    const folders = [folder("inner", "outer", "", ""), folder("outer", null, "", ""), folder("other", null, "", "")];
    expect(folderChain(folders, "inner").map((f) => f.id)).toEqual(["outer", "inner"]);
    expect(folderChain(folders, null)).toEqual([]);
  });

  it("stops on a cyclic parent chain instead of hanging", () => {
    const folders = [folder("a", "b", "", ""), folder("b", "a", "", "")];
    expect(folderChain(folders, "a").map((f) => f.id)).toEqual(["b", "a"]);
  });
});

describe("chainScripts", () => {
  const owner: ChainOwner = {
    collection: collection("C-pre", "C-post"),
    folders: [folder("outer", null, "F1-pre", ""), folder("inner", "outer", "F2-pre", "F2-post")],
    request: { name: "List", preScript: "R-pre", postScript: "  " },
  };

  it("is collection → folders (outer → inner) → request, blanks left out", () => {
    expect(chainScripts(owner, "pre").map((ref) => ref.code)).toEqual(["C-pre", "F1-pre", "F2-pre", "R-pre"]);
    expect(chainScripts(owner, "post").map((ref) => [ref.level, ref.owner])).toEqual([
      ["collection", "Orders API"],
      ["folder", "inner"],
    ]);
  });

  it("gives an unfiled request only its own scripts", () => {
    const loose: ChainOwner = { collection: null, folders: [], request: { name: "Scratch", preScript: "x()", postScript: "" } };
    expect(chainScripts(loose, "pre")).toEqual([
      { level: "request", phase: "pre", owner: "Scratch", collectionId: null, code: "x()" },
    ]);
  });
});

describe("runScriptChain", () => {
  const owner: ChainOwner = {
    collection: collection(append("C"), append("c")),
    folders: [folder("outer", null, append("F1"), append("f1")), folder("inner", "outer", append("F2"), "")],
    request: { name: "List", preScript: append("R"), postScript: append("r") },
  };

  const order = (scopes: { environment: { key: string; currentValue: string }[] }) =>
    scopes.environment.find((variable) => variable.key === "order")?.currentValue;

  it("runs Postman's order with the scopes flowing from each script into the next", async () => {
    const sent = request();
    const pre = await runScriptChain(chainScripts(owner, "pre"), { request: sent, scopes: EMPTY_SCOPES });
    expect(pre.errors).toEqual([]);
    expect(order(pre.scopes)).toBe("CF1F2R");

    const post = await runScriptChain(chainScripts(owner, "post"), {
      request: sent,
      response: response(),
      scopes: pre.scopes,
    });
    expect(order(post.scopes)).toBe("CF1F2Rcf1r");
  });

  it("shares one request: a header the collection adds is on the wire and seen by the request's script", async () => {
    const sent = request();
    const refs = chainScripts(
      {
        collection: collection('pm.request.headers.upsert("X-Trace", "from-collection");', ""),
        folders: [],
        request: {
          name: "List",
          preScript: 'pm.environment.set("seen", pm.request.headers.get("X-Trace"));',
          postScript: "",
        },
      },
      "pre",
    );
    const outcome = await runScriptChain(refs, { request: sent, scopes: EMPTY_SCOPES });
    expect(sent.headers).toEqual([["X-Trace", "from-collection"]]);
    expect(outcome.scopes.environment.find((v) => v.key === "seen")?.currentValue).toBe("from-collection");
  });

  it("keeps going past a script that throws — unless told to stop — and says which one it was", async () => {
    const refs = chainScripts(
      {
        collection: collection('throw new Error("collection is broken");', ""),
        folders: [],
        request: { name: "List", preScript: append("R"), postScript: "" },
      },
      "pre",
    );
    const lenient = await runScriptChain(refs, { request: request(), scopes: EMPTY_SCOPES });
    expect(lenient.errors.map((entry) => entry.ref.level)).toEqual(["collection"]);
    expect(lenient.errors[0].error).toContain("collection is broken");
    expect(order(lenient.scopes)).toBe("R");

    const strict = await runScriptChain(refs, { request: request(), scopes: EMPTY_SCOPES }, { stopOnError: true });
    expect(strict.errors).toHaveLength(1);
    expect(order(strict.scopes)).toBeUndefined();
  });

  it("collects every script's tests, in order, and the last setNextRequest wins", async () => {
    const refs = chainScripts(
      {
        collection: collection("", 'pm.test("collection check", () => {}); postman.setNextRequest("A");'),
        folders: [],
        request: {
          name: "List",
          preScript: "",
          postScript: 'pm.test("request check", () => { pm.expect(pm.response.code).to.equal(200); }); postman.setNextRequest("B");',
        },
      },
      "post",
    );
    const outcome = await runScriptChain(refs, { request: request(), response: response(), scopes: EMPTY_SCOPES });
    expect(outcome.tests.map((test) => [test.name, test.passed])).toEqual([
      ["collection check", true],
      ["request check", true],
    ]);
    expect(outcome.nextRequest).toBe("B");
  });
});
