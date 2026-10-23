import { WINDOW } from "../../windowIdentity";
import { useUiStore } from "../../../state/uiStore";
import { fillControl, listControls, pressControl } from "../dom";
import { CodiError, undoNavigation, type CodiAction } from "../registry";
import { uiStateAction } from "../state";
import { defineAction, flag, optionalText, params, say, text } from "./shared";

/**
 * The generic four every window has: what is on screen (`ui.state`), and the fallback for anything
 * no typed action reaches — list the controls, press one, fill one. See `dom.ts` for what is never
 * listed and why a destructive-sounding press needs `confirmed`.
 */

/** Whether everything in this window is the keyring's — its island, or the main window on it. */
function keyringOnScreen(): boolean {
  if (WINDOW.satellite?.kind === "app") return WINDOW.satellite.refId === "vault";
  return false;
}

export function uiActions(): CodiAction[] {
  return [
    uiStateAction,
    defineAction({
      id: "nav.undo",
      title: {
        en: "Undo the last move Codi made in this window — back to the view, workspace and repository it was on before.",
        es: "Deshace el último movimiento que hizo Codi en esta ventana: vuelve a la vista, el workspace y el repositorio de antes.",
      },
      aliases: {
        es: ["deshaz", "deshazlo", "deshacer", "vuelve a donde estaba", "vuelve como estaba", "regresa a donde estaba", "dejalo como estaba", "anula eso"],
        en: ["undo", "undo that", "go back to where i was", "put it back", "take me back"],
      },
      params: params(),
      risk: "navigate",
      where: "any",
      // Said plainly («deshaz»), the router takes it: its typed tool went to knowledge.ask.
      run: async () => {
        if (!(await undoNavigation())) {
          throw new CodiError("nothing to undo — Codi has not moved this window yet", say("codi.say.nothingToUndo"));
        }
        return { result: { undone: true }, say: say("codi.say.undone") };
      },
    }),
    defineAction({
      id: "ui.controls",
      title: {
        en: "List the controls this window shows (role, name, a ref like c12) — the fallback when no typed action fits. Private fields and the keyring are never listed.",
        es: "Lista los controles que muestra esta ventana (rol, nombre, una ref como c12): el recurso cuando ninguna acción tipada sirve. Los campos privados y el Llavero nunca se listan.",
      },
      aliases: { es: ["que botones hay", "que controles hay", "lista los botones"], en: ["which buttons", "list the controls", "what can i press"] },
      params: params({ filter: optionalText("Only controls whose name or role contains these words.") }),
      risk: "read",
      where: "any",
      run: async ({ filter }) => {
        const { controls, truncated } = listControls(document, {
          filter: filter as string | undefined,
          everythingPrivate: keyringOnScreen(),
        });
        return {
          result: {
            controls,
            ...(truncated ? { more: truncated, hint: "narrow with filter" } : {}),
            ...(keyringOnScreen() || (WINDOW.main && useUiStore.getState().activeView === "vault") ? { note: "the keyring's controls are private" } : {}),
          },
        };
      },
    }),
    defineAction({
      id: "ui.press",
      title: {
        en: "Press a control by its ref from ui.controls. One whose name sounds destructive (delete, discard, push, send, merge, force…) answers needs-confirmation until resent with confirmed.",
        es: "Pulsa un control por su ref de ui.controls. Uno cuyo nombre suene destructivo (eliminar, descartar, push, enviar, merge, forzar…) responde needs-confirmation hasta reenviarse con confirmed.",
      },
      aliases: { es: ["pulsa", "presiona", "haz clic en", "aprieta", "dale a"], en: ["press", "click", "tap", "hit"] },
      params: params({ ref: text("The control's ref, e.g. c12."), confirmed: flag("The user said yes to a destructive press.") }, ["ref"]),
      risk: "write",
      where: "any",
      run: async ({ ref, confirmed }) => {
        const outcome = pressControl(String(ref), confirmed === true);
        if (!outcome.ok) {
          if (outcome.error === "needs-confirmation" && "name" in outcome) {
            throw new CodiError("needs-confirmation", say("codi.say.confirmPress", { name: outcome.name }));
          }
          throw new CodiError(outcome.error);
        }
        return { result: { pressed: outcome.name, role: outcome.role }, say: say("codi.say.pressed", { name: outcome.name }) };
      },
    }),
    defineAction({
      id: "ui.fill",
      title: {
        en: "Replace what a text field holds, by its ref from ui.controls. Never a private field.",
        es: "Reemplaza lo que tiene un campo de texto, por su ref de ui.controls. Nunca un campo privado.",
      },
      aliases: { es: ["llena", "rellena", "completa el campo"], en: ["fill", "fill in", "complete the field"] },
      params: params({ ref: text("The field's ref, e.g. c7."), text: { type: "string", description: "What the field should hold." } }, ["ref", "text"]),
      risk: "write",
      where: "any",
      run: async ({ ref, text: value }) => {
        const outcome = fillControl(String(ref), String(value ?? ""));
        if (!outcome.ok) throw new CodiError(outcome.error);
        return { result: { filled: outcome.name }, say: say("codi.say.filled", { name: outcome.name }) };
      },
    }),
  ];
}
