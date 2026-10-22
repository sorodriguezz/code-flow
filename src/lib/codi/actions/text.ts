import { useUiStore } from "../../../state/uiStore";
import { useWindowStore } from "../../../state/windowStore";
import { SHORTCUT_BY_ID } from "../../shortcuts";
import { WINDOW } from "../../windowIdentity";
import { insertDictation, type DictationField } from "../../dictation/insert";
import { matchByName } from "../fuzzy";
import { accessibleName, isPrivateControl, isTextField } from "../dom";
import { CodiError, type CodiAction } from "../registry";
import { literal } from "../vocabulary";
import { defineAction, flag, forwardTo, oneOf, optionalText, params, requireProject, say, text } from "./shared";

/** Which chat, as said. */
const CHAT_TARGETS = {
  repo: { es: ["repo", "repositorio", "el asistente", "panel", "chat del repo"], en: ["repo", "repository", "the assistant", "repo chat"] },
  app: { es: ["app de chat", "la app chat", "chat general", "el chat"], en: ["chat app", "the chat app", "general chat"] },
};

/**
 * Writing: into the field on screen, into a chat, into the editor — and sending what was written.
 *
 * # Which field
 *
 * `text.type` writes where the user would expect without being told: the field with the caret; else
 * the one Codi last wrote into, if it is still there; else the window's only AI composer. Named
 * (`target`), it finds the field by its label or placeholder, loosely matched — "the search box",
 * "mensaje". The code editor is a target of its own (`editor`): Monaco is not an `<input>`, and its
 * text goes in as one edit at the caret, which ⌘Z takes back whole.
 *
 * Fields inside `[data-codi-private]` and password fields are refused here exactly as `dom.ts` refuses
 * them: Codi never writes a secret any more than it reads one.
 *
 * # Sending
 *
 * The composers register how they send with `registerDictationSend`, but that registry is private to
 * the dictation store, so sending here takes the two routes dictation itself falls back to: the form's
 * own submit when the field is in one, else Enter — which every composer in the app sends on.
 */

/** The field Codi last wrote into, for a "send it" that comes as a second order. A plain reference
 *  (the lib target predates `WeakRef`), dropped as soon as it is found detached. */
let lastField: Element | null = null;

function lastFieldIfThere(): Element | null {
  if (lastField && !lastField.isConnected) lastField = null;
  return lastField;
}

function isEditorElement(el: Element): boolean {
  return Boolean(el.closest(".monaco-editor"));
}

/** The text field with the caret, or `"editor"` when the caret is in a code editor. */
function focusedField(): Element | "editor" | null {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  if (isEditorElement(el)) return "editor";
  return isTextField(el) ? el : null;
}

function visible(el: Element): boolean {
  return el.getClientRects().length > 0;
}

/** Every visible field Codi may write into. */
function writableFields(): Element[] {
  return [...document.querySelectorAll("input, textarea, [contenteditable='true'], [contenteditable='']")].filter(
    (el) => isTextField(el) && !isPrivateControl(el) && !isEditorElement(el) && visible(el),
  );
}

/** The field `target` names, by label or placeholder — or a refusal that lists what there is. */
function fieldNamed(target: string): Element {
  const fields = writableFields();
  const found = matchByName(fields, target, accessibleName);
  if (found.kind === "match") return found.item;
  const names = (found.kind === "ambiguous" ? found.candidates : fields).map(accessibleName).filter(Boolean);
  throw new CodiError(
    found.kind === "ambiguous"
      ? `"${target}" matches several fields: ${names.join(", ")}`
      : `no field called "${target}" on screen${names.length ? `; there are: ${names.slice(0, 20).join(", ")}` : ""}`,
  );
}

/** Where `text.type` writes, by the order in the module note. */
function resolveField(target: string | undefined): Element | "editor" {
  if (target && /^(editor|code|c[oó]digo)$/i.test(target.trim())) return "editor";
  if (target) return fieldNamed(target);
  const focused = focusedField();
  if (focused) return focused;
  const last = lastFieldIfThere();
  if (last && visible(last)) return last;
  const composers = writableFields().filter((el) => el.closest("[data-ai-input]"));
  if (composers.length === 1) return composers[0];
  throw new CodiError("no field has the caret — name the field (target: its label or placeholder), or use ui.controls to find it");
}

/** One edit at the caret of the focused code editor, replacing the selection — `codeToEditor`'s insert. */
async function typeIntoEditor(value: string): Promise<void> {
  const { focusedCodeEditor } = await import("../../../components/editor/pasteJsonAsCode");
  const editor = focusedCodeEditor();
  if (!editor) throw new CodiError("no file is open in a focused editor pane");
  const selection = editor.getSelection();
  if (!selection) throw new CodiError("the editor has no caret");
  editor.pushUndoStop();
  editor.executeEdits("codi-type", [{ range: selection, text: value, forceMoveMarkers: true }]);
  editor.pushUndoStop();
  editor.focus();
}

/** Writes `value` into `field` where its caret is — React-safe, like dictation. */
function typeInto(field: Element, value: string): void {
  if (isPrivateControl(field)) throw new CodiError("that field is private — Codi does not write secrets");
  const name = field.tagName.toLowerCase();
  if (name === "input" || name === "textarea") {
    const input = field as DictationField;
    const focused = document.activeElement === field;
    insertDictation(input, value, focused ? { start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length } : null);
  } else {
    (field as HTMLElement).focus();
    document.execCommand("insertText", false, value);
  }
  lastField = field;
}

/** Sends what `field` holds: its form's submit, else Enter. Answers which. */
function submit(field: Element): "form" | "enter" {
  const form = (field as HTMLInputElement).form ?? field.closest("form");
  if (form && typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return "form";
  }
  field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  return "enter";
}

/** After React has rendered what was just typed: the composers send what is in their state. */
function afterRender(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Waits for the chat app's composer to take the caret (`focusChatComposer`), up to a few seconds —
 *  the view is lazy, so on a first visit it has to load before there is anything to focus. */
async function chatComposer(): Promise<DictationField> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const el = document.activeElement;
    if (el && el.tagName === "TEXTAREA" && el.closest("[data-ai-input]")) return el as DictationField;
    if (Date.now() > deadline) throw new CodiError("the chat's composer did not come up");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Into the Chat app's composer, and sent if asked — in whichever window holds the chat. */
export async function askInChatApp(value: string, send: boolean): Promise<void> {
  useUiStore.getState().focusChatComposer();
  const field = await chatComposer();
  typeInto(field, value);
  if (send) {
    await afterRender();
    submit(field);
  }
}

const askText = text("What to ask.");
const askSend = flag("Send it now (true) or leave it written in the composer (false, the default).");

/** The repository open in this window, or `null` — "is there a repository chat to ask in". */
function openProjectOrNull() {
  try {
    return requireProject();
  } catch {
    return null;
  }
}

/** `chat.ask` for the main window: the repository's chat, or the Chat app — handed to its island when it has one. */
const chatAsk = defineAction({
  id: "chat.ask",
  title: {
    en: "Put a question in a chat — the open repository's (assistant panel) or the Chat app's — and send it if asked.",
    es: "Escribe una pregunta en un chat —el del repositorio abierto (panel del asistente) o el de la app Chat— y la envía si se pide.",
  },
  aliases: { es: ["preguntale al chat", "pregunta en el chat", "pregunta", "preguntale", "escribe en el chat", "dile al chat", "consulta"], en: ["ask the chat", "ask", "ask in the chat", "tell the chat", "write in the chat"] },
  get vocabulary() {
    return { target: literal(CHAT_TARGETS) };
  },
  params: params(
    {
      text: askText,
      send: askSend,
      target: oneOf(["repo", "app"], "repo: the open repository's chat in the assistant panel (the default with a repository open). app: the Chat app."),
    },
    ["text"],
  ),
  risk: "write",
  where: "main",
  frequent: true,
  run: async ({ text: value, send, target }, ctx) => {
    const project = openProjectOrNull();
    const where = target ?? (project ? "repo" : "app");
    if (where === "repo") {
      const repo = requireProject();
      const { askInRepoChat } = await import("../../aiPanelNav");
      askInRepoChat(repo.id, String(value), { send: send === true });
    } else {
      const island = useWindowStore.getState().detachedLabel("app", "chat");
      if (island && island !== WINDOW.label) return forwardTo(island, ctx);
      await askInChatApp(String(value), send === true);
    }
    return {
      result: { chat: where, sent: send === true },
      say: say(send === true ? "codi.say.chatSent" : "codi.say.chatDrafted"),
    };
  },
});

/** `chat.ask` in the Chat app's island: there is only the one chat to ask in. */
const chatAskHere = defineAction({
  ...chatAsk,
  params: params({ text: askText, send: askSend }, ["text"]),
  // No `target` here, so nothing to name.
  vocabulary: undefined,
  where: "app:chat",
  run: async ({ text: value, send }) => {
    await askInChatApp(String(value), send === true);
    return { result: { chat: "app", sent: send === true }, say: say(send === true ? "codi.say.chatSent" : "codi.say.chatDrafted") };
  },
});

const textType = defineAction({
  id: "text.type",
  title: {
    en: "Type text into a field: the one with the caret, or one named by its label or placeholder (target), or the code editor (target: editor). submit sends it after.",
    es: "Escribe texto en un campo: el que tiene el cursor, uno nombrado por su etiqueta o placeholder (target) o el editor de código (target: editor). submit lo envía después.",
  },
  aliases: { es: ["escribe", "teclea", "pon", "rellena con"], en: ["type", "write", "enter", "fill in"] },
  params: params(
    {
      text: text("What to type."),
      target: optionalText("The field's label or placeholder, or \"editor\". Left out: the field with the caret."),
      submit: flag("Send what the field holds afterwards (Enter / the form's submit)."),
    },
    ["text"],
  ),
  risk: "write",
  where: "any",
  frequent: true,
  run: async ({ text: value, target, submit: andSubmit }) => {
    const field = resolveField(target as string | undefined);
    if (field === "editor") {
      await typeIntoEditor(String(value));
      return { result: { typed: "editor" }, say: say("codi.say.typed") };
    }
    typeInto(field, String(value));
    let sent: string | undefined;
    if (andSubmit === true) {
      await afterRender();
      sent = submit(field);
    }
    return {
      result: { typed: accessibleName(field) || field.tagName.toLowerCase(), ...(sent ? { submitted: sent } : {}) },
      say: say(sent ? "codi.say.typedAndSent" : "codi.say.typed"),
    };
  },
});

const textSubmit = defineAction({
  id: "text.submit",
  title: {
    en: "Send what the field with the caret (or the one last typed into) holds — like pressing Enter in it.",
    es: "Envía lo que tiene el campo con el cursor (o el último en que se escribió), como pulsar Intro en él.",
  },
  aliases: { es: ["envia", "envialo", "enviar", "manda", "mandalo", "dale enter", "presiona enter", "confirma"], en: ["send", "send it", "submit", "press enter", "hit enter"] },
  params: params(),
  risk: "write",
  where: "any",
  frequent: true,
  run: async () => {
    const focused = focusedField();
    const field = focused && focused !== "editor" ? focused : lastFieldIfThere();
    if (!field) throw new CodiError("no field to send — type into one first (text.type)");
    if (isPrivateControl(field)) throw new CodiError("that field is private");
    const how = submit(field);
    return { result: { submitted: how }, say: say("codi.say.sent") };
  },
});

const editorOpen = defineAction({
  id: "editor.open",
  title: {
    en: "Open a file of the open repository in the editor, optionally at a line. path is relative to the repository (an absolute path inside it works too).",
    es: "Abre un archivo del repositorio abierto en el editor, opcionalmente en una línea. path es relativo al repositorio (una ruta absoluta dentro de él también sirve).",
  },
  aliases: { es: ["abre el archivo", "abre el fichero", "muestra el archivo", "ve al archivo", "edita el archivo"], en: ["open file", "open the file", "show the file", "go to file", "edit the file"] },
  params: params(
    { path: text("The file's path."), line: { type: "integer", minimum: 1, description: "1-based line to reveal." } },
    ["path"],
  ),
  risk: "navigate",
  where: "main",
  frequent: true,
  run: async ({ path, line }) => {
    const project = requireProject();
    const root = project.local_path.replace(/\\/g, "/").replace(/\/+$/, "");
    let rel = String(path).replace(/\\/g, "/").trim();
    if (rel === root || rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1);
    else if (/^([a-zA-Z]:)?\//.test(rel)) throw new CodiError(`${String(path)} is outside the repository ${project.name} (${root})`);
    rel = rel.replace(/^\.\//, "");
    if (!rel || rel.split("/").includes("..")) throw new CodiError("path must name a file inside the repository");
    useUiStore.getState().openInEditor(rel, typeof line === "number" ? line : undefined);
    const name = rel.slice(rel.lastIndexOf("/") + 1);
    return { result: { opened: rel, line: line ?? null }, say: say("codi.say.fileOpened", { name }) };
  },
});

const editorSave = defineAction({
  id: "editor.save",
  title: {
    en: "Save the file on screen in the editor (or the open request in the API client); all saves every unsaved tab.",
    es: "Guarda el archivo en pantalla en el editor (o la petición abierta en el cliente API); all guarda todas las pestañas sin guardar.",
  },
  aliases: { es: ["guarda", "guardalo", "guarda el archivo", "guarda todo", "guardar"], en: ["save", "save it", "save the file", "save all", "save everything"] },
  params: params({ all: flag("Every unsaved tab of the repository.") }),
  risk: "write",
  where: "any",
  frequent: true,
  run: async ({ all }) => {
    const view = useUiStore.getState().activeView;
    if (view !== "editor" && !(view === "api" && all !== true)) {
      throw new CodiError("the editor is not on screen — open it first (view.open editor)", say("codi.say.editorNotOpen"));
    }
    SHORTCUT_BY_ID.get(all === true ? "editor.saveAll" : "editor.save")?.run?.();
    return { result: { saved: all === true ? "all" : "active" }, say: say(all === true ? "codi.say.savedAll" : "codi.say.saved") };
  },
});

/** The main window's. */
export function textActions(): CodiAction[] {
  return [chatAsk, textType, textSubmit, editorOpen, editorSave];
}

/** Every island types and sends; the chat's island asks; a floating editor saves. */
export function textSatelliteActions(kind: "app" | "repo" | "file", refId: string): CodiAction[] {
  const list = [textType, textSubmit];
  if (kind === "app" && refId === "chat") list.push(chatAskHere);
  if (kind === "file") list.push(editorSave);
  return list;
}
