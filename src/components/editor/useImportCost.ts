import { useEffect, useRef } from "react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import type { Monaco } from "@monaco-editor/react";
import { invoke } from "@tauri-apps/api/core";
import { scriptKind } from "../../lib/tsserver";

/**
 * What each imported package weighs, shown at the end of its import line.
 *
 * # The number is the installed size, and the annotation says so
 *
 * The `import-cost` extension reports *bundle* cost: it bundles the imported symbols, minifies, and
 * tells you that `import { debounce } from "lodash"` costs a few kilobytes rather than the whole
 * library. Getting that right means running a bundler per import — with the project's own settings,
 * or the figure is wrong in a way that looks authoritative.
 *
 * This reports what is on disk under `node_modules/<name>`, and the tooltip names it as such. It is
 * a true answer to "how heavy is this dependency", which is the question that usually prompts the
 * look, and it never quietly disagrees with the build. If real bundle cost is wanted later it is a
 * different measurement, not a refinement of this one, and it should say a different word.
 *
 * # Only bare specifiers
 *
 * `./thing` and `../lib/x` are your own files: their size is the file you can already see, and
 * annotating them would put a number on every line of every import block for no information. Node's
 * builtins are skipped for the same reason — `node:fs` has no weight to report.
 */

/** What the backend answers for each name. */
interface PackageWeight {
  name: string;
  bytes: number;
  files: number;
  /** Empty on success. "not installed" is a real answer and is drawn differently from a size. */
  error: string;
}

/** `lodash/merge` → `lodash`; `@scope/pkg/sub` → `@scope/pkg`. */
function packageOf(specifier: string): string | null {
  if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) return null;
  // Node builtins, with and without the modern prefix.
  if (specifier.startsWith("node:")) return null;
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  // A bare `@scope` with nothing after it is not a package.
  return name && !(name.startsWith("@") && !name.includes("/")) ? name : null;
}

/**
 * Every module specifier in the file, with the line it sits on.
 *
 * A regular expression and not the compiler, deliberately: tsserver could answer this exactly, but
 * it would be a request per keystroke for something whose only consumer is a decoration, and the two
 * forms below are what an import looks like in practice. A specifier this misses costs one missing
 * badge.
 */
function specifiers(text: string): Map<string, number[]> {
  const found = new Map<string, number[]>();
  const lines = text.split("\n");
  const patterns = [
    /\bfrom\s*["'`]([^"'`]+)["'`]/,
    /\bimport\s*\(\s*["'`]([^"'`]+)["'`]/,
    /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/,
    /^\s*import\s+["'`]([^"'`]+)["'`]/,
  ];
  lines.forEach((line, index) => {
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      const name = match && packageOf(match[1]);
      if (!name) continue;
      // 1-based, as Monaco counts.
      found.set(name, [...(found.get(name) ?? []), index + 1]);
      break;
    }
  });
  return found;
}

/** Bytes as something readable at a glance in 11px type. */
function human(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function useImportCost(
  editor: MonacoEditorNS.IStandaloneCodeEditor | null,
  monaco: Monaco | null,
  { repoPath, activePath }: { repoPath: string | null; activePath: string | null },
) {
  /** Sizes already measured for this repository. A package's size on disk does not change while you
   *  type, so it is asked for once and reused across every file that imports it. */
  const sizes = useRef<Map<string, PackageWeight>>(new Map());

  useEffect(() => {
    sizes.current = new Map();
  }, [repoPath]);

  useEffect(() => {
    if (!editor || !monaco || !repoPath || !activePath || !scriptKind(activePath)) return;
    const model = editor.getModel();
    if (!model) return;

    let disposed = false;
    let collection: MonacoEditorNS.IEditorDecorationsCollection | null = null;

    const draw = () => {
      if (disposed) return;
      const wanted = specifiers(model.getValue());
      const decorations: MonacoEditorNS.IModelDeltaDecoration[] = [];
      for (const [name, lines] of wanted) {
        const weight = sizes.current.get(name);
        if (!weight || weight.error) continue;
        for (const line of lines) {
          decorations.push({
            range: new monaco.Range(line, model.getLineMaxColumn(line), line, model.getLineMaxColumn(line)),
            options: {
              // `after` rather than a lens: the number belongs *on* the import, and a lens per
              // import would double the height of every import block in the file.
              after: {
                content: `  ${human(weight.bytes)}`,
                inlineClassName: "cf-import-cost",
              },
              // Zero-width range, so this flag is what makes the text exist: Monaco filters injected
              // text on an empty range out unless it is set. See the long note in
              // `usePackageJsonLens`, where the same omission drew nothing.
              showIfCollapsed: true,
              // The clarification the number needs, kept off the line itself.
              hoverMessage: {
                value: `\`${name}\` — ${human(weight.bytes)} in ${weight.files} files on disk (installed size, not bundle cost)`,
              },
              stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
            },
          });
        }
      }
      collection?.clear();
      collection = editor.createDecorationsCollection(decorations);
    };

    const measure = async () => {
      const wanted = [...specifiers(model.getValue()).keys()].filter((name) => !sizes.current.has(name));
      if (wanted.length === 0) {
        draw();
        return;
      }
      const weights = await invoke<PackageWeight[]>("npm_package_sizes", {
        repoPath,
        names: wanted,
      }).catch(() => [] as PackageWeight[]);
      if (disposed) return;
      // Cached including the failures, so a package that is not installed is asked about once rather
      // than on every keystroke for as long as the file is open.
      for (const weight of weights) sizes.current.set(weight.name, weight);
      draw();
    };

    void measure();
    // Edits move the lines the badges sit on, and can add an import. Settled rather than immediate:
    // this reads the filesystem, and doing that per character while somebody types an import path
    // would be a directory walk per keystroke.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const changed = model.onDidChangeContent(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void measure(), 500);
    });

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      changed.dispose();
      collection?.clear();
    };
  }, [editor, monaco, repoPath, activePath]);
}
