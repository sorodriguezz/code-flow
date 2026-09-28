/**
 * Types for the adapters behind Monaco's own TypeScript/JavaScript support, which it ships none for
 * (`languageFeatures.js` sits beside a `register.d.ts` that only covers the public defaults).
 *
 * Deliberately narrow: only the constructors and the provider methods `lib/tsWorkerFallback` calls.
 * The adapters are internal to Monaco, so a release that moves or reshapes them fails the build
 * at the import instead of drifting quietly; see the note in `tsWorkerFallback`.
 */
declare module "monaco-editor/languages/features/typescript/languageFeatures" {
  import type { CancellationToken, IRange, Position, Uri, editor, languages } from "monaco-editor";

  type Worker = (...uris: Uri[]) => Promise<unknown>;

  export class LibFiles {
    constructor(worker: Worker);
  }

  export class SuggestAdapter {
    constructor(worker: Worker);
    readonly triggerCharacters: string[];
    provideCompletionItems(
      model: editor.ITextModel,
      position: Position,
      context: languages.CompletionContext,
      token: CancellationToken,
    ): Promise<languages.CompletionList | undefined>;
    resolveCompletionItem(item: languages.CompletionItem, token: CancellationToken): Promise<languages.CompletionItem>;
  }

  export class SignatureHelpAdapter {
    constructor(worker: Worker);
    readonly signatureHelpTriggerCharacters: string[];
    provideSignatureHelp(
      model: editor.ITextModel,
      position: Position,
      token: CancellationToken,
      context: languages.SignatureHelpContext,
    ): Promise<languages.SignatureHelpResult | undefined>;
  }

  export class QuickInfoAdapter {
    constructor(worker: Worker);
    provideHover(model: editor.ITextModel, position: Position, token: CancellationToken): Promise<languages.Hover | undefined>;
  }

  export class DefinitionAdapter {
    constructor(libFiles: LibFiles, worker: Worker);
    provideDefinition(
      model: editor.ITextModel,
      position: Position,
      token: CancellationToken,
    ): Promise<languages.Definition | undefined>;
  }

  export class ReferenceAdapter {
    constructor(libFiles: LibFiles, worker: Worker);
    provideReferences(
      model: editor.ITextModel,
      position: Position,
      context: languages.ReferenceContext,
      token: CancellationToken,
    ): Promise<languages.Location[] | undefined>;
  }

  export class RenameAdapter {
    constructor(libFiles: LibFiles, worker: Worker);
    provideRenameEdits(
      model: editor.ITextModel,
      position: Position,
      newName: string,
      token: CancellationToken,
    ): Promise<(languages.WorkspaceEdit & languages.Rejection) | undefined>;
  }

  export class CodeActionAdaptor {
    constructor(worker: Worker);
    provideCodeActions(
      model: editor.ITextModel,
      range: IRange,
      context: languages.CodeActionContext,
      token: CancellationToken,
    ): Promise<languages.CodeActionList | undefined>;
  }

  export class InlayHintsAdapter {
    constructor(worker: Worker);
    provideInlayHints(
      model: editor.ITextModel,
      range: IRange,
      token: CancellationToken,
    ): Promise<languages.InlayHintList | undefined>;
  }
}
