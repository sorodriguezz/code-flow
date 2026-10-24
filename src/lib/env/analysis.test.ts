import { describe, expect, it } from "vitest";
import { buildGroups, filterRows, problemCount, sortSources, springEnvName, usageReport } from "./analysis";
import { addFile, addPattern, ignoreFile, parseGlobalConfig, parseRepoConfig, removePattern, setEnvironment, emptyRepoConfig } from "./config";
import type { EnvEntry, EnvRead, EnvScan, EnvSource } from "../tauri/envCommands";

const entry = (key: string, opts: Partial<EnvEntry> = {}): EnvEntry => ({ key, line: 1, empty: false, reference: null, refused: null, ...opts });

function source(path: string, environment: string, entries: EnvEntry[], extra: Partial<EnvSource> = {}): EnvSource {
  return {
    id: path,
    path,
    sub: null,
    format: "dotenv",
    group: "|dotenv",
    dir: "",
    family: "dotenv",
    environment,
    environmentAuto: environment,
    example: environment === "example",
    entries,
    ...extra,
  };
}

function scanOf(sources: EnvSource[]): EnvScan {
  return {
    files: [],
    sources,
    config: { patterns: [], exclude: [], files: [], ignore: [], environments: {} },
    invalidPatterns: [],
    truncated: false,
  };
}

const read = (key: string, kind: EnvRead["kind"] = "env", path = "src/a.ts", hasDefault = false): EnvRead => ({
  key,
  kind,
  hasDefault,
  places: [{ path, line: 1 }],
  count: 1,
});

describe("the comparison table", () => {
  const scan = scanOf([
    source(".env", "base", [entry("A"), entry("B", { empty: true }), entry("ONLY_HERE")]),
    source(".env.production", "prod", [entry("A"), entry("B"), entry("SECRET", { reference: "id1" })]),
    source(".env.example", "example", [entry("A", { empty: true }), entry("B", { empty: true }), entry("TEMPLATE_ONLY", { empty: true })]),
  ]);

  it("puts the example first and finds every kind of problem", () => {
    const [group] = buildGroups(scan);
    expect(group.sources.map((s) => s.id)).toEqual([".env.example", ".env", ".env.production"]);
    const byKey = Object.fromEntries(group.rows.map((r) => [r.key, r]));
    expect(byKey.A.problems).toEqual([]);
    expect(byKey.B.problems).toEqual(["empty"]);
    expect(byKey.ONLY_HERE.problems).toEqual(["notInExample", "onlyOne"]);
    expect(byKey.ONLY_HERE.missingIn).toEqual([".env.production"]);
    expect(byKey.SECRET.cells[".env.production"].state).toBe("reference");
    expect(byKey.SECRET.cells[".env"].state).toBe("missing");
    expect(byKey.TEMPLATE_ONLY.problems).toEqual(["missing"]);
    expect(byKey.TEMPLATE_ONLY.missingIn).toEqual([".env", ".env.production"]);
    // An empty value in the template is how a template is written — not a problem.
    expect(byKey.A.cells[".env.example"].state).toBe("empty");
    expect(problemCount([group])).toBe(4);
  });

  // Rows follow the columns: the template's order first, then what only the other files add.
  it("filters by problems and by name", () => {
    const [group] = buildGroups(scan);
    expect(filterRows(group.rows, "", true).map((r) => r.key)).toEqual(["B", "TEMPLATE_ONLY", "ONLY_HERE", "SECRET"]);
    expect(filterRows(group.rows, "only", false).map((r) => r.key)).toEqual(["TEMPLATE_ONLY", "ONLY_HERE"]);
  });

  it("compares only within a group", () => {
    const groups = buildGroups(
      scanOf([
        source(".env", "base", [entry("A")]),
        source("api/appsettings.json", "base", [entry("Jwt:Key")], { group: "api|dotnet", dir: "api", family: "dotnet", format: "appsettings" }),
      ]),
    );
    expect(groups.map((g) => g.id)).toEqual(["|dotenv", "api|dotnet"]);
    expect(groups.every((g) => g.rows.every((r) => r.problems.length === 0))).toBe(true);
  });

  it("orders columns the way code travels", () => {
    const sorted = sortSources([source("p", "prod", []), source("l", "local", []), source("x", "custom", []), source("d", "dev.local", [])]);
    expect(sorted.map((s) => s.environment)).toEqual(["local", "dev.local", "prod", "custom"]);
  });
});

describe("what the code reads", () => {
  it("flags reads the example does not list, and reads nothing defines", () => {
    const scan = scanOf([
      source(".env", "base", [entry("DB_URL"), entry("UNUSED")]),
      source(".env.example", "example", [entry("DB_URL", { empty: true })]),
    ]);
    const report = usageReport(scan, {
      reads: [read("DB_URL"), read("UNUSED_NOT"), read("API_TOKEN"), read("WITH_DEFAULT", "env", "a.py", true), read("PORT")],
      filesScanned: 3,
      truncated: false,
    });
    expect(report.findings.map((f) => [f.read.key, f.problem, f.example])).toEqual([
      ["API_TOKEN", "undefined", ".env.example"],
      ["PORT", "undefined", ".env.example"],
      ["UNUSED_NOT", "undefined", ".env.example"],
    ]);
    expect(report.leftovers).toEqual([{ key: "UNUSED", paths: [".env"] }]);
    expect(report.noExample).toBe(false);
  });

  it("a key set in the env file but missing from the example is notInExample", () => {
    const scan = scanOf([source(".env", "base", [entry("K")]), source(".env.example", "example", [])]);
    const report = usageReport(scan, { reads: [read("K")], filesScanned: 1, truncated: false });
    expect(report.findings.map((f) => f.problem)).toEqual(["notInExample"]);
  });

  it("says when there is no example at all", () => {
    const report = usageReport(scanOf([source(".env", "base", [entry("K")])]), { reads: [read("K")], filesScanned: 1, truncated: false });
    expect(report.noExample).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it("checks .NET and Spring keys against their own files", () => {
    const scan = scanOf([
      source("api/appsettings.json", "base", [entry("ConnectionStrings:Default"), entry("Smtp:Host")], { group: "api|dotnet", dir: "api", family: "dotnet", format: "appsettings" }),
      source("svc/application.yml", "base", [entry("app.max-size")], { group: "svc|spring", dir: "svc", family: "spring", format: "yaml" }),
    ]);
    const report = usageReport(scan, {
      reads: [read("Default", "dotnet"), read("Smtp", "dotnetSection"), read("Jwt:Key", "dotnet"), read("app.maxSize", "spring"), read("app.missing", "spring")],
      filesScanned: 2,
      truncated: false,
    });
    expect(report.findings.map((f) => f.read.key)).toEqual(["app.missing", "Jwt:Key"]);
  });

  it("spells Spring's environment override the way the injector does", () => {
    expect(springEnvName("spring.datasource.password")).toBe("SPRING_DATASOURCE_PASSWORD");
    expect(springEnvName("my-app.list[0]")).toBe("MYAPP_LIST_0_");
  });
});

describe("the detected-files settings", () => {
  const defaults = [".env", ".env.*", "appsettings.json"];

  it("records changes, not a copy of the defaults", () => {
    let config = emptyRepoConfig();
    config = removePattern(config, "appsettings.json");
    config = addPattern(config, "config/*.env", defaults);
    expect(config.remove).toEqual(["appsettings.json"]);
    expect(config.add).toEqual(["config/*.env"]);
    config = addPattern(config, "appsettings.json", defaults);
    expect(config.remove).toEqual([]);
    config = removePattern(config, "config/*.env");
    expect(config.add).toEqual([]);
    expect(addPattern(config, ".env", defaults)).toEqual(config);
  });

  it("adds, ignores and renames files", () => {
    let config = addFile(emptyRepoConfig(), ".\\conf\\local.env");
    expect(config.files).toEqual(["conf/local.env"]);
    config = ignoreFile(config, "conf/local.env");
    expect(config.files).toEqual([]);
    expect(config.ignore).toEqual(["conf/local.env"]);
    config = setEnvironment(config, ".env", "Local", "base");
    expect(config.environments).toEqual({ ".env": "local" });
    config = setEnvironment(config, ".env", "base", "base");
    expect(config.environments).toEqual({});
  });

  it("reads malformed rows as nothing", () => {
    expect(parseRepoConfig("{oops")).toEqual(emptyRepoConfig());
    expect(parseRepoConfig('{"add":["a",1],"environments":{"x":"dev","y":2}}')).toEqual({ ...emptyRepoConfig(), add: ["a"], environments: { x: "dev" } });
    expect(parseGlobalConfig(null)).toEqual({ patterns: null, exclude: null });
    expect(parseGlobalConfig('{"patterns":[".env"]}')).toEqual({ patterns: [".env"], exclude: null });
  });
});
