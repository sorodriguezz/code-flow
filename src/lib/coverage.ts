import { create } from "zustand";
import { readFileText } from "./tauri/commands";

/**
 * Test coverage over the code, as VS Code's Testing view draws it: lines the last run executed and
 * lines it did not, read from the report the project's own runner already writes. Nothing is run
 * for it — `vitest --coverage`, `jest --coverage`, `pytest --cov --cov-report=xml`, `c8`, `nyc`
 * leave one of three formats behind, and those are what is read:
 *
 * - **lcov** (`coverage/lcov.info`, `lcov.info`) — Istanbul, c8, Go's `gcov2lcov`, Rust's `grcov`
 * - **Istanbul JSON** (`coverage/coverage-final.json`) — Jest/Vitest's default `json` reporter
 * - **Cobertura XML** (`coverage.xml`, `coverage/cobertura-coverage.xml`) — coverage.py, .NET, Java
 *
 * Paths in a report are absolute or relative to wherever the runner ran; they are matched to the
 * repository by their tail (`fileCoverage`).
 */

export interface FileCoverage {
  /** 1-based line numbers executed at least once. */
  hit: number[];
  /** 1-based line numbers that are executable and were never run. */
  missed: number[];
}

export type CoverageReport = Map<string, FileCoverage>;

/** Where a report is looked for, in order — the first that exists is the one read. */
export const COVERAGE_FILES = [
  "coverage/lcov.info",
  "lcov.info",
  "coverage/coverage-final.json",
  "coverage/cobertura-coverage.xml",
  "coverage.xml",
];

function add(report: CoverageReport, path: string, line: number, count: number) {
  if (!path || !Number.isFinite(line) || line < 1) return;
  const entry = report.get(path) ?? { hit: [], missed: [] };
  (count > 0 ? entry.hit : entry.missed).push(line);
  report.set(path, entry);
}

/** `SF:` opens a file, `DA:<line>,<count>` is one line of it, `end_of_record` closes it. */
export function parseLcov(text: string): CoverageReport {
  const report: CoverageReport = new Map();
  let file = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("SF:")) file = line.slice(3);
    else if (line.startsWith("DA:")) {
      const [at, count] = line.slice(3).split(",");
      add(report, file, Number(at), Number(count));
    } else if (line === "end_of_record") file = "";
  }
  return report;
}

/** `{ "<path>": { statementMap: { "0": { start: { line } } }, s: { "0": <count> } } }`. A line is
 *  hit when any statement starting on it ran. */
export function parseIstanbul(text: string): CoverageReport {
  const report: CoverageReport = new Map();
  const parsed = JSON.parse(text) as Record<
    string,
    { path?: string; statementMap?: Record<string, { start?: { line?: number } }>; s?: Record<string, number> }
  >;
  for (const [key, file] of Object.entries(parsed)) {
    const lines = new Map<number, number>();
    for (const [id, statement] of Object.entries(file.statementMap ?? {})) {
      const line = statement.start?.line;
      if (typeof line !== "number") continue;
      lines.set(line, Math.max(lines.get(line) ?? 0, file.s?.[id] ?? 0));
    }
    for (const [line, count] of lines) add(report, file.path ?? key, line, count);
  }
  return report;
}

/** `<class filename="…"><lines><line number="12" hits="0"/>`, with the `<source>` roots kept so a
 *  relative filename can be told apart from another of the same name. */
export function parseCobertura(text: string): CoverageReport {
  const report: CoverageReport = new Map();
  const classes = text.split(/<class\b/).slice(1);
  for (const block of classes) {
    const filename = /filename="([^"]*)"/.exec(block)?.[1];
    if (!filename) continue;
    const body = block.split(/<\/class>/)[0];
    for (const match of body.matchAll(/<line\b[^>]*?number="(\d+)"[^>]*?hits="(\d+)"/g)) {
      add(report, filename.replace(/&amp;/g, "&"), Number(match[1]), Number(match[2]));
    }
  }
  return report;
}

export function parseCoverage(file: string, text: string): CoverageReport {
  if (file.endsWith(".json")) return parseIstanbul(text);
  if (file.endsWith(".xml")) return parseCobertura(text);
  return parseLcov(text);
}

/**
 * The coverage of one repo-relative file: the report's entry whose path ends with it, preferring the
 * longest such path segment match. A report written on another machine, in a container or from a
 * sub-package still lines up, since only the tail has to agree.
 */
export function fileCoverage(report: CoverageReport, relPath: string): FileCoverage | null {
  const wanted = relPath.replace(/\\/g, "/");
  let best: { entry: FileCoverage; length: number } | null = null;
  for (const [path, entry] of report) {
    const normalized = path.replace(/\\/g, "/");
    if (normalized === wanted || normalized.endsWith(`/${wanted}`)) return entry;
    // A report relative to a sub-package (`src/x.ts` for `packages/web/src/x.ts`).
    if (wanted.endsWith(`/${normalized.replace(/^\.\//, "")}`)) {
      const length = normalized.length;
      if (!best || length > best.length) best = { entry, length };
    }
  }
  return best?.entry ?? null;
}

/** Lines covered out of lines executable, across the report — what the Tests view's button says. */
export function coverageSummary(report: CoverageReport): { hit: number; total: number } {
  let hit = 0;
  let total = 0;
  for (const entry of report.values()) {
    // A line listed both ways (two statements, one never reached) counts once, as hit — as Istanbul's
    // line summary does.
    const covered = new Set(entry.hit);
    hit += covered.size;
    total += new Set([...entry.hit, ...entry.missed]).size;
  }
  return { hit, total };
}

interface CoverageState {
  /** The repository the report belongs to. */
  repoPath: string | null;
  report: CoverageReport | null;
  /** Which file it was read from, for the tooltip. */
  source: string | null;
  /** Drawn over the code. Off until asked for, as in VS Code. */
  shown: boolean;
  /** Reads the first report there is; answers whether one was found. */
  load: (repoPath: string) => Promise<boolean>;
  setShown: (shown: boolean) => void;
}

export const useCoverageStore = create<CoverageState>((set) => ({
  repoPath: null,
  report: null,
  source: null,
  shown: false,
  load: async (repoPath) => {
    for (const file of COVERAGE_FILES) {
      const text = await readFileText(repoPath, file).catch(() => null);
      if (text === null) continue;
      try {
        set({ repoPath, report: parseCoverage(file, text), source: file });
        return true;
      } catch {
        // A report that does not parse is not one; try the next place.
      }
    }
    set({ repoPath, report: null, source: null });
    return false;
  },
  setShown: (shown) => set({ shown }),
}));
