import { emitTo } from "@tauri-apps/api/event";
import { codiActResult, codiRegisterActions, onCodiAct, type CodiActRequest } from "../tauri/codiCommands";
import { WINDOW } from "../windowIdentity";
import { useWindowStore } from "../../state/windowStore";
import { useLanguageStore } from "../../state/languageStore";
import { actionSpecs, getAction, installScreenHistory, registerActions, runRequest } from "./registry";
import { screenHistory } from "./history";

/**
 * This window's end of «Codi»'s request/answer bus.
 *
 * At boot every window — the main one and each island — registers the actions it can run
 * (`codi_register_actions`, with its label) and starts answering `codi:act`. Every window hears
 * every request (a global `listen` receives events of any target), so each answers only those
 * carrying its own label, and answers each exactly once: with the action's outcome, or with
 * `{ ok: false }` for an unknown id, bad params or a handler that threw — never with silence, which
 * the backend could only read as a ten-second timeout.
 *
 * # The catalogue loads behind the first paint
 *
 * It is a dynamic import: the catalogue reaches into most of the app's stores (and, in the main
 * window, the palette's builders), none of which the first frame is waiting on. The bus is started
 * from the boot batch, and registers a moment later.
 *
 * # A dev build without the backend half
 *
 * `codi_register_actions` may not exist yet in the binary running this webview. That is said once,
 * at debug level, and otherwise ignored — the window works exactly as it did before Codi.
 *
 * # An app that left
 *
 * An action marked `where: "app:<key>"` runs in the window holding that app. The backend routes by
 * it, but the main window also checks on arrival: the app may have gone out to an island since the
 * backend last looked, and running it here would act on the copy this window has let go of
 * (`islandSync`). Such a request is handed to the island, which answers it.
 */

let started = false;
let warned = false;

function debugOnce(what: string, error: unknown): void {
  if (warned) return;
  warned = true;
  console.debug(`[codi] ${what} — the backend half is not in this build, or not up yet:`, error);
}

/** The island that should run `request` instead of this window, if there is one. Main window only. */
function islandFor(request: CodiActRequest): string | null {
  if (!WINDOW.main) return null;
  const where = getAction(request.action)?.where ?? "";
  if (!where.startsWith("app:")) return null;
  const app = where.slice(4);
  return useWindowStore.getState().satellites.find((s) => s.kind === "app" && s.ref_id === app)?.label ?? null;
}

/**
 * Answers one request, if it is this window's. Exported for the tests, which drive it with requests
 * addressed to this window and to others.
 */
export async function handleCodiRequest(request: CodiActRequest, label: string = WINDOW.label): Promise<void> {
  if (!request || request.window !== label) return;
  const island = islandFor(request);
  if (island && island !== label) {
    try {
      await emitTo(island, "codi:act", { ...request, window: island });
      return;
    } catch (error) {
      await codiActResult({ id: request.id, ok: false, error: `could not reach ${island}: ${String(error)}` }).catch(() => {});
      return;
    }
  }
  const { answer, after } = await runRequest(request, label);
  if (answer) await codiActResult(answer).catch((error: unknown) => debugOnce("codi_act_result failed", error));
  // After the answer: an action that ends this window (`island.return`) must have spoken first.
  after?.();
}

/** Sends this window's catalogue to the backend — at boot, and again on a language switch. */
async function announce(): Promise<void> {
  await codiRegisterActions(WINDOW.label, actionSpecs()).catch((error: unknown) =>
    debugOnce("codi_register_actions failed", error),
  );
}

/** Loads this window's catalogue, starts listening and registers it. Safe to call more than once. */
export function startCodiBus(): void {
  if (started) return;
  started = true;
  void (async () => {
    const { catalogueFor } = await import("./actions");
    registerActions(catalogueFor(WINDOW));
    // What `nav.undo` puts back: the screen before each navigation this bus runs.
    installScreenHistory(screenHistory);
    // Listening before registering, so a request sent the moment the backend learns of an action
    // finds someone to answer it.
    await onCodiAct((request) => void handleCodiRequest(request));
    await announce();
    // The spoken names (`vocabulary`) are the UI's labels in the languages loaded when the specs are
    // copied; switching language loads the other dictionary, so the catalogue is sent again with it.
    useLanguageStore.subscribe((state, previous) => {
      if (state.language !== previous.language) void announce();
    });
  })().catch((error: unknown) => console.error("[codi] the bus did not start:", error));
}

/** Tests only. */
export function resetCodiBusForTests(): void {
  started = false;
  warned = false;
}
