import { invoke } from "@tauri-apps/api/core";

/**
 * The repository map, from the frontend's side — the «Mapa» view's half of
 * `src-tauri/src/commands/codemap_cmd.rs`. The same cached map the agents read; the first call on a
 * repository builds it (seconds on a large one), every later one is a lookup.
 */

export type SymbolKind = "class" | "interface" | "type" | "enum" | "function" | "method" | "const" | "module";

export interface MapNode {
  /** A folder (`src/lib`) or a file path. */
  id: string;
  label: string;
  folder: boolean;
  files: number;
  symbols: number;
  lines: number;
  /** The language most of it is written in. */
  lang: string;
  /** Files outside this node that import something in it. */
  importedBy: number;
  /** The top-level folder it belongs to; `""` for a file at the root. The global view colours by it. */
  group: string;
}

export interface MapEdge {
  from: string;
  to: string;
  /** File → file imports between the two. */
  weight: number;
}

export interface MapGraph {
  /** The folder shown; `""` is the repository root. A lone subfolder opens by itself. */
  focus: string;
  nodes: MapNode[];
  edges: MapEdge[];
  files: number;
  symbols: number;
  languages: [string, number][];
}

export interface MapBuild {
  files: number;
  symbols: number;
  parsed: number;
  millis: number;
}

export interface SymbolHit {
  path: string;
  name: string;
  kind: SymbolKind;
  start: number;
  end: number;
  label: string;
  parent?: string;
  usedBy: number;
}

export interface Usage {
  path: string;
  line: number;
  signature: string;
  /** The file imports the declaring one (or shares its package) — not a namesake. */
  confirmed: boolean;
}

export interface UsageReport {
  declarations: SymbolHit[];
  usages: Usage[];
  ruledOut: number;
}

export interface OutlineSymbol {
  name: string;
  kind: SymbolKind;
  start: number;
  end: number;
  label: string;
  depth: number;
}

export interface FileOutline {
  path: string;
  lang: string;
  lines: number;
  precise: boolean;
  symbols: OutlineSymbol[];
  imports: string[];
  external: string[];
  importedBy: string[];
}

export const codemapGraph = (repoPath: string, focus: string) =>
  invoke<{ graph: MapGraph; build: MapBuild }>("codemap_graph", { repoPath, focus });

/** The whole project at once: every file when it fits, folders cut as deep as fits otherwise. */
export const codemapGlobal = (repoPath: string) => invoke<{ graph: MapGraph; build: MapBuild }>("codemap_global", { repoPath });

export const codemapOutline = (repoPath: string, path: string) =>
  invoke<FileOutline | null>("codemap_outline", { repoPath, path });

export const codemapFind = (repoPath: string, query: string) => invoke<SymbolHit[]>("codemap_find", { repoPath, query });

export const codemapUsages = (repoPath: string, name: string, path: string | null) =>
  invoke<UsageReport>("codemap_usages", { repoPath, name, path });

export const codemapKeySymbols = (repoPath: string) => invoke<SymbolHit[]>("codemap_key_symbols", { repoPath });
