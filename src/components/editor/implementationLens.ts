import * as monaco from "monaco-editor";
import { MODEL_SCHEME, modelPathForId, relPathFromModelUri } from "../../lib/editorModel";
import {
  byProximity,
  computeLenses,
  outlineTypes,
  singleQuoteStringsFor,
  typeAt,
  typeWithHeaderOn,
  type ImplLens,
  type LensDeps,
  type Loc,
  type TypeDecl,
} from "../../lib/implementationLens";
import { definitionProject, openDefinitionTarget } from "../../lib/goToDefinition";
import { onSessionsChanged } from "../../lib/lsp/client";
import { readEditorFile, searchRepo } from "../../lib/tauri/commands";
import { onTsEvent, TS_LANGUAGES, tsServes } from "../../lib/tsserver";
import { groupHits, useEditorPanelStore } from "../../state/editorPanelStore";
import { useEditorDisplayStore } from "../../state/editorDisplayStore";
import { translate, useLanguageStore } from "../../state/languageStore";
import { withLineText } from "./findReferences";
import { tsDefinitions, tsImplementations } from "./useTypeScript";
import { lspCanImplement, lspDefinitions, lspImplementations } from "./useLanguageServer";

/**
 * The implementation lenses in the editor — "2 implementations | Implements Runnable" over a type,
 * "Overrides Base.run" over a method — Settings › Editor › Display.
 *
 * Which engine answers, per file:
 *
 * - **tsserver** for TypeScript/JavaScript it holds: `implementation` per type and per member,
 *   `definitionAndBoundSpan` for an `extends`/`implements` name;
 * - **a language server** that declares `implementationProvider` (gopls, rust-analyzer, clangd, the
 *   C# server), the same two requests in LSP;
 * - **a text search** otherwise — which is what Java, Kotlin, Scala, Dart, Swift and PHP get, none
 *   of them having a server here: the repo is searched for declarations naming the type in their
 *   heritage, and each hit is checked against that file's outline (`lib/implementationLens`).
 *
 * **Computed whole, not resolved lazily.** Monaco reserves a line for every lens a provider returns,
 * resolved or not, so a lens that resolves to "0 implementations" on every class would push the
 * code down for nothing. Instead each file costs one lookup per type (members are asked only for a
 * type that has subtypes), within `LENS_LIMITS`, and the answer is kept per model version — Monaco
 * asks again on every edit, and an unchanged buffer is not recomputed.
 */

/** The languages a lens is drawn in. Go only for its interfaces, Rust for traits and impls. */
const LENS_LANGUAGES = [
  ...TS_LANGUAGES,
  "java",
  "kotlin",
  "scala",
  "csharp",
  "php",
  "dart",
  "swift",
  "cpp",
  "c",
  "go",
  "rust",
];

/** What the text engine searches when the file is one of these, so a Java interface is not
 *  "implemented" by a TypeScript class of the same name. */
const FAMILIES: [RegExp, string][] = [
  [/\.(m?[jt]sx?|c[jt]s)$/i, "*.ts,*.tsx,*.js,*.jsx,*.mts,*.cts,*.mjs,*.cjs"],
  [/\.(java|kt|kts|scala|groovy)$/i, "*.java,*.kt,*.kts,*.scala,*.groovy"],
  [/\.cs$/i, "*.cs"],
  [/\.php$/i, "*.php"],
  [/\.dart$/i, "*.dart"],
  [/\.swift$/i, "*.swift"],
  [/\.(c|cc|cpp|cxx|h|hh|hpp|hxx)$/i, "*.c,*.cc,*.cpp,*.cxx,*.h,*.hh,*.hpp,*.hxx"],
  [/\.rs$/i, "*.rs"],
];

/** Past this the file is not read for lenses: a generated bundle has nothing to say here. */
const MAX_CHARS = 400_000;
/** How long an answer about *other* files is trusted — they can change without this buffer doing so. */
const TTL_MS = 15_000;

const COMMAND = "cf.implementationLens.open";

let installed = false;
const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();
/** Asks Monaco to draw every lens again. */
const redraw = () => changed.fire(provider);

/** The lenses of the last version of each model asked about, and which engine drew them. */
const perModel = new Map<string, { version: number; engine: Engine; at: number; lenses: Promise<ImplLens[]> }>();
/** Answers about other files: outlines read from disk, text searches. */
const shortLived = new Map<string, { at: number; value: Promise<unknown> }>();

type Engine = "ts" | "lsp" | "text";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function remember<T>(key: string, make: () => Promise<T>): Promise<T> {
  const hit = shortLived.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = make();
  shortLived.set(key, { at: Date.now(), value });
  if (shortLived.size > 500) {
    for (const [k, v] of shortLived) if (Date.now() - v.at >= TTL_MS) shortLived.delete(k);
  }
  return value;
}

function engineFor(model: monaco.editor.ITextModel): Engine {
  if (TS_LANGUAGES.includes(model.getLanguageId()) && tsServes(model.uri)) return "ts";
  if (lspCanImplement(model)) return "lsp";
  return "text";
}

function outlineOfText(path: string, text: string): TypeDecl[] {
  return outlineTypes(text, singleQuoteStringsFor(path));
}

/** Another file's outline — from its open buffer when it has one, from disk otherwise. */
function outlineOf(project: { id: string; local_path: string }, path: string): Promise<TypeDecl[] | null> {
  const model = monaco.editor.getModel(monaco.Uri.parse(modelPathForId(project.id, path)));
  if (model) {
    if (model.getValueLength() > MAX_CHARS) return Promise.resolve(null);
    return remember(`outline:${path}:${model.getVersionId()}`, async () => outlineOfText(path, model.getValue()));
  }
  return remember(`outline:${path}:disk`, async () => {
    const file = await readEditorFile(project.local_path, path).catch(() => null);
    if (!file || (file.kind !== "text" && file.kind !== "legacy") || file.text.length > MAX_CHARS) return null;
    return outlineOfText(path, file.text);
  });
}

const toLoc = (hit: { path: string; range: monaco.IRange }): Loc => ({
  path: hit.path,
  line: hit.range.startLineNumber,
  column: hit.range.startColumn,
});

/** The text engine's subtypes: declarations anywhere in the same language family whose heritage
 *  names this type, each confirmed against its own file's outline. */
function textSubtypes(project: { id: string; local_path: string }, path: string, decl: TypeDecl): Promise<Loc[]> {
  const include = FAMILIES.find(([re]) => re.test(path))?.[1] ?? "";
  return remember(`subtypes:${include}:${decl.name}`, async () => {
    const name = escapeRegExp(decl.name);
    const outcome = await searchRepo(
      project.local_path,
      String.raw`\b(?:class|interface|trait|struct|record|object|enum|extension|impl|extends|implements)\b.*\b${name}\b`,
      { caseSensitive: true, wholeWord: false, regex: true, include, exclude: "" },
      300,
    ).catch(() => null);
    if (!outcome) return [];
    const found: Loc[] = [];
    for (const file of [...new Set(outcome.hits.map((hit) => hit.path))].slice(0, 60)) {
      const decls = await outlineOf(project, file);
      if (!decls) continue;
      for (const hit of outcome.hits.filter((h) => h.path === file)) {
        const sub = typeWithHeaderOn(decls, hit.line_no);
        if (sub && sub.heritage.some((ref) => ref.name === decl.name)) {
          found.push({ path: file, line: sub.nameLine, column: sub.nameColumn });
        }
      }
    }
    return found;
  });
}

/** The text engine's definition: the nearest declaration of a type by that name. */
function textDefinition(project: { id: string; local_path: string }, path: string, name: string): Promise<Loc | null> {
  const include = FAMILIES.find(([re]) => re.test(path))?.[1] ?? "";
  return remember(`definition:${include}:${path}:${name}`, async () => {
    const outcome = await searchRepo(
      project.local_path,
      String.raw`\b(?:class|interface|trait|protocol|struct|record|object)\s+${escapeRegExp(name)}\b`,
      { caseSensitive: true, wholeWord: false, regex: true, include, exclude: "" },
      100,
    ).catch(() => null);
    for (const hit of byProximity(outcome?.hits ?? [], path)) {
      const decl = typeAt((await outlineOf(project, hit.path)) ?? [], hit.line_no);
      if (decl && decl.name === name && decl.kind !== "impl") {
        return { path: hit.path, line: decl.nameLine, column: decl.nameColumn };
      }
    }
    return null;
  });
}

async function lensesFor(model: monaco.editor.ITextModel, engine: Engine): Promise<ImplLens[]> {
  const project = definitionProject();
  if (!project) return [];
  const path = relPathFromModelUri(model.uri, project.id);
  if (!path) return [];
  const decls = outlineOfText(path, model.getValue());
  if (decls.length === 0) return [];
  const at = (line: number, column: number) => new monaco.Position(line, column);

  const deps: LensDeps = {
    path,
    decls,
    outlineOf: (other) => outlineOf(project, other),
    subtypes: async (decl) => {
      // Go: only interfaces — gopls answers a struct with the interfaces *it* satisfies.
      if (model.getLanguageId() === "go" && decl.kind !== "interface") return [];
      if (engine === "text") return textSubtypes(project, path, decl);
      const found =
        engine === "ts"
          ? await tsImplementations(model, at(decl.nameLine, decl.nameColumn))
          : await lspImplementations(model, at(decl.nameLine, decl.nameColumn));
      return (found ?? []).map(toLoc);
    },
    memberImplementations:
      engine === "text"
        ? undefined
        : async (member) => {
            const found =
              engine === "ts"
                ? await tsImplementations(model, at(member.line, member.column))
                : await lspImplementations(model, at(member.line, member.column));
            return found ? found.map(toLoc) : null;
          },
    definition: async (ref) => {
      if (engine !== "text") {
        const found =
          engine === "ts"
            ? await tsDefinitions(model, at(ref.line, ref.column))
            : await lspDefinitions(model, at(ref.line, ref.column));
        if (found) return found.length > 0 ? toLoc(found[0]) : null;
      }
      return textDefinition(project, path, ref.name);
    },
  };
  return computeLenses(deps);
}

function titleOf(lens: ImplLens): string {
  const title = lens.title;
  if (title.kind === "implementations") {
    return title.count === 1
      ? translate("editor.lensImplementationOne")
      : translate("editor.lensImplementations", { n: title.count });
  }
  const key =
    title.relation === "implements"
      ? "editor.lensImplements"
      : title.relation === "overrides"
        ? "editor.lensOverrides"
        : "editor.lensExtends";
  return translate(key, { name: title.name });
}

/** One place: go there. Several: the list, in the panel under the editor, as "Find All
 *  Implementations" shows it — Monaco's peek cannot preview a file that is not open. */
async function open(targets: Loc[], name: string): Promise<void> {
  if (targets.length === 1) {
    const [only] = targets;
    openDefinitionTarget(only.path, only.line, only.column);
    return;
  }
  const project = definitionProject();
  if (!project || targets.length === 0) return;
  const hits = await withLineText(
    targets.map((loc) => ({
      path: loc.path,
      range: { startLineNumber: loc.line, startColumn: loc.column, endLineNumber: loc.line, endColumn: loc.column },
    })),
    project,
  );
  useEditorPanelStore.getState().showResults({
    title: translate("editor.implementationsTitle", { n: targets.length, name }),
    groups: groupHits(hits),
    notes: [],
  });
}

const empty = { lenses: [], dispose: () => {} };

const provider: monaco.languages.CodeLensProvider = {
  onDidChange: changed.event,
  provideCodeLenses: async (model, token) => {
    if (!useEditorDisplayStore.getState().implementationLens) return empty;
    if (model.uri.scheme !== MODEL_SCHEME || model.getValueLength() > MAX_CHARS) return empty;
    const engine = engineFor(model);
    const uri = model.uri.toString();
    const version = model.getVersionId();
    let entry = perModel.get(uri);
    // Older than `TTL_MS` is asked again even unchanged: the subtypes live in other files.
    if (!entry || entry.version !== version || entry.engine !== engine || Date.now() - entry.at > TTL_MS) {
      entry = { version, engine, at: Date.now(), lenses: lensesFor(model, engine).catch(() => []) };
      perModel.set(uri, entry);
      if (perModel.size > 30) perModel.delete(perModel.keys().next().value!);
    }
    const lenses = await entry.lenses;
    if (token.isCancellationRequested) return empty;
    return {
      lenses: lenses.map((lens) => ({
        range: new monaco.Range(lens.line, 1, lens.line, 1),
        command: {
          id: COMMAND,
          title: titleOf(lens),
          arguments: [lens.targets, lens.title.name],
        },
      })),
      dispose: () => {},
    };
  },
};

/** Installs the provider and its command once, for every editor — Monaco's providers are global. */
export function installImplementationLens(): void {
  if (installed) return;
  installed = true;

  monaco.editor.registerCommand(COMMAND, (_accessor: unknown, targets: Loc[], name: string) => void open(targets, name));

  monaco.languages.registerCodeLensProvider(LENS_LANGUAGES, provider);

  const refresh = () => {
    perModel.clear();
    redraw();
  };
  // Switched in Settings (any window).
  useEditorDisplayStore.subscribe((state, previous) => {
    if (state.implementationLens !== previous.implementationLens) refresh();
  });
  // The titles are translated when drawn.
  useLanguageStore.subscribe((state, previous) => {
    if (state.language !== previous.language) redraw();
  });
  // A server that has just come up answers better than the text search that drew the lenses.
  onSessionsChanged(refresh);
  onTsEvent(() => {
    for (const [uri, entry] of perModel) {
      const model = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (model && entry.engine !== "ts" && engineFor(model) === "ts") {
        redraw();
        return;
      }
    }
  }).catch(() => undefined);
}
