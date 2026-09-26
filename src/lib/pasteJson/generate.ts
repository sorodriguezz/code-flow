/**
 * The quicktype half of "Paste JSON as Code" — and the only module that imports it.
 *
 * Reached through a dynamic `import()` from `components/editor/pasteJsonAsCode`, never statically:
 * quicktype carries every one of its twenty-odd target languages whether or not they are used, and
 * is ~840 KB minified. Like `@dbml/core`, it is paid for by the first paste of a session and by
 * nobody who never pastes. It needs no network: the JSON is the whole input.
 *
 * **Deep imports, on purpose.** The package's own entry re-exports its Node file-and-URL reader,
 * which imports `fs` and `path` — Vite then externalises both for the browser and warns about it on
 * every build — and drags `readable-stream` with its `buffer`/`process` shims into the chunk. Nothing
 * here reads a file or a URL; `Run` and `input/Inputs` are all a JSON sample needs, and the package's
 * `exports` map publishes `./dist/*` for exactly this. The version is pinned in `package.json`
 * because these paths are the package's layout, not its API.
 */
import { quicktypeMultiFile } from "quicktype-core/dist/esm/Run.js";
import { InputData, jsonInputForTargetLanguage } from "quicktype-core/dist/esm/input/Inputs.js";
import type { PasteJsonTarget } from "./targets";
import { demotePublicTypes, hasDeclarations, stripLeadingComments, toJsdoc, unwrapNamespace } from "./shape";

export { placeGenerated } from "./shape";

export interface RenderRequest {
  /** The JSON sample, already known to parse. */
  json: string;
  /** The top-level type's name, already known to be an identifier. */
  name: string;
  target: PasteJsonTarget;
  /** One level of the editor's indentation for this file. */
  indentation: string;
  /** The file's name — Java lets only the type named after it stay public. */
  fileName: string;
}

/**
 * The declarations for `json`, in the target's language, as one block of text: quicktype's output
 * minus the header comment, with C# out of its placeholder namespace, Java down to one public type
 * and JavaScript's written as JSDoc. Package and import lines are still in it — where they go
 * depends on the file being pasted into, which is `placeGenerated`'s business.
 *
 * Empty when there is nothing to declare: a bare `[]`, or an array of numbers.
 */
export async function renderJsonAsCode({ json, name, target, indentation, fileName }: RenderRequest): Promise<string> {
  const input = jsonInputForTargetLanguage(target.dialect);
  await input.addSource({ name, samples: [json] });
  const inputData = new InputData();
  inputData.addInput(input);
  const indent = target.indentation ?? indentation;
  // One entry per file for the languages that want a file per class (Java), one for the rest. Asked
  // for as separate files rather than as quicktype's combined output, which glues them together
  // with a `// Order.java` comment above each — a file boundary that no longer exists once pasted.
  const files = await quicktypeMultiFile({
    lang: target.dialect,
    inputData,
    indentation: indent,
    // Typed per language by quicktype, which a table keyed by a union cannot express; every value
    // in `targets.ts` is one the renderer defines, and the tests render each of them.
    rendererOptions: target.rendererOptions as never,
    inferMaps: true,
    inferEnums: target.enums,
    inferDateTimes: target.dates,
    inferUuids: target.uuids,
    inferIntegerStrings: false,
    inferBooleanStrings: false,
  });
  let code = [...files.values()].map((file) => file.lines.join("\n")).join("\n\n");
  code = stripLeadingComments(code, target.dialect);
  if (target.dialect === "csharp") code = unwrapNamespace(code, indent);
  if (target.dialect === "java") code = demotePublicTypes(code, fileName.replace(/\.[^.]*$/, "") || null);
  if (target.jsdoc) code = toJsdoc(code.trim());
  return hasDeclarations(code, target.dialect) ? code.trim() : "";
}
