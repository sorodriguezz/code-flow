import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GripHorizontal, Sparkles, X } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../../lib/aiProviders";
import { notesWriteWithAi } from "../../lib/tauri/notesCommands";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useNotesStore } from "../../state/notesStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** The routing row this runs under — `AiTask::Notes` on the Rust side. */
const TASK = "notes";

/** Where the window opens: inset from the editor's top-right corner, over the gutter rather than
 *  over the caret, which is where someone typing at the top of a note actually is. */
const MARGIN = 12;

/**
 * Asks an engine for Markdown to put in the note.
 *
 * **A floating window over the editor, not a modal.** The instruction is written *about* the text
 * underneath it — "expand this section", "turn the list below into a table" — and a full-screen
 * dialog covers the one thing the user needs to look at while writing it. So there is no backdrop,
 * the editor stays live behind it, and the window can be dragged out of the way by its header.
 *
 * **The engine is not picked here.** It used to be, with its own provider/model selects and a
 * choice remembered per workspace — which made notes the one feature whose model lived somewhere
 * other than Settings → AI → model per task. Now it routes through the `notes` task like everything
 * else, and this window only *says* what it will run on.
 *
 * What comes back is inserted, never auto-saved over anything: with a selection it replaces it,
 * without one it lands at the caret. Either way it is one Monaco edit, so **Ctrl+Z takes it back
 * out** — which is the only thing that makes a generate button safe to press on a document you
 * care about.
 */
export function NoteAiPanel({
  selection,
  onInsert,
  onClose,
}: {
  /** The editor's selection when the window opened, or `""`. Shown so the user knows what will be
   *  replaced — taken then rather than read on submit, because focus is in here by now. */
  selection: string;
  onInsert: (markdown: string) => void;
  onClose: () => void;
}) {
  const draft = useNotesStore((s) => s.draft);
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const routedProvider = useAiProviderStore((s) => s.taskProviders[TASK]);
  const routedModel = useAiProviderStore((s) => s.taskModels[TASK]);
  const t = useT();

  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);

  const panel = useRef<HTMLDivElement>(null);
  /** Null until the window is dragged: it sits at its default corner, laid out by the browser, so
   *  a pane resize keeps it in the corner instead of stranding it at coordinates from a wider one. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // The engine, resolved through the same fallback chain the backend uses, so this cannot disagree
  // with what actually runs. Blank is a real state and not a missing read — neither the task
  // override nor the provider's base model is set, so the CLI picks its own.
  const providerId = routedProvider?.trim() || defaultProvider || DEFAULT_AI_PROVIDER;
  const provider = AI_PROVIDERS.find((entry) => entry.id === providerId);
  const providerLabel = provider?.label ?? (provider?.labelKey ? t(provider.labelKey) : providerId);
  const modelLabel = routedModel?.trim() || t("notes.ai.defaultModel");
  const EngineIcon = provider?.icon;

  /** Keeps the window inside the editor pane. Called while dragging and whenever the pane resizes
   *  — opening the outline or dragging the split narrows it under a window already placed. */
  const clamp = useCallback((x: number, y: number) => {
    const element = panel.current;
    const parent = element?.offsetParent as HTMLElement | null;
    if (!element || !parent) return { x, y };
    const maxX = Math.max(0, parent.clientWidth - element.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - element.offsetHeight);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

  useLayoutEffect(() => {
    const parent = panel.current?.offsetParent as HTMLElement | null;
    if (!parent || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setPos((current) => (current ? clamp(current.x, current.y) : null));
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [clamp]);

  const onDragStart = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = panel.current;
    if (!element || event.button !== 0) return;
    // From the live box, not from `pos`: the first drag starts wherever the default corner put it,
    // and reading it here is what makes that first grab not jump.
    drag.current = { dx: event.clientX - element.offsetLeft, dy: event.clientY - element.offsetTop };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    setPos(clamp(event.clientX - drag.current.dx, event.clientY - drag.current.dy));
  };

  const onDragEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, busy]);

  const submit = async () => {
    if (!instruction.trim() || busy || !draft) return;
    const id = newRunId("note-ai");
    setRunId(id);
    setBusy(true);
    // No `target`: the user is already looking at the note this is writing into, so there is
    // nowhere for the notification centre to send them.
    useAiRunStore.getState().start(id, { kindKey: "notes.ai.runKind", detail: draft.title });
    try {
      const markdown = await notesWriteWithAi({
        title: draft.title,
        content: draft.content,
        selection,
        instruction: instruction.trim(),
        runId: id,
      });
      if (markdown.trim()) onInsert(markdown);
      onClose();
    } catch (error) {
      // Stopping it yourself is not a failure worth a red toast.
      if (!isCancellation(error)) pushErrorToast(String(error));
    } finally {
      useAiRunStore.getState().finish(id);
      setBusy(false);
      setRunId(null);
    }
  };

  return (
    <div
      ref={panel}
      style={pos ? { left: pos.x, top: pos.y } : { right: MARGIN, top: MARGIN }}
      // `absolute` inside the editor column (see `NoteEditor`), so it floats over the Markdown and
      // travels with the pane. The accent border is what separates a window standing over the text
      // from a panel docked into the layout.
      className="cf-fade-in absolute z-30 w-[340px] max-w-[calc(100%-1.5rem)] overflow-hidden rounded-lg border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
    >
      <div
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        className="flex cursor-grab touch-none items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1.5 active:cursor-grabbing"
      >
        <Sparkles size={13} className="shrink-0 text-[var(--cf-accent)]" />
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-semibold text-[var(--cf-text)]">
          {selection.trim() ? t("notes.ai.titleReplace") : t("notes.ai.titleWrite")}
        </h2>
        <GripHorizontal size={12} className="shrink-0 text-[var(--cf-text-muted)] opacity-60" />
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label={t("notes.close")}
          className="shrink-0 text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
        >
          <X size={14} />
        </button>
      </div>

      <div className="space-y-2 p-2.5">
        {selection.trim() && (
          <div>
            <span className="mb-1 block text-[10.5px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.ai.willReplace")}
            </span>
            {/* Two lines of it, so "replace this" names something the user can recognise without
                the window turning into a second editor. */}
            <pre className="max-h-12 overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1 text-[10px] leading-snug text-[var(--cf-text-muted)]">
              {selection.slice(0, 160)}
              {selection.length > 160 ? "…" : ""}
            </pre>
          </div>
        )}

        <textarea
          autoFocus
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            // Enter alone is a newline: the instruction is prose and often two sentences.
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          aria-label={t("notes.ai.instruction")}
          placeholder={t("notes.ai.instructionPlaceholder")}
          className="w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[11.5px] leading-relaxed text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
        />

        {/* A label, never a control. Changing the routing is Settings' job, and a picker here would
            be the second place to set it — which is how the two ended up disagreeing. */}
        <p
          className="flex items-center gap-1 text-[10px] text-[var(--cf-text-muted)]"
          title={t("notes.ai.engineHint", { provider: providerLabel, model: modelLabel })}
        >
          {EngineIcon && <EngineIcon size={10} className="shrink-0" />}
          <span className="truncate">
            {providerLabel} · {modelLabel}
          </span>
        </p>
      </div>

      <div className="flex items-center justify-end gap-1.5 border-t border-[var(--cf-border)] px-2.5 py-1.5">
        {busy ? (
          <>
            {/* While it runs there is exactly one thing left to do — stop it — so that is the only
                button. The two it replaces were both dead in this state: a greyed "Cancel" and a
                greyed "Writing…" read as a form waiting on you rather than an engine working. */}
            {runId && (
              <button
                type="button"
                onClick={() => void useAiRunStore.getState().cancel(runId)}
                className="mr-auto rounded-md px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-danger)]"
              >
                {t("notes.ai.stop")}
              </button>
            )}
            {/* The orb, not a spinner, and on the panel's own surface rather than inside a filled
                button: it is the app's mark for *an engine burning context* — the same one the
                agent console, the run log and the SQL console show — and a rotating ring is what
                every "loading" in every app looks like. Its colours are tuned against a surface;
                40%-opacity white-on-accent, which is what the disabled button gave it, is where it
                went to die. */}
            <span className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text)]">
              <ThinkingOrb size="sm" />
              {t("notes.ai.writing")}
            </span>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
            >
              {t("notes.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!instruction.trim()}
              // The "one undo takes it back out" promise, as a tooltip rather than a paragraph: it
              // is reassurance about the button, and the window is small enough that a third of it
              // should not be spent on text you read once.
              title={t("notes.ai.undoHint")}
              className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              <Sparkles size={11} />
              {t("notes.ai.write")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
