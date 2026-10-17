import * as monaco from "monaco-editor";
import { inlineFileVariables, parseHttpFile } from "../../lib/api/importers";
import { tabActions } from "../api/tabActions";
import { ensureApiStoreLoaded, useApiStore } from "../../state/apiStore";
import { useUiStore } from "../../state/uiStore";
import { translate, useLanguageStore } from "../../state/languageStore";

/**
 * «▶ Enviar» over every request of a `.http` / `.rest` file in the editor — VS Code's REST Client and
 * JetBrains' HTTP Client files, run through this app's API client: the request opens as a scratch
 * tab (the file's `@variables` written into it, the environment's still `{{…}}`) and, for «Enviar»,
 * is sent at once.
 */

const SEND = "cf.httpFile.send";
const OPEN = "cf.httpFile.open";
const HTTP_FILE = /\.(http|rest)$/i;

let installed = false;
const changed = new monaco.Emitter<monaco.languages.CodeLensProvider>();

const provider: monaco.languages.CodeLensProvider = {
  onDidChange: changed.event,
  provideCodeLenses(model) {
    if (!HTTP_FILE.test(model.uri.path)) return { lenses: [], dispose: () => {} };
    const { requests } = parseHttpFile(model.getValue());
    const uri = model.uri.toString();
    return {
      lenses: requests.flatMap((request) => {
        const range = { startLineNumber: request.line + 1, startColumn: 1, endLineNumber: request.line + 1, endColumn: 1 };
        return [
          { range, command: { id: SEND, title: `▶ ${translate("api.httpFile.send")}`, arguments: [uri, request.line, true] } },
          { range, command: { id: OPEN, title: translate("api.httpFile.open"), arguments: [uri, request.line, false] } },
        ];
      }),
      dispose: () => {},
    };
  },
};

/** The builder registers its actions once it has mounted the tab; until then there is nothing to send. */
function sendWhenReady(tabId: string, tries = 0) {
  const actions = tabActions(tabId);
  if (actions) {
    actions.send();
    return;
  }
  if (tries < 60) window.setTimeout(() => sendWhenReady(tabId, tries + 1), 50);
}

async function run(uri: string, line: number, send: boolean) {
  const model = monaco.editor.getModel(monaco.Uri.parse(uri));
  if (!model) return;
  const { requests, variables } = parseHttpFile(model.getValue());
  const request = requests.find((candidate) => candidate.line === line);
  if (!request) return;
  useUiStore.getState().openApiWorkspace("requests");
  await ensureApiStoreLoaded();
  const store = useApiStore.getState();
  const tabId = store.openScratchTab("http");
  store.updateDraft(tabId, inlineFileVariables(request.spec, variables));
  store.renameTab(tabId, request.name);
  if (send) sendWhenReady(tabId);
}

/** Installs the provider and its commands once — Monaco's providers are global. */
export function installHttpFileLens(): void {
  if (installed) return;
  installed = true;
  monaco.editor.registerCommand(SEND, (_accessor: unknown, uri: string, line: number) => void run(uri, line, true));
  monaco.editor.registerCommand(OPEN, (_accessor: unknown, uri: string, line: number) => void run(uri, line, false));
  // Every language: a `.http` file opens as whatever the editor makes of it (plain text, mostly).
  monaco.languages.registerCodeLensProvider("*", provider);
  // The titles are translated when drawn.
  useLanguageStore.subscribe((state, previous) => {
    if (state.language !== previous.language) changed.fire(provider);
  });
}
