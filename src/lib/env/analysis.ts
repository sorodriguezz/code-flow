/**
 * «Entorno»'s comparison: which variable is missing where, which is empty, which the example does
 * not list, and which the code reads without any file setting it. Pure — the scan and the code
 * reads come from Rust (`repo_env`), carrying keys only, never values.
 *
 * Files are compared within a **group**: the same folder and the same kind of file (dotenv with
 * dotenv, appsettings with appsettings, one Compose service across Compose files). A `.env` and an
 * `appsettings.json` name their keys differently and comparing them would mark everything missing.
 */

import type { EnvEntry, EnvRead, EnvScan, EnvSource, EnvUsage } from "../tauri/envCommands";

export type CellState = "present" | "empty" | "missing" | "reference";

export interface EnvCell {
  state: CellState;
  entry?: EnvEntry;
}

/** What is wrong with a row, worst first. */
export type RowProblem = "notInExample" | "missing" | "onlyOne" | "empty";

export interface EnvRow {
  key: string;
  cells: Record<string, EnvCell>;
  problems: RowProblem[];
  /** The sources (ids) a `missing` / `onlyOne` problem is about: the ones without the key. */
  missingIn: string[];
}

export interface EnvGroup {
  id: string;
  dir: string;
  family: EnvSource["family"];
  /** The Compose service, for a Compose group. */
  service: string | null;
  sources: EnvSource[];
  rows: EnvRow[];
  hasExample: boolean;
}

/** Where an environment sorts among the columns: the template first, then the way code travels. */
const ORDER = ["example", "base", "local", "dev", "test", "qa", "staging", "prod"];

function rank(environment: string): number {
  const head = environment.split(".")[0];
  const at = ORDER.indexOf(head);
  return at < 0 ? ORDER.length : at;
}

export function sortSources(sources: EnvSource[]): EnvSource[] {
  return [...sources].sort(
    (a, b) => rank(a.environment) - rank(b.environment) || a.environment.localeCompare(b.environment) || a.id.localeCompare(b.id),
  );
}

function cellOf(entry: EnvEntry | undefined): EnvCell {
  if (!entry) return { state: "missing" };
  if (entry.reference) return { state: "reference", entry };
  return { state: entry.empty ? "empty" : "present", entry };
}

export function buildGroups(scan: EnvScan): EnvGroup[] {
  const byGroup = new Map<string, EnvSource[]>();
  for (const source of scan.sources) {
    const list = byGroup.get(source.group) ?? [];
    list.push(source);
    byGroup.set(source.group, list);
  }
  const groups: EnvGroup[] = [];
  for (const [id, list] of byGroup) {
    const sources = sortSources(list);
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const source of sources)
      for (const entry of source.entries)
        if (!seen.has(entry.key)) {
          seen.add(entry.key);
          keys.push(entry.key);
        }
    const examples = sources.filter((s) => s.example);
    const real = sources.filter((s) => !s.example);
    const rows: EnvRow[] = keys.map((key) => {
      const cells: Record<string, EnvCell> = {};
      for (const source of sources) {
        // The last one wins when a file sets a key twice — what a reader ends up with.
        const entry = [...source.entries].reverse().find((e) => e.key === key);
        cells[source.id] = cellOf(entry);
      }
      const problems: RowProblem[] = [];
      const having = real.filter((s) => cells[s.id].state !== "missing");
      const missingIn = real.filter((s) => cells[s.id].state === "missing").map((s) => s.id);
      if (examples.length > 0 && examples.every((s) => cells[s.id].state === "missing")) problems.push("notInExample");
      if (real.length >= 2 && missingIn.length > 0) problems.push(having.length === 1 ? "onlyOne" : "missing");
      else if (real.length >= 1 && having.length === 0 && examples.length > 0) {
        // Only the template lists it: every real file is missing it.
        problems.push("missing");
      }
      if (real.some((s) => cells[s.id].state === "empty")) problems.push("empty");
      return { key, cells, problems, missingIn: problems.includes("missing") || problems.includes("onlyOne") ? missingIn : [] };
    });
    const [dir, family, service] = id.split("|");
    groups.push({
      id,
      dir: dir ?? "",
      family: (family ?? sources[0].family) as EnvSource["family"],
      service: service ?? null,
      sources,
      rows,
      hasExample: examples.length > 0,
    });
  }
  // The root first, then by folder; within a folder dotenv before the rest.
  const familyRank = (f: string) => ["dotenv", "dotnet", "launch", "spring", "compose", "yaml", "json"].indexOf(f);
  return groups.sort(
    (a, b) => a.dir.localeCompare(b.dir) || familyRank(a.family) - familyRank(b.family) || (a.service ?? "").localeCompare(b.service ?? ""),
  );
}

export function filterRows(rows: EnvRow[], query: string, onlyProblems: boolean): EnvRow[] {
  const needle = query.trim().toLowerCase();
  return rows.filter((row) => (!onlyProblems || row.problems.length > 0) && (!needle || row.key.toLowerCase().includes(needle)));
}

// ---------------------------------------------------------------------------------------------
// What the code reads
// ---------------------------------------------------------------------------------------------

export type ReadProblem = "undefined" | "notInExample";

export interface ReadFinding {
  read: EnvRead;
  problem: ReadProblem;
  /** For `notInExample`: the example file it should be added to (a dotenv path). */
  example?: string;
}

export interface UsageReport {
  findings: ReadFinding[];
  /** Keys in dotenv files nothing in the code reads — "posibles sobrantes". */
  leftovers: { key: string; paths: string[] }[];
  /** The code reads environment variables and the repository has no example file at all. */
  noExample: boolean;
}

/** `spring.datasource.password` → `SPRING_DATASOURCE_PASSWORD`, as `repo_env::inject` does it. */
export function springEnvName(key: string): string {
  return key.replace(/[.[\]]/g, "_").replace(/-/g, "").toUpperCase();
}

/** Spring compares keys loosely: case and dashes do not matter. */
const relaxed = (key: string) => key.replace(/-/g, "").toLowerCase();

/** Variables a framework reads without the repository's code naming them. */
const IMPLICIT = /^(PORT|HOST|NODE_ENV|NODE_OPTIONS|TZ|DEBUG|BROWSER|GENERATE_SOURCEMAP|NEXT_TELEMETRY_DISABLED|JAVA_OPTS|(ASPNETCORE|DOTNET|COMPOSE|DOCKER|SPRING|PYTHON|DJANGO|FLASK|RUST|CARGO)_.*)$/;

/** The dotenv group whose folder holds `path` most closely. */
function nearest(groups: EnvGroup[], path: string): EnvGroup | undefined {
  let best: EnvGroup | undefined;
  for (const group of groups) {
    const inside = group.dir === "" || path === group.dir || path.startsWith(`${group.dir}/`);
    if (inside && (!best || group.dir.length > best.dir.length)) best = group;
  }
  return best;
}

export function usageReport(scan: EnvScan, usage: EnvUsage): UsageReport {
  const groups = buildGroups(scan);
  const envSources = scan.sources.filter((s) => s.family === "dotenv" || s.family === "compose" || s.family === "launch");
  const envKeys = new Set(envSources.flatMap((s) => s.entries.map((e) => e.key)));
  const dotnetKeys = scan.sources.filter((s) => s.family === "dotnet" || s.family === "json").flatMap((s) => s.entries.map((e) => e.key.toLowerCase()));
  const springKeys = new Set(scan.sources.filter((s) => s.family === "spring" || s.family === "yaml").flatMap((s) => s.entries.map((e) => relaxed(e.key))));
  // Everything else in the repository that could be setting an environment variable.
  const allKeys = new Set(scan.sources.flatMap((s) => s.entries.map((e) => e.key)));
  const dotenvGroups = groups.filter((g) => g.family === "dotenv");
  const exampleGroups = dotenvGroups.filter((g) => g.hasExample);

  const findings: ReadFinding[] = [];
  const envReads = usage.reads.filter((r) => r.kind === "env");
  for (const read of usage.reads) {
    if (read.hasDefault) continue;
    if (read.kind === "env") {
      const definedElsewhere =
        envKeys.has(read.key) ||
        allKeys.has(read.key) ||
        dotnetKeys.includes(read.key.replace(/__/g, ":").toLowerCase()) ||
        springKeys.has(relaxed(read.key.replace(/_/g, ".")));
      const home = read.places[0]?.path ?? "";
      const group = nearest(exampleGroups, home);
      if (group) {
        const listed = group.sources.filter((s) => s.example).some((s) => s.entries.some((e) => e.key === read.key));
        if (!listed) {
          const example = group.sources.find((s) => s.example && s.format === "dotenv");
          findings.push({ read, problem: definedElsewhere ? "notInExample" : "undefined", example: example?.path });
          continue;
        }
      } else if (!definedElsewhere && scan.sources.length > 0) {
        findings.push({ read, problem: "undefined" });
      }
    } else if (read.kind === "dotnet" || read.kind === "dotnetSection") {
      const key = read.key.toLowerCase();
      const full = read.kind === "dotnet" && !read.key.includes(":") ? [key, `connectionstrings:${key}`] : [key];
      const defined =
        dotnetKeys.some((k) => full.some((f) => k === f || k.startsWith(`${f}:`))) ||
        [...envKeys].some((k) => full.some((f) => k.replace(/__/g, ":").toLowerCase() === f));
      if (!defined && dotnetKeys.length > 0) findings.push({ read, problem: "undefined" });
    } else if (read.kind === "spring") {
      const defined = springKeys.has(relaxed(read.key)) || envKeys.has(springEnvName(read.key));
      if (!defined && springKeys.size > 0) findings.push({ read, problem: "undefined" });
    }
  }
  findings.sort((a, b) => Number(a.problem !== "undefined") - Number(b.problem !== "undefined") || a.read.key.localeCompare(b.read.key));

  // Leftovers only mean something when the scan could see the code read anything at all.
  const readNames = new Set(envReads.map((r) => r.key));
  const leftovers: UsageReport["leftovers"] = [];
  if (envReads.length > 0) {
    const byKey = new Map<string, string[]>();
    for (const source of scan.sources.filter((s) => s.family === "dotenv")) {
      for (const entry of source.entries) {
        if (readNames.has(entry.key) || IMPLICIT.test(entry.key)) continue;
        const paths = byKey.get(entry.key) ?? [];
        if (!paths.includes(source.path)) paths.push(source.path);
        byKey.set(entry.key, paths);
      }
    }
    for (const [key, paths] of byKey) leftovers.push({ key, paths });
    leftovers.sort((a, b) => a.key.localeCompare(b.key));
  }
  const noExample = envReads.some((r) => !r.hasDefault) && dotenvGroups.length > 0 && exampleGroups.length === 0;
  return { findings, leftovers, noExample };
}

/** How many rows of all groups have something wrong — the tab's summary. */
export function problemCount(groups: EnvGroup[]): number {
  return groups.reduce((sum, g) => sum + g.rows.filter((r) => r.problems.length > 0).length, 0);
}
