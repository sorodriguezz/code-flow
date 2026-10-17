import { describe, expect, it } from "vitest";
import { detectFormat, importAny, inlineFileVariables, parseHttpFile } from "./importers";

const FILE = `@baseUrl = https://api.example.com
@token = abc123

### List users
GET {{baseUrl}}/users?limit=10 HTTP/1.1
Authorization: Bearer {{token}}

###
# @name createUser
POST {{baseUrl}}/users
Content-Type: application/json

{
  "name": "Ana"
}

> {% client.global.set("id", response.body.id); %}

### Login
POST https://api.example.com/login
Content-Type: application/x-www-form-urlencoded

user=ana&pass=secret
`;

describe(".http files", () => {
  it("is recognised", () => {
    expect(detectFormat(FILE)).toBe("http");
    expect(detectFormat("GET https://api.example.com/health")).toBe("http");
    expect(detectFormat('{"openapi":"3.0.0"}')).not.toBe("http");
  });

  it("reads requests, names, headers, bodies and variables", () => {
    const warnings: string[] = [];
    const { requests, variables } = parseHttpFile(FILE, warnings);
    expect(variables.map((v) => [v.key, v.currentValue])).toEqual([
      ["baseUrl", "https://api.example.com"],
      ["token", "abc123"],
    ]);
    expect(requests.map((r) => [r.name, r.spec.method, r.line])).toEqual([
      ["List users", "GET", 4],
      ["createUser", "POST", 9],
      ["Login", "POST", 19],
    ]);
    const [list, create, login] = requests;
    expect(list.spec.url).toBe("{{baseUrl}}/users");
    expect(list.spec.params.map((p) => [p.key, p.value])).toEqual([["limit", "10"]]);
    expect(list.spec.headers.map((h) => [h.key, h.value])).toEqual([["Authorization", "Bearer {{token}}"]]);
    expect(create.spec.body.mode).toBe("raw");
    expect(create.spec.body.rawLanguage).toBe("json");
    expect(JSON.parse(create.spec.body.raw)).toEqual({ name: "Ana" });
    expect(login.spec.body.mode).toBe("urlencoded");
    expect(login.spec.body.urlencoded.map((r) => r.key)).toEqual(["user", "pass"]);
    expect(warnings.some((w) => w.includes("handler"))).toBe(true);
  });

  it("imports as one collection carrying the file's variables", async () => {
    const result = await importAny(FILE);
    expect(result.format).toBe("http");
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0].items).toHaveLength(3);
    expect(result.collections[0].variables).toHaveLength(2);
  });

  it("writes the file's own variables into a request, leaving the environment's", () => {
    const { requests, variables } = parseHttpFile(FILE);
    const inlined = inlineFileVariables(requests[0].spec, variables);
    expect(inlined.url).toBe("https://api.example.com/users");
    expect(inlined.headers[0].value).toBe("Bearer abc123");
    const other = inlineFileVariables(requests[0].spec, []);
    expect(other.url).toBe("{{baseUrl}}/users");
  });
});
