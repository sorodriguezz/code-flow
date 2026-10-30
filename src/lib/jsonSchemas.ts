import type * as Monaco from "monaco-editor";
import { invoke } from "./tauri/invoke";
import { MODEL_SCHEME } from "./editorModel";
import { useEditorDisplayStore } from "../state/editorDisplayStore";

/**
 * JSON files validated and completed against their schema, as VS Code does out of the box:
 * `package.json`, `tsconfig.json`, `.eslintrc.json`, `turbo.json`… by SchemaStore's catalogue, and any
 * file by its own `"$schema"`.
 *
 * Monaco's JSON worker only knows the schemas it is handed — fetching one itself would be a request
 * from inside the webview, which the CSP refuses — so the backend downloads and caches them
 * (`json_schemas.rs`) and this registers the text, with every absolute `$ref` it reaches fetched the
 * same way. Each schema is tied to the exact model URIs it is for, which is how the official Monaco
 * sample associates them and keeps the database console's and API client's JSON out of it.
 *
 * Files that are JSON *with comments* by convention (`tsconfig.json`, `.vscode/*.json`…) get
 * `allowComments` even with no schema at all: they used to be drawn red line by line.
 */

interface CatalogEntry {
  name: string;
  url: string;
  fileMatch?: string[];
}

/** How deep, and how many, `$ref`s are followed from one schema. */
const MAX_REF_DEPTH = 3;
const MAX_REFS = 40;

/** JSON with comments by convention, whatever its schema says. */
const JSONC_FILES = [
  "tsconfig.json",
  "tsconfig.*.json",
  "jsconfig.json",
  "jsconfig.*.json",
  ".vscode/*.json",
  ".devcontainer/devcontainer.json",
  ".devcontainer.json",
  ".eslintrc.json",
  ".eslintrc",
  ".babelrc",
  ".swcrc",
  "biome.json",
  "*.code-workspace",
  "*.jsonc",
];

// ---------------------------------------------------------------------------
// Matching (pure — tested without Monaco)
// ---------------------------------------------------------------------------

/** A SchemaStore `fileMatch` glob as a regular expression: `**` crosses folders, `*` does not,
 *  `{a,b}` is either. */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        // `**/` matches zero or more folders.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const close = glob.indexOf("}", i);
      if (close < 0) {
        out += "\\{";
        continue;
      }
      out += `(?:${glob
        .slice(i + 1, close)
        .split(",")
        .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
        .join("|")})`;
      i = close;
    } else {
      out += char.replace(/[.+^$()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/**
 * Whether a `fileMatch` pattern names this file. A pattern with no folder in it is about the file
 * name; one with a folder is about the end of the path — `.github/workflows/*.yml` matches in any
 * repository, at any depth.
 */
export function matchesFileMatch(pattern: string, path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const clean = pattern.replace(/^\.?\//, "");
  if (!clean.includes("/")) return globToRegExp(clean).test(normalized.split("/").pop() ?? normalized);
  const glob = clean.startsWith("**/") ? clean : `**/${clean}`;
  return globToRegExp(glob).test(normalized.replace(/^\/+/, ""));
}

/** The catalogue's schema for a JSON file, or `null`. Patterns for YAML and TOML are skipped — those
 *  files are not this worker's. The most specific match wins: a pattern with a folder beats a bare
 *  name, and a literal name beats a wildcard (`package.json` over `*.json`). */
export function catalogMatch(entries: CatalogEntry[], path: string): CatalogEntry | null {
  let best: { entry: CatalogEntry; score: number } | null = null;
  for (const entry of entries) {
    for (const pattern of entry.fileMatch ?? []) {
      if (/\.(ya?ml|toml)$/i.test(pattern) || pattern.startsWith("!")) continue;
      if (!matchesFileMatch(pattern, path)) continue;
      const score =
        (pattern.includes("/") ? 1000 : 0) + pattern.replace(/[*?{}]/g, "").length - (pattern.includes("*") ? 100 : 0);
      if (!best || score > best.score) best = { entry, score };
    }
  }
  return best?.entry ?? null;
}

export function isJsoncFile(path: string): boolean {
  return JSONC_FILES.some((pattern) => matchesFileMatch(pattern, path));
}

/** The URL a file's own `"$schema"` names, if it names a web address. */
export function ownSchemaUrl(text: string): string | null {
  const match = /"\$schema"\s*:\s*"(https?:\/\/[^"]+)"/.exec(text.slice(0, 4000));
  return match ? match[1] : null;
}

/** Every other document a schema `$ref`s, as absolute URLs without their fragment. A ref inside the
 *  same document (`#/definitions/x`) is not one; a relative one is resolved against `base`. */
export function externalRefs(schema: unknown, base: string): string[] {
  const found = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
        try {
          const url = new URL(value, base);
          url.hash = "";
          if (url.protocol === "https:" || url.protocol === "http:") found.add(url.toString());
        } catch {
          // A ref that is not a URL at all names nothing to fetch.
        }
      } else {
        visit(value);
      }
    }
  };
  visit(schema);
  found.delete(new URL(base).toString().replace(/#.*$/, ""));
  return [...found];
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

let catalog: Promise<CatalogEntry[]> | null = null;
/** Schema text by URL, once fetched. `null` is a fetch that failed — not retried this session. */
const schemas = new Map<string, unknown>();
const fetching = new Map<string, Promise<void>>();
/** Which schema each open model is tied to (`null`: only the comment allowance). */
const byModel = new Map<string, string | null>();
const jsoncModels = new Set<string>();
let monacoRef: typeof Monaco | null = null;
let applyTimer: ReturnType<typeof setTimeout> | null = null;

function loadCatalog(): Promise<CatalogEntry[]> {
  catalog ??= invoke<string>("json_schema_catalog")
    .then((text) => (JSON.parse(text) as { schemas?: CatalogEntry[] }).schemas ?? [])
    .catch(() => {
      // Offline at first open: tried again the next time a JSON file opens.
      catalog = null;
      return [];
    });
  return catalog;
}

function load(url: string, depth = 0): Promise<void> {
  if (schemas.has(url)) return Promise.resolve();
  const pending = fetching.get(url);
  if (pending) return pending;
  const attempt = invoke<string>("json_schema_fetch", { url })
    .then(async (text) => {
      const schema = JSON.parse(text) as unknown;
      schemas.set(url, schema);
      if (depth >= MAX_REF_DEPTH) return;
      const refs = externalRefs(schema, url)
        .filter((ref) => !schemas.has(ref))
        .slice(0, MAX_REFS);
      await Promise.all(refs.map((ref) => load(ref, depth + 1)));
    })
    .catch(() => {
      schemas.set(url, null);
    })
    .finally(() => fetching.delete(url));
  fetching.set(url, attempt);
  return attempt;
}

/** Hands the worker every schema it may need, each tied to the models that use it. */
function apply(): void {
  if (applyTimer) clearTimeout(applyTimer);
  applyTimer = setTimeout(() => {
    applyTimer = null;
    const monaco = monacoRef;
    if (!monaco) return;
    const owners = new Map<string, string[]>();
    for (const [model, url] of byModel) if (url) owners.set(url, [...(owners.get(url) ?? []), model]);
    const list: { uri: string; fileMatch?: string[]; schema?: unknown }[] = [];
    for (const [url, schema] of schemas) {
      if (schema === null) continue;
      const forModels = owners.get(url) ?? [];
      // The comment allowance lives on the schema, which is the only per-file switch the worker has.
      const jsonc = forModels.some((model) => jsoncModels.has(model));
      list.push({
        uri: url,
        fileMatch: forModels.length > 0 ? forModels : undefined,
        schema: jsonc
          ? {
              ...(schema as object),
              allowComments: true,
              allowTrailingCommas: true,
            }
          : schema,
      });
    }
    // A JSONC file with no schema still needs the allowance.
    const bare = [...jsoncModels].filter((model) => !byModel.get(model));
    if (bare.length > 0) {
      list.push({
        uri: "codeflow://jsonc",
        fileMatch: bare,
        schema: { allowComments: true, allowTrailingCommas: true },
      });
    }
    monaco.json.jsonDefaults.setDiagnosticsOptions({
      ...monaco.json.jsonDefaults.diagnosticsOptions,
      validate: true,
      enableSchemaRequest: false,
      // A `$ref` this could not fetch is not the file's fault.
      schemaRequest: "ignore",
      schemas: list,
    });
  }, 50);
}

async function associate(model: Monaco.editor.ITextModel): Promise<void> {
  if (model.isDisposed() || model.uri.scheme !== MODEL_SCHEME || model.getLanguageId() !== "json") return;
  const key = model.uri.toString();
  const path = decodeURIComponent(model.uri.path);
  if (isJsoncFile(path)) jsoncModels.add(key);
  else jsoncModels.delete(key);

  let url: string | null = null;
  if (useEditorDisplayStore.getState().jsonSchemas) {
    url = ownSchemaUrl(model.getValue());
    if (!url) url = catalogMatch(await loadCatalog(), path)?.url ?? null;
    if (url) await load(url);
  }
  if (model.isDisposed()) return;
  byModel.set(key, url && schemas.get(url) ? url : null);
  apply();
}

export function installJsonSchemas(monaco: typeof Monaco): void {
  if (monacoRef) return;
  monacoRef = monaco;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const watch = (model: Monaco.editor.ITextModel) => {
    void associate(model);
    // A `$schema` typed or changed: looked at again once typing stops.
    model.onDidChangeContent(() => {
      const key = model.uri.toString();
      const before = timers.get(key);
      if (before) clearTimeout(before);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          const own = model.isDisposed() ? null : ownSchemaUrl(model.getValue());
          if (own && own !== byModel.get(key)) void associate(model);
        }, 1000),
      );
    });
    model.onDidChangeLanguage(() => void associate(model));
  };
  for (const model of monaco.editor.getModels()) watch(model);
  monaco.editor.onDidCreateModel(watch);
  monaco.editor.onWillDisposeModel((model) => {
    const key = model.uri.toString();
    if (byModel.delete(key) || jsoncModels.delete(key)) apply();
  });
  // The switch in Settings › Editor: off drops every association, on re-reads the open files.
  let enabled = useEditorDisplayStore.getState().jsonSchemas;
  useEditorDisplayStore.subscribe((state) => {
    if (state.jsonSchemas === enabled) return;
    enabled = state.jsonSchemas;
    for (const model of monaco.editor.getModels()) void associate(model);
  });
}
