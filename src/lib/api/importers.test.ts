import { describe, expect, it } from "vitest";
import { detectFormat, importAny, importBrunoFolder, parseBru } from "./importers";
import { buildImportPayload } from "./importPayload";
import type { ApiRequestSpec, ImportedItem, ImportResult } from "../../types/api";

/** Depth-first: every request in a tree, by name. */
function requests(items: ImportedItem[]): Map<string, ApiRequestSpec> {
  const out = new Map<string, ApiRequestSpec>();
  const walk = (list: ImportedItem[]) => {
    for (const item of list) {
      if (item.kind === "request") out.set(item.name, item.spec);
      else walk(item.items);
    }
  };
  walk(items);
  return out;
}

function only<T>(list: T[]): T {
  expect(list).toHaveLength(1);
  return list[0];
}

const header = (spec: ApiRequestSpec, name: string) =>
  spec.headers.find((row) => row.key.toLowerCase() === name.toLowerCase());

// ---------------------------------------------------------------------------

describe("Postman v2.1", () => {
  const doc = JSON.stringify({
    info: { name: "Orders", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
    auth: { type: "bearer", bearer: [{ key: "token", value: "{{token}}" }] },
    event: [{ listen: "prerequest", script: { exec: ["pm.environment.set('a', '1');"] } }],
    variable: [{ key: "baseUrl", value: "https://api.example.test" }],
    item: [
      {
        name: "v1",
        event: [{ listen: "test", script: { exec: ["pm.test('folder', () => {});"] } }],
        item: [
          {
            name: "List orders",
            request: {
              method: "GET",
              header: [{ key: "Accept", value: "application/json" }],
              url: {
                raw: "{{baseUrl}}/v1/orders?page=1",
                host: ["{{baseUrl}}"],
                path: ["v1", "orders"],
                query: [{ key: "page", value: "1" }],
              },
            },
            event: [{ listen: "test", script: { exec: ["pm.test('ok', () => {", "  pm.response.to.have.status(200);", "});"] } }],
            response: [{ name: "OK", code: 200, status: "OK", header: [], body: "[]" }],
          },
          {
            name: "Create order",
            request: {
              method: "POST",
              url: "{{baseUrl}}/v1/orders",
              body: { mode: "raw", raw: '{"sku":"A1"}', options: { raw: { language: "json" } } },
            },
          },
        ],
      },
    ],
  });

  it("maps collection, folder and request with their scripts, auth and variables", async () => {
    expect(detectFormat(doc)).toBe("postman");
    const result = await importAny(doc);
    const collection = only(result.collections);
    expect(collection.name).toBe("Orders");
    expect(collection.auth?.type).toBe("bearer");
    expect(collection.auth?.bearer.token).toBe("{{token}}");
    expect(collection.preScript).toBe("pm.environment.set('a', '1');");
    expect(collection.variables.map((v) => [v.key, v.initialValue])).toEqual([["baseUrl", "https://api.example.test"]]);

    const folder = only(collection.items);
    expect(folder.kind === "folder" && folder.postScript).toBe("pm.test('folder', () => {});");

    const list = requests(collection.items).get("List orders");
    expect(list?.url).toBe("{{baseUrl}}/v1/orders");
    expect(list?.params.map((p) => [p.key, p.value])).toEqual([["page", "1"]]);
    expect(list?.postScript).toContain("pm.response.to.have.status(200)");
    expect(list?.examples).toHaveLength(1);

    const create = requests(collection.items).get("Create order");
    expect(create?.body.mode).toBe("raw");
    expect(create?.body.rawLanguage).toBe("json");
  });
});

// ---------------------------------------------------------------------------

describe("Insomnia v4", () => {
  const doc = JSON.stringify({
    _type: "export",
    __export_format: 4,
    resources: [
      { _id: "wrk_1", _type: "workspace", name: "Orders" },
      { _id: "env_1", _type: "environment", parentId: "wrk_1", name: "Base", data: { baseUrl: "https://api.example.test" } },
      { _id: "fld_1", _type: "request_group", parentId: "wrk_1", name: "v1", metaSortKey: 1 },
      {
        _id: "req_1",
        _type: "request",
        parentId: "fld_1",
        name: "List orders",
        method: "GET",
        url: "{{ _.baseUrl }}/v1/orders",
        headers: [{ name: "Accept", value: "application/json" }],
        parameters: [{ name: "page", value: "1" }],
        authentication: { type: "bearer", token: "{{ _.token }}" },
        body: {},
        metaSortKey: 1,
      },
    ],
  });

  it("maps the flat resource list into a tree and converts {{ _.var }} templates", async () => {
    expect(detectFormat(doc)).toBe("insomnia");
    const result = await importAny(doc);
    const list = requests(only(result.collections).items).get("List orders");
    expect(list?.url).toBe("{{baseUrl}}/v1/orders");
    expect(list?.auth.bearer.token).toBe("{{token}}");
    expect(list?.params.map((p) => p.key)).toEqual(["page"]);
    expect(only(result.environments).variables[0].initialValue).toBe("https://api.example.test");
  });
});

// ---------------------------------------------------------------------------

describe("Insomnia v5", () => {
  const yaml = `type: collection.insomnia.rest/5.0
name: Orders
meta:
  id: wrk_1
  description: Orders service
collection:
  - name: v1
    meta:
      id: fld_1
      sortKey: 1
    headers:
      - name: X-Tenant
        value: demo
      - name: X-Trace
        value: on
    scripts:
      preRequest: insomnia.environment.set("a", "1");
    children:
      - url: "{{ _.baseUrl }}/v1/orders/:orderId"
        name: Get order
        meta:
          id: req_2
          sortKey: 2
        method: GET
        pathParameters:
          - name: orderId
            value: "42"
      - url: "{{ _.baseUrl }}/v1/orders"
        name: Create order
        meta:
          id: req_1
          sortKey: 1
        method: POST
        body:
          mimeType: application/json
          text: |-
            {"sku": "A1"}
        headers:
          - name: X-Tenant
            value: override
        scripts:
          afterResponse: insomnia.test("created", () => {});
        settings:
          followRedirects: "off"
  - url: wss://api.example.test/ws
    name: Live feed
    meta:
      id: ws-req_1
      sortKey: 3
environments:
  name: Base Environment
  meta:
    id: env_1
  data:
    baseUrl: https://api.example.test
    region: eu
  subEnvironments:
    - name: Staging
      meta:
        id: env_2
      data:
        baseUrl: https://staging.api.example.test
`;

  it("is recognised from the YAML itself", () => {
    expect(detectFormat(yaml)).toBe("insomnia");
  });

  it("maps the nested collection, in sortKey order, with folder headers copied down", async () => {
    const result = await importAny(yaml);
    const collection = only(result.collections);
    expect(collection.name).toBe("Orders");
    expect(collection.description).toBe("Orders service");

    const [folder, feed] = collection.items;
    expect(folder.kind).toBe("folder");
    if (folder.kind !== "folder") return;
    expect(folder.preScript).toBe('insomnia.environment.set("a", "1");');
    expect(folder.items.map((item) => item.name)).toEqual(["Create order", "Get order"]);

    const all = requests(collection.items);
    const create = all.get("Create order");
    expect(create?.url).toBe("{{baseUrl}}/v1/orders");
    expect(create?.body.mode).toBe("raw");
    expect(create?.body.raw).toBe('{"sku": "A1"}');
    expect(create?.postScript).toBe('insomnia.test("created", () => {});');
    expect(create?.settings.followRedirects).toBe(false);
    // The request's own header wins over the folder's; the other folder header is inherited.
    expect(create?.headers.filter((h) => h.key === "X-Tenant").map((h) => h.value)).toEqual(["override"]);
    expect(header(create!, "X-Trace")?.value).toBe("on");

    expect(all.get("Get order")?.pathVars.map((p) => [p.key, p.value])).toEqual([["orderId", "42"]]);
    expect(feed.kind === "request" && feed.spec.protocol).toBe("websocket");
  });

  it("merges the base environment under each sub-environment", async () => {
    const result = await importAny(yaml);
    const staging = only(result.environments);
    expect(staging.name).toBe("Staging");
    expect(Object.fromEntries(staging.variables.map((v) => [v.key, v.initialValue]))).toEqual({
      baseUrl: "https://staging.api.example.test",
      region: "eu",
    });
  });
});

// ---------------------------------------------------------------------------

const COLLECTION_BRU = `headers {
  X-Client: codeflow-tests
}

auth {
  mode: bearer
}

auth:bearer {
  token: {{token}}
}

vars:pre-request {
  baseUrl: https://api.example.test
}

script:pre-request {
  bru.setVar("started", Date.now());
}
`;

const LIST_BRU = `meta {
  name: List orders
  type: http
  seq: 2
}

get {
  url: {{baseUrl}}/v1/orders?page=1
  body: none
  auth: inherit
}

params:query {
  page: 1
  ~limit: 10
}

headers {
  Accept: application/json
}

tests {
  test("ok", function() {
    expect(res.status).to.equal(200);
  });
}
`;

const CREATE_BRU = `meta {
  name: Create order
  type: http
  seq: 1
}

post {
  url: {{baseUrl}}/v1/orders
  body: json
  auth: apikey
}

auth:apikey {
  key: x-api-key
  value: {{apiKey}}
  placement: header
}

body:json {
  {
    "sku": "A1",
    "note": "braces } inside"
  }
}

assert {
  res.status: eq 201
}
`;

const GRAPHQL_BRU = `meta {
  name: Get order
  type: graphql
  seq: 1
}

post {
  url: {{baseUrl}}/graphql
  body: graphql
  auth: none
}

body:graphql {
  query Order($id: ID!) {
    order(id: $id) { id }
  }
}

body:graphql:vars {
  {"id": "42"}
}
`;

describe("Bruno .bru files", () => {
  it("parses blocks, keeps a JSON body's own braces and indentation, and reads disabled rows", () => {
    const blocks = parseBru(CREATE_BRU);
    const body = blocks.get("body:json");
    expect(body).toEqual({ kind: "text", text: '{\n  "sku": "A1",\n  "note": "braces } inside"\n}' });
    const query = parseBru(LIST_BRU).get("params:query");
    expect(query).toEqual({
      kind: "dict",
      entries: [
        { key: "page", value: "1", enabled: true },
        { key: "limit", value: "10", enabled: false },
      ],
    });
  });

  it("imports a collection folder: settings, folders by seq, environments with secrets", () => {
    const result: ImportResult = importBrunoFolder(
      [
        { path: "bruno.json", text: '{"version":"1","name":"Orders","type":"collection"}' },
        { path: "collection.bru", text: COLLECTION_BRU },
        {
          path: "environments/Local.bru",
          text: "vars {\n  baseUrl: http://localhost:3000\n  ~unused: x\n}\nvars:secret [\n  token\n]\n",
        },
        { path: "v1/folder.bru", text: "meta {\n  name: Version 1\n  seq: 1\n}\n\nauth {\n  mode: inherit\n}\n" },
        { path: "v1/List orders.bru", text: LIST_BRU },
        { path: "v1/Create order.bru", text: CREATE_BRU },
        { path: "v1/nested/Get order.bru", text: GRAPHQL_BRU },
      ],
      "orders-folder",
    );

    expect(result.format).toBe("bruno");
    const collection = only(result.collections);
    expect(collection.name).toBe("Orders");
    expect(collection.auth?.type).toBe("bearer");
    expect(collection.auth?.bearer.token).toBe("{{token}}");
    expect(collection.preScript).toContain("bru.setVar");
    expect(collection.variables.map((v) => v.key)).toEqual(["baseUrl"]);

    const version = only(collection.items);
    expect(version.kind === "folder" && version.name).toBe("Version 1");
    if (version.kind !== "folder") return;
    // Folders first, then requests by seq.
    expect(version.items.map((item) => item.name)).toEqual(["nested", "Create order", "List orders"]);

    const all = requests(collection.items);
    const list = all.get("List orders")!;
    expect(list.url).toBe("{{baseUrl}}/v1/orders");
    expect(list.params.map((p) => [p.key, p.enabled])).toEqual([
      ["page", true],
      ["limit", false],
    ]);
    expect(list.postScript).toContain("expect(res.status)");
    expect(list.auth.type).toBe("inherit");
    // The collection's header reaches every request.
    expect(header(list, "X-Client")?.value).toBe("codeflow-tests");

    const create = all.get("Create order")!;
    expect(create.auth.apikey).toEqual({ key: "x-api-key", value: "{{apiKey}}", addTo: "header" });
    expect(JSON.parse(create.body.raw)).toEqual({ sku: "A1", note: "braces } inside" });

    const graphql = all.get("Get order")!;
    expect(graphql.protocol).toBe("graphql");
    expect(graphql.body.graphql.query).toContain("order(id: $id)");
    expect(graphql.body.graphql.variables).toBe('{"id": "42"}');

    const local = only(result.environments);
    expect(local.name).toBe("Local");
    expect(local.variables.map((v) => [v.key, v.enabled, v.secret])).toEqual([
      ["baseUrl", true, false],
      ["unused", false, false],
      ["token", true, true],
    ]);

    expect(result.warnings.some((w) => w.includes("Assertions"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("bru, req, res"))).toBe(true);
  });

  it("takes a single .bru pasted on its own", async () => {
    expect(detectFormat(LIST_BRU)).toBe("bruno");
    const result = await importAny(LIST_BRU);
    expect([...requests(only(result.collections).items).keys()]).toEqual(["List orders"]);
  });
});

describe("Bruno JSON export", () => {
  const doc = JSON.stringify({
    name: "Orders",
    version: "1",
    items: [
      {
        type: "folder",
        name: "v1",
        seq: 1,
        root: { request: { headers: [{ name: "X-Tenant", value: "demo", enabled: true }], auth: { mode: "inherit" } } },
        items: [
          {
            type: "http-request",
            name: "List orders",
            seq: 1,
            request: {
              url: "{{baseUrl}}/v1/orders",
              method: "GET",
              headers: [],
              params: [
                { name: "page", value: "1", type: "query", enabled: true },
                { name: "orderId", value: "7", type: "path", enabled: true },
              ],
              body: { mode: "none" },
              auth: { mode: "bearer", bearer: { token: "{{token}}" } },
              script: { req: "", res: "" },
              tests: "",
              docs: "Lists orders.",
            },
          },
          { type: "grpc-request", name: "Stream", seq: 2, request: {} },
        ],
      },
    ],
    environments: [
      { name: "Local", variables: [{ name: "baseUrl", value: "http://localhost:3000", enabled: true, secret: false }] },
    ],
    root: { request: { auth: { mode: "basic", basic: { username: "user", password: "pass" } } } },
    brunoConfig: { version: "1", name: "Orders", type: "collection" },
  });

  it("maps the export, its environments and the collection-level auth", async () => {
    expect(detectFormat(doc)).toBe("bruno");
    const result = await importAny(doc);
    const collection = only(result.collections);
    expect(collection.auth?.basic).toEqual({ username: "user", password: "pass" });
    const list = requests(collection.items).get("List orders")!;
    expect(list.params.map((p) => p.key)).toEqual(["page"]);
    expect(list.pathVars.map((p) => [p.key, p.value])).toEqual([["orderId", "7"]]);
    expect(list.description).toBe("Lists orders.");
    expect(header(list, "X-Tenant")?.value).toBe("demo");
    expect(only(result.environments).variables[0].key).toBe("baseUrl");
    expect(result.warnings.some((w) => w.includes("grpc-request"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("HAR", () => {
  const doc = JSON.stringify({
    log: {
      version: "1.2",
      entries: [
        {
          request: {
            method: "POST",
            url: "https://api.example.test/v1/orders?dryRun=true",
            headers: [
              { name: ":authority", value: "api.example.test" },
              { name: "Content-Type", value: "application/json" },
            ],
            queryString: [{ name: "dryRun", value: "true" }],
            postData: { mimeType: "application/json", text: '{"sku":"A1"}' },
          },
          response: {
            status: 201,
            statusText: "Created",
            headers: [],
            content: { mimeType: "application/json", text: '{"id":1}' },
          },
        },
      ],
    },
  });

  it("groups by host, drops HTTP/2 pseudo-headers and keeps the response as an example", async () => {
    expect(detectFormat(doc)).toBe("har");
    const result = await importAny(doc);
    const host = only(only(result.collections).items);
    expect(host.name).toBe("api.example.test");
    const spec = only([...requests([host]).values()]);
    expect(spec.headers.map((h) => h.key)).toEqual(["Content-Type"]);
    expect(spec.params.map((p) => [p.key, p.value])).toEqual([["dryRun", "true"]]);
    expect(spec.body.rawLanguage).toBe("json");
    expect(spec.examples.map((e) => e.status)).toEqual([201]);
  });
});

describe("cURL", () => {
  it("reads method, URL, headers and a JSON body", async () => {
    const command = `curl -X POST 'https://api.example.test/v1/orders' -H 'Content-Type: application/json' --data '{"sku":"A1"}'`;
    expect(detectFormat(command)).toBe("curl");
    const result = await importAny(command);
    const spec = only([...requests(only(result.collections).items).values()]);
    expect(spec.method).toBe("POST");
    expect(spec.url).toBe("https://api.example.test/v1/orders");
    expect(header(spec, "Content-Type")?.value).toBe("application/json");
    expect(spec.body.raw).toBe('{"sku":"A1"}');
  });
});

// ---------------------------------------------------------------------------

describe("buildImportPayload", () => {
  it("serialises to the columns' JSON, spelling inherit as an empty auth", async () => {
    const result = await importAny(
      JSON.stringify({
        info: { name: "Orders", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
        item: [
          {
            name: "v1",
            auth: { type: "noauth" },
            item: [{ name: "List", request: { method: "GET", url: "https://api.example.test/v1/orders" } }],
          },
        ],
      }),
    );
    const payload = buildImportPayload(result.format, result.collections, result.environments, "  Renamed  ");
    expect(payload.format).toBe("postman");
    const collection = only(payload.collections);
    expect(collection.name).toBe("Renamed");
    expect(collection.auth).toBe("");
    const folder = only(collection.items);
    expect(folder.kind).toBe("folder");
    if (folder.kind !== "folder") return;
    expect(JSON.parse(folder.auth).type).toBe("none");
    const request = only(folder.items);
    expect(request.kind === "request" && JSON.parse(request.spec).url).toBe("https://api.example.test/v1/orders");
    expect(request.kind === "request" && JSON.parse(request.spec).auth.type).toBe("inherit");
  });

  it("does not rename when the import holds several collections", () => {
    const empty = { description: "", auth: null, variables: [], preScript: "", postScript: "", items: [] };
    const payload = buildImportPayload("insomnia", [{ name: "A", ...empty }, { name: "B", ...empty }], [], "X");
    expect(payload.collections.map((c) => c.name)).toEqual(["A", "B"]);
  });
});
