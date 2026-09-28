import type * as MonacoApi from "monaco-editor";
import { tsServes } from "./tsserver";

/**
 * Monaco's own TypeScript worker, as the answer for exactly the files the compiler is not.
 *
 * # The toggle that did nothing
 *
 * `useTypeScript` used to switch the worker's type-aware features off with `setModeConfiguration`
 * once `tsserver` came up, and back on when a project had none. Monaco 0.56 never reads that
 * setting again: `tsMode.js` registers its providers once, from whatever `modeConfiguration` holds
 * when a TypeScript model first activates the language, and nothing re-registers them on a later
 * change (the defaults' `onDidChange` only restarts the worker). The first `.ts` file opened
 * activates it, and `tsserver` answers well after that — so every provider stayed on, and each
 * hover showed the compiler's type stacked on the worker's `any`, each completion list held both
 * answers, and a rename reached whichever of the two Monaco asked first.
 *
 * # One source of truth
 *
 * So the switch is no longer a setting flipped late; it is a question asked per call. Before any
 * model exists (`monacoSetup` imports this at startup) the worker's *type-aware* providers are
 * configured off, and the same adapters Monaco would have registered — its own classes, not a
 * rewrite — are registered here behind a gate: they answer only when `tsserver` does not serve
 * the model (`tsServes`). A project without TypeScript, a file the server has not been handed yet,
 * a script in another panel: the worker, as before. A project file the compiler holds: the
 * compiler, alone.
 *
 * Symbols, highlights, formatting and syntax diagnostics stay Monaco's own registrations. None of
 * them asks what a type *is*, so the isolated view is a sound source for them, and the formatter is
 * the one every repository without Prettier still uses.
 *
 * # The one internal this leans on
 *
 * The adapters are imported from `languageFeatures.js`, which Monaco does not export publicly (the
 * types are ours, `types/monacoTsFeatures.d.ts`). A Monaco release that moves them fails the build
 * at that import — loudly, and before anyone is shown two hovers again.
 */

/** What Monaco registers by itself for TypeScript and JavaScript: everything that is about the
 *  shape of the text, and nothing that is about types. */
export const WORKER_MODE_CONFIGURATION: MonacoApi.typescript.ModeConfiguration = {
  completionItems: false,
  hovers: false,
  definitions: false,
  references: false,
  signatureHelp: false,
  codeActions: false,
  inlayHints: false,
  rename: false,
  documentSymbols: true,
  documentHighlights: true,
  documentRangeFormattingEdits: true,
  onTypeFormattingEdits: true,
  diagnostics: true,
};

/** Whether the isolated worker answers for a model: whenever the compiler does not. */
export function workerAnswers(uri: { scheme: string; path: string }): boolean {
  return !tsServes(uri);
}

type Features = typeof import("monaco-editor/languages/features/typescript/languageFeatures");

let installed = false;

/**
 * Configures the worker and registers its gated providers. Must run before the first TypeScript or
 * JavaScript model is created — that is the moment Monaco reads the configuration — which is why
 * `monacoSetup` calls it at module scope.
 */
export function installIsolatedTsFallback(monaco: typeof MonacoApi): void {
  if (installed) return;
  installed = true;
  monaco.typescript.typescriptDefaults.setModeConfiguration(WORKER_MODE_CONFIGURATION);
  monaco.typescript.javascriptDefaults.setModeConfiguration(WORKER_MODE_CONFIGURATION);
  // Imported when first needed rather than at the top: the adapters live in the monaco chunk,
  // which is already loaded by the time a provider is asked anything.
  const features = import("monaco-editor/languages/features/typescript/languageFeatures");
  register(monaco, "typescript", features);
  register(monaco, "javascript", features);
}

function register(monaco: typeof MonacoApi, language: "typescript" | "javascript", features: Promise<Features>) {
  type Adapters = ReturnType<typeof build>;
  const build = (module: Features) => {
    const accessor =
      language === "typescript" ? monaco.typescript.getTypeScriptWorker : monaco.typescript.getJavaScriptWorker;
    const worker = async (...uris: MonacoApi.Uri[]) => (await accessor())(...uris);
    const libFiles = new module.LibFiles(worker);
    return {
      suggest: new module.SuggestAdapter(worker),
      signature: new module.SignatureHelpAdapter(worker),
      hover: new module.QuickInfoAdapter(worker),
      definition: new module.DefinitionAdapter(libFiles, worker),
      references: new module.ReferenceAdapter(libFiles, worker),
      rename: new module.RenameAdapter(libFiles, worker),
      codeActions: new module.CodeActionAdaptor(worker),
    };
  };
  let adapters: Promise<Adapters> | null = null;
  const get = () => (adapters ??= features.then(build));

  /**
   * Runs `ask` only when the worker is the one to answer, and turns a failure into no answer. The
   * worker is set up asynchronously after the first model activates the language, so the very
   * first request can find it not registered yet — that is "nothing to say", not an error.
   */
  const gated = async <T>(model: MonacoApi.editor.ITextModel, ask: (a: Adapters) => Promise<T>) => {
    if (!workerAnswers(model.uri)) return undefined;
    try {
      return await ask(await get());
    } catch {
      return undefined;
    }
  };

  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ["."],
    provideCompletionItems: (model, position, context, token) =>
      gated(model, (a) => a.suggest.provideCompletionItems(model, position, context, token)),
    // Only ever asked about an item this provider produced, so it needs no gate of its own.
    resolveCompletionItem: async (item, token) => (await get()).suggest.resolveCompletionItem(item, token),
  });
  monaco.languages.registerSignatureHelpProvider(language, {
    signatureHelpTriggerCharacters: ["(", ","],
    provideSignatureHelp: (model, position, token, context) =>
      gated(model, (a) => a.signature.provideSignatureHelp(model, position, token, context)),
  });
  monaco.languages.registerHoverProvider(language, {
    provideHover: (model, position, token) => gated(model, (a) => a.hover.provideHover(model, position, token)),
  });
  monaco.languages.registerDefinitionProvider(language, {
    provideDefinition: (model, position, token) =>
      gated(model, (a) => a.definition.provideDefinition(model, position, token)),
  });
  monaco.languages.registerReferenceProvider(language, {
    provideReferences: (model, position, context, token) =>
      gated(model, (a) => a.references.provideReferences(model, position, context, token)),
  });
  // A rename the worker is not answering must say *nothing* (`undefined`) rather than "no edits":
  // Monaco takes the first provider that answers at all, and an empty answer from here would stop
  // it before it reached the compiler's.
  monaco.languages.registerRenameProvider(language, {
    provideRenameEdits: (model, position, newName, token) =>
      gated(model, (a) => a.rename.provideRenameEdits(model, position, newName, token)) as Promise<
        (MonacoApi.languages.WorkspaceEdit & MonacoApi.languages.Rejection) | undefined
      >,
  });
  monaco.languages.registerCodeActionProvider(language, {
    provideCodeActions: (model, range, context, token) =>
      gated(model, (a) => a.codeActions.provideCodeActions(model, range, context, token)),
  });
}
