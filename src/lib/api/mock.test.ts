import { describe, expect, it } from "vitest";
import { defaultRequestSpec, type ImportResult, type SavedExample } from "../../types/api";
import {
  isSensitiveHeader,
  maskValue,
  mergeRoutes,
  mockPathOf,
  newRoute,
  routeFromLog,
  routeFromRequest,
  routesFromImport,
  variantsFromExamples,
} from "./mock";

const variable = (key: string, value: string) => ({ key, initialValue: value, currentValue: "" });

const example = (status: number, body: string): SavedExample => ({
  id: String(status),
  name: String(status),
  status,
  statusText: "",
  headers: [
    { id: "h1", key: "Content-Type", value: "application/json", description: "", enabled: true },
    { id: "h2", key: "Content-Length", value: "99", description: "", enabled: true },
  ],
  body,
});

describe("mockPathOf", () => {
  it("reduces URLs and templates to a path", () => {
    expect(mockPathOf("{{baseUrl}}/users/:id?x=1")).toBe("/users/:id");
    expect(mockPathOf("https://api.example.com/v1/users/{id}")).toBe("/v1/users/:id");
    expect(mockPathOf("{{baseUrl}}/orders/{{orderId}}/items")).toBe("/orders/:orderId/items");
    expect(mockPathOf("{{baseUrl}}")).toBe("/");
  });

  it("keeps the path a base-URL variable carries", () => {
    expect(mockPathOf("{{baseUrl}}/pets", [variable("baseUrl", "https://api.example.com/v2/")])).toBe("/v2/pets");
  });
});

describe("variantsFromExamples", () => {
  it("puts the first 2xx last as the default and keys the rest on Prefer", () => {
    const variants = variantsFromExamples([example(404, "{}"), example(200, '{"ok":true}'), example(500, "")]);
    expect(variants.map((v) => v.status)).toEqual([404, 500, 200]);
    expect(variants[0]).toMatchObject({ matchKind: "header", matchKey: "Prefer", matchValue: "code=404" });
    expect(variants[2].matchKind).toBe("always");
    expect(variants[2].headers.map((h) => h.key)).toEqual(["Content-Type"]);
  });
});

describe("routeFromRequest", () => {
  it("falls back to the last response, then to an empty object", () => {
    const spec = { ...defaultRequestSpec("http"), method: "post", url: "{{baseUrl}}/things" };
    const fromHistory = routeFromRequest(
      {
        id: "r1",
        name: "Create",
        spec,
        lastResponse: { status: 201, headers: [["X-Id", "7"]], body_text: '{"id":7}', error: null } as never,
      },
      [],
    );
    expect(fromHistory).toMatchObject({ method: "POST", path: "/things", requestId: "r1", source: "request" });
    expect(fromHistory.variants[0]).toMatchObject({ status: 201, body: '{"id":7}' });
    const bare = routeFromRequest({ id: "r2", name: "x", spec }, []);
    expect(bare.variants[0].body).toBe("{}");
  });
});

describe("routesFromImport", () => {
  it("walks folders and keeps only HTTP requests", () => {
    const spec = { ...defaultRequestSpec("http"), url: "{{baseUrl}}/pets/:petId", examples: [example(200, "{}")] };
    const result: ImportResult = {
      format: "openapi",
      environments: [],
      warnings: [],
      collections: [
        {
          name: "Pets",
          description: "",
          auth: null,
          variables: [{ id: "v", key: "baseUrl", initialValue: "https://h.example.com/api", currentValue: "", secret: false, enabled: true, description: "" }],
          preScript: "",
          postScript: "",
          items: [
            {
              kind: "folder",
              name: "pets",
              description: "",
              auth: null,
              preScript: "",
              postScript: "",
              items: [
                { kind: "request", name: "Get pet", spec },
                { kind: "request", name: "Socket", spec: defaultRequestSpec("websocket") },
              ],
            },
          ],
        },
      ],
    };
    const routes = routesFromImport(result);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({ path: "/api/pets/:petId", source: "openapi" });
  });
});

describe("mergeRoutes", () => {
  it("never replaces a route already there", () => {
    const kept = newRoute({ method: "GET", path: "/users/:id", requestId: "a", name: "edited" });
    const { routes, added } = mergeRoutes(
      [kept],
      [
        newRoute({ method: "GET", path: "/users/:userId" }),
        newRoute({ requestId: "a", path: "/other" }),
        newRoute({ method: "POST", path: "/users" }),
      ],
    );
    expect(added).toBe(1);
    expect(routes[0]).toBe(kept);
    expect(routes[1].method).toBe("POST");
  });
});

describe("log helpers", () => {
  it("builds a route from a call and masks credentials", () => {
    const route = routeFromLog({ method: "patch", path: "/a/b" } as never);
    expect(route).toMatchObject({ method: "PATCH", path: "/a/b", source: "log" });
    expect(isSensitiveHeader("Authorization")).toBe(true);
    expect(isSensitiveHeader("x-refresh-token")).toBe(true);
    expect(isSensitiveHeader("Accept")).toBe(false);
    expect(maskValue("Bearer abc")).not.toContain("abc");
  });
});
