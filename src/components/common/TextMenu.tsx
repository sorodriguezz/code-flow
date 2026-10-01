import { useState, type ReactNode } from "react";
import { ClipboardPaste, Copy, Scissors, TextSelect } from "lucide-react";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";

type TextField = HTMLTextAreaElement | HTMLInputElement;

/**
 * Replaces `start..end` of a field with `text`, the way typing would.
 *
 * `execCommand("insertText")` first, because it is the one route that keeps the field's undo stack
 * and fires the `input` event React's `onChange` listens to. Deprecated, and still what every
 * WebKit and Chromium build implements; where it refuses, the value is written through the native
 * setter — the one React does not shadow — and the event is raised by hand.
 */
function replaceRange(field: TextField, start: number, end: number, text: string) {
  field.focus();
  field.setSelectionRange(start, end);
  const done = text ? document.execCommand("insertText", false, text) : document.execCommand("delete");
  if (done) return;
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, field.value.slice(0, start) + text + field.value.slice(end));
  field.setSelectionRange(start + text.length, start + text.length);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** The clipboard's text, `""` when it holds none, `null` when it cannot be read — which keeps
 *  "Paste" on offer, since the click may well succeed where this read did not. */
async function clipboardText(): Promise<string | null> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

function copy(text: string) {
  void navigator.clipboard.writeText(text).catch((e: unknown) => pushErrorToast(String(e)));
}

/**
 * The app's own menu for text, in place of the webview's.
 *
 * A right-click in a text field used to fall through to the platform menu (`contextMenuGuard` lets
 * it, having had nothing of its own to offer there) — Look Up, Translate, Services, Speech — and on
 * selected text anywhere else it opened nothing at all. This is what both now open instead:
 *
 * - `onField`, on a `<textarea>`/`<input>`: Cut and Copy when something is selected, Paste when the
 *   clipboard holds text, Select all when there is more to select. Nothing that does not apply.
 * - `onText`, on a read-only area like a transcript: Copy for the selection inside it, plus whatever
 *   `extra` adds for that passage. Without a selection it stands aside, and the guard keeps the
 *   platform's menu away as before.
 *
 * Render `menu` once, anywhere in the component.
 */
export function useTextMenu(extra?: (passage: string) => MenuItem[]): {
  onField: (event: React.MouseEvent<TextField>) => void;
  onText: (event: React.MouseEvent<HTMLElement>) => void;
  menu: ReactNode;
} {
  const t = useT();
  const [open, setOpen] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const onField = (event: React.MouseEvent<TextField>) => {
    event.preventDefault();
    // Captured now: the event's `currentTarget` is gone after this handler returns, and the
    // selection may be by the time a menu item is clicked.
    const field = event.currentTarget;
    const at = { x: event.clientX, y: event.clientY };
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    const selected = field.value.slice(start, end);
    const editable = !field.readOnly && !field.disabled;
    void (editable ? clipboardText() : Promise.resolve("")).then((clip) => {
      const items: MenuItem[] = [];
      if (selected && editable) {
        items.push({
          label: t("textMenu.cut"),
          icon: Scissors,
          onClick: () =>
            void navigator.clipboard
              .writeText(selected)
              .then(() => replaceRange(field, start, end, ""))
              .catch((e: unknown) => pushErrorToast(String(e))),
        });
      }
      if (selected) items.push({ label: t("textMenu.copy"), icon: Copy, onClick: () => copy(selected) });
      if (editable && clip !== "") {
        items.push({
          label: t("textMenu.paste"),
          icon: ClipboardPaste,
          onClick: () =>
            void (clip === null ? clipboardText() : Promise.resolve(clip)).then((text) => {
              if (text) replaceRange(field, start, end, text);
            }),
        });
      }
      if (field.value && selected.length < field.value.length) {
        items.push({
          label: t("textMenu.selectAll"),
          icon: TextSelect,
          separated: items.length > 0,
          onClick: () => {
            field.focus();
            field.select();
          },
        });
      }
      if (items.length > 0) setOpen({ ...at, items });
    });
  };

  const onText = (event: React.MouseEvent<HTMLElement>) => {
    // A field inside the area answers for itself.
    const target = event.target;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
    const selection = window.getSelection();
    const passage = selection?.toString() ?? "";
    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !passage.trim()) return;
    if (!event.currentTarget.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
    event.preventDefault();
    setOpen({
      x: event.clientX,
      y: event.clientY,
      items: [{ label: t("textMenu.copy"), icon: Copy, onClick: () => copy(passage) }, ...(extra?.(passage.trim()) ?? [])],
    });
  };

  const menu = open ? <ContextMenu x={open.x} y={open.y} items={open.items} onClose={() => setOpen(null)} /> : null;
  return { onField, onText, menu };
}
