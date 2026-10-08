import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Mic } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { aiFieldOf, type DictationField } from "../../lib/dictation/insert";
import { eventToChord } from "../../lib/keys";
import { bindingFor, useShortcutsStore } from "../../state/shortcutsStore";
import { useT } from "../../state/languageStore";
import { dictationReady, useDictationStore } from "../../state/dictationStore";
import { DictationBar, useDictationChord } from "./DictationControls";

/**
 * «Dictar» for every AI field that has no microphone of its own — the Flows builder, the diagram,
 * note and docs assistants, the agents' and stories' instructions. Mounted once per window.
 *
 * A field takes part by carrying `data-ai-input`; one that draws the microphone and the bar itself
 * says `data-ai-input="inline"` and is left alone here. While such a field has the focus a small
 * microphone sits in its bottom-right corner; while it records, the bar floats under it (over it,
 * when there is no room below). Nothing is drawn while focus is anywhere else — the feature is
 * global, but it only wakes up in a field whose text goes to a model.
 */

function useRect(element: DictationField | null): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    if (!element) {
      setRect(null);
      return;
    }
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setRect(element.getBoundingClientRect()));
    };
    setRect(element.getBoundingClientRect());
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [element]);
  return rect;
}

const floating = (field: DictationField | null) => !!field && field.closest("[data-ai-input]")?.getAttribute("data-ai-input") !== "inline";

/**
 * `shortcut`: listen for the dictation chord here. The main window's shortcuts run it already
 * (`useGlobalShortcuts`); a detached window mounts none of them, so it asks this to.
 */
export function DictationOverlay({ shortcut = false }: { shortcut?: boolean }) {
  const t = useT();
  const ready = useDictationStore((s) => dictationReady(s));
  const phase = useDictationStore((s) => s.phase);
  const target = useDictationStore((s) => s.target);
  const inline = useDictationStore((s) => s.inline);
  const load = useDictationStore((s) => s.load);
  const start = useDictationStore((s) => s.start);
  const chord = useDictationChord();
  const [focused, setFocused] = useState<DictationField | null>(null);

  useEffect(() => {
    void load();
    const onIn = (event: FocusEvent) => setFocused(aiFieldOf(event.target));
    // After the move settles: focus going to the corner microphone is cancelled, so it stays put.
    const onOut = () => setTimeout(() => setFocused(aiFieldOf(document.activeElement)), 0);
    document.addEventListener("focusin", onIn);
    document.addEventListener("focusout", onOut);
    return () => {
      document.removeEventListener("focusin", onIn);
      document.removeEventListener("focusout", onOut);
    };
  }, [load]);

  useEffect(() => {
    if (!shortcut) return;
    const onKey = (event: KeyboardEvent) => {
      const chord = bindingFor("dictation.toggle", useShortcutsStore.getState().overrides);
      if (!chord || eventToChord(event) !== chord) return;
      event.preventDefault();
      useDictationStore.getState().toggle();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shortcut]);

  const anchor = phase !== "idle" ? (!inline ? target : null) : floating(focused) && focused?.isConnected ? focused : null;
  const rect = useRect(ready ? anchor : null);
  if (!ready || !anchor || !rect || rect.width === 0) return null;

  if (phase === "idle") {
    const single = rect.height < 44;
    return createPortal(
      <div
        className="fixed z-[70]"
        style={{ left: rect.right - 30, top: single ? rect.top + (rect.height - 24) / 2 : rect.bottom - 30 }}
      >
        <Tooltip label={t("dictation.dictate")} trailing={chord ? <span className="opacity-70">{chord}</span> : undefined}>
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void start(anchor, false)}
            aria-label={t("dictation.dictate")}
            className="flex h-6 w-6 items-center justify-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] text-[var(--cf-text-muted)] shadow-[var(--cf-shadow)] transition-colors hover:text-[var(--cf-text)]"
          >
            <Mic size={13} />
          </button>
        </Tooltip>
      </div>,
      document.body,
    );
  }

  const width = Math.max(260, Math.min(rect.width, 440));
  const below = rect.bottom + 48 <= window.innerHeight;
  return createPortal(
    <div
      className="fixed z-[70] flex items-center rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 shadow-[var(--cf-shadow)]"
      style={{ left: Math.min(rect.left, window.innerWidth - width - 8), top: below ? rect.bottom + 6 : rect.top - 44, width }}
    >
      <DictationBar />
    </div>,
    document.body,
  );
}
