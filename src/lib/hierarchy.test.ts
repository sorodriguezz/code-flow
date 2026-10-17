import { describe, expect, it, vi } from "vitest";

vi.mock("./tauri/codemapCommands", () => ({ codemapFind: vi.fn(), codemapOutline: vi.fn() }));
vi.mock("./tauri/commands", () => ({ readFileText: vi.fn(), searchRepo: vi.fn() }));

const { heritageNames } = await import("./hierarchy");

describe("heritageNames", () => {
  it("reads extends/implements, Python bases and colon lists", () => {
    expect(heritageNames("export class Repo<T> extends Base<T> implements Store, Closeable {", "Repo")).toEqual(["Base", "Store", "Closeable"]);
    expect(heritageNames("class Api(BaseApi, metaclass=Meta):", "Api")).toEqual(["BaseApi", "Meta"]);
    expect(heritageNames("public class Service : IService, IDisposable {", "Service")).toEqual(["IService", "IDisposable"]);
    expect(heritageNames("interface Shape {", "Shape")).toEqual([]);
  });
});
