import { describe, expect, it } from "vitest";
import { declaredTypeOf, memberReceiver, rankDefinitions } from "./definitions";

describe("memberReceiver", () => {
  const line = "    const newCapa = await this._repositorio.create(data);";
  it("reads the object a member is reached through", () => {
    expect(memberReceiver(line, line.indexOf("create") + 1)).toBe("_repositorio");
  });
  it("answers this for a member of the class itself", () => {
    const own = "    return this.create(data);";
    expect(memberReceiver(own, own.indexOf("create") + 1)).toBe("this");
  });
  it("answers null for a bare name", () => {
    const bare = "    create(data);";
    expect(memberReceiver(bare, bare.indexOf("create") + 1)).toBeNull();
  });
  it("follows optional chaining", () => {
    const opt = "repo?.create(x)";
    expect(memberReceiver(opt, opt.indexOf("create") + 1)).toBe("repo");
  });
});

describe("declaredTypeOf", () => {
  it("reads a constructor parameter property", () => {
    expect(declaredTypeOf("constructor(private readonly _repositorio: CapaRepository) {}", "_repositorio")).toBe(
      "CapaRepository",
    );
  });
  it("reads a field and keeps only the head of a generic", () => {
    expect(declaredTypeOf("  private repo!: Repository<Capa>;", "repo")).toBe("Repository");
  });
  it("reads a construction", () => {
    expect(declaredTypeOf("const api = new ApiClient(url);", "api")).toBe("ApiClient");
  });
  it("ignores primitives and member look-alikes", () => {
    expect(declaredTypeOf("const name: string = x;", "name")).toBeNull();
    expect(declaredTypeOf("this.repo: Foo", "repo")).toBeNull();
  });
});

describe("rankDefinitions for a foreign member", () => {
  const hits = [
    { path: "src/capa/capa.service.ts", line: 12, text: "  public async create(data: CreateCapa): Promise<Capa> {" },
    { path: "src/capa/capa.repository.interface.ts", line: 8, text: "  public abstract create(data: CreateCapa): Promise<Capa>;" },
    { path: "src/capa/capa.repository.ts", line: 20, text: "  public async create(data: CreateCapa): Promise<Capa> {" },
  ];
  it("prefers the receiver type's file over the same-named method here", () => {
    const ranked = rankDefinitions(hits, {
      symbol: "create",
      fromPath: "src/capa/capa.service.ts",
      fromLine: 19,
      importedFrom: "src/capa/capa.repository.interface.ts",
      foreignMember: true,
    });
    expect(ranked[0].path).toBe("src/capa/capa.repository.interface.ts");
    expect(ranked[ranked.length - 1].path).toBe("src/capa/capa.service.ts");
  });
  it("still puts the class's own member first for this.create", () => {
    const ranked = rankDefinitions(hits, {
      symbol: "create",
      fromPath: "src/capa/capa.service.ts",
      fromLine: 30,
      importedFrom: null,
    });
    expect(ranked[0].path).toBe("src/capa/capa.service.ts");
  });
});
