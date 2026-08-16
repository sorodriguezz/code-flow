import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GripHorizontal, Sparkles, X } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../../lib/aiProviders";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { diagramsDrawWithAi } from "../../lib/tauri/diagramsCommands";
import { documentOutline, graphToMxGraph, parseAiGraph, type AiGraph } from "../../lib/diagrams/aiLayout";
import { isCancellation, newRunId, useAiRunStore } from "../../state/aiRunStore";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useDiagramsStore } from "../../state/diagramsStore";
import { notify } from "../../state/notificationStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/** The routing row this runs under — `AiTask::Diagram` on the Rust side. */
const TASK = "diagram";

/** Where the window opens: inset from the editor's top-right corner. */
const MARGIN = 12;

/**
 * Asks an engine for a diagram to add to the canvas.
 *
 * **A floating window over the editor, not a modal**, for the reason `NoteAiPanel` gives: the
 * instruction is written *about* what is underneath it, and a full-screen dialog covers the one
 * thing the user needs to look at. So there is no backdrop, the editor stays live behind it, and
 * the window can be dragged out of the way by its header.
 *
 * **Nothing is applied until it has been read.** What comes back is validated, laid out, and shown
 * as a summary — how many shapes, and what they say — with an explicit button to put it on the
 * canvas. A generate button on a document somebody cares about is only safe if the answer can be
 * looked at first, and if what it does is *add* rather than replace. It appends: the existing
 * drawing is never overwritten.
 *
 * **Undo is the app's, not the editor's.** Applying a generation replaces the editor's document,
 * which resets draw.io's own undo stack — `⌘Z` will not take it back out. `diagramsStore` keeps the
 * document as it was and the view offers an undo button until the next real edit.
 *
 * **The engine is not picked here**, the same as in Notes: it routes through the `diagram` task
 * like every other AI call in the app, and this window only *says* what it will run on.
 */
export function DiagramAiPanel({ onClose }: { onClose: () => void }) {
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const routedProvider = useAiProviderStore((s) => s.taskProviders[TASK]);
  const routedModel = useAiProviderStore((s) => s.taskModels[TASK]);
  const applyGenerated = useDiagramsStore((s) => s.applyGenerated);
  const t = useT();

  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  /** The validated answer, waiting to be applied. `null` until one arrives. */
  const [result, setResult] = useState<AiGraph | null>(null);

  const panel = useRef<HTMLDivElement>(null);
  /** Null until the window is dragged: it sits at its default corner, laid out by the browser, so
   *  a pane resize keeps it in the corner instead of stranding it at coordinates from a wider one. */
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // The engine, resolved through the same fallback chain the backend uses, so this cannot disagree
  // with what actually runs. Blank is a real state and not a missing read.
  const providerId = routedProvider?.trim() || defaultProvider || DEFAULT_AI_PROVIDER;
  const provider = AI_PROVIDERS.find((entry) => entry.id === providerId);
  const providerLabel = provider?.label ?? (provider?.labelKey ? t(provider.labelKey) : providerId);
  const modelLabel = routedModel?.trim() || t("diagrams.ai.defaultModel");

  /** Keeps the window inside the editor pane. Called while dragging and whenever the pane resizes. */
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
    // Never from a control inside the header. `setPointerCapture` retargets the rest of the gesture
    // to the element that took it — the `click` included — so a header that captures on every
    // pointerdown swallows its own close button's click.
    if ((event.target as Element).closest("button")) return;
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
    if (!instruction.trim() || busy) return;
    const state = useDiagramsStore.getState();
    const draft = state.draft;
    if (!draft) return;
    const id = newRunId("diagram-ai");
    // Captured before the await: the panel closes on its own way out, and a run that outlives the
    // screen it was started from has to be able to name the diagram it drew into.
    const diagram = {
      id: draft.id,
      title: state.diagrams.find((d) => d.id === draft.id)?.title ?? "",
    };
    const workspaceId = state.workspaceId;
    setRunId(id);
    setBusy(true);
    setResult(null);
    useAiRunStore.getState().start(id, { kindKey: "diagrams.ai.runKind", detail: diagram.title });
    try {
      const raw = await diagramsDrawWithAi({
        title: diagram.title,
        // Labels, never the document. See `documentOutline`.
        outline: documentOutline(draft.doc),
        instruction: instruction.trim(),
        runId: id,
      });
      const parsed = parseAiGraph(raw);
      if ("error" in parsed) {
        // A model answering with something unusable is an ordinary outcome, so it is a message in
        // the panel rather than a thrown error: the instruction is still there to be adjusted.
        //
        // **Recorded in the bell all the same**, which it was not: the toast is the only place this
        // was ever said, and a toast is gone in seconds. A run that spent tokens and drew nothing is
        // exactly what the bell is for — and leaving it out made the two ways this can fail behave
        // differently for no reason a user could see. The reason travels in `detail`, because "could
        // not draw the diagram" on its own does not say whether to retry or to reword.
        pushErrorToast(t(`diagrams.ai.error.${parsed.error}`));
        notify({
          source: "diagrams",
          titleKey: "notifications.diagramDrawFailed",
          target: { view: "diagrams", select: { kind: "diagram", id: diagram.id } },
          status: "error",
          detail: `${diagram.title} · ${t(`diagrams.ai.error.${parsed.error}`)}`,
          workspaceId,
        });
        return;
      }
      setResult(parsed.graph);
      notify({
        source: "diagrams",
        titleKey: "notifications.diagramDrawn",
        target: { view: "diagrams", select: { kind: "diagram", id: diagram.id } },
        status: "success",
        detail: diagram.title,
        workspaceId,
      });
    } catch (error) {
      // Stopping it yourself is not a failure worth a red toast.
      if (!isCancellation(error)) {
        pushErrorToast(String(error));
        notify({
          source: "diagrams",
          titleKey: "notifications.diagramDrawFailed",
          target: { view: "diagrams", select: { kind: "diagram", id: diagram.id } },
          status: "error",
          detail: diagram.title,
          workspaceId,
        });
      }
    } finally {
      useAiRunStore.getState().finish(id);
      setBusy(false);
      setRunId(null);
    }
  };

  const apply = () => {
    if (!result) return;
    // The prefix is what keeps a generated id from landing on a hand-drawn shape with the same
    // name — draw.io's merge matches on id, and a collision replaces silently. Timestamped rather
    // than counted, so two generations in one session cannot collide with each other either.
    applyGenerated(graphToMxGraph(result, `ai${Date.now().toString(36)}_`));
    onClose();
  };

  return (
    <div
      ref={panel}
      data-tour="diagrams-ai"
      className="absolute z-30 w-[340px] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      style={pos ? { left: pos.x, top: pos.y } : { right: MARGIN, top: MARGIN }}
    >
      <div
        className="flex cursor-grab items-center gap-2 border-b border-[var(--cf-border)] px-2.5 py-1.5 text-[11px] text-[var(--cf-accent)] active:cursor-grabbing"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
      >
        <GripHorizontal size={12} className="text-[var(--cf-text-muted)]" />
        <Sparkles size={12} />
        <span className="flex-1 font-medium">{t("diagrams.ai.title")}</span>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label={t("diagrams.close")}
          className="text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
        >
          <X size={12} />
        </button>
      </div>

      <div className="flex flex-col gap-2 p-2.5">
        <textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter breaks the line. A one-line instruction is the common case
            // and reaching for a button for it is a step too many.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={3}
          autoFocus
          disabled={busy}
          placeholder={t("diagrams.ai.placeholder")}
          className="w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[11.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)] disabled:opacity-60"
        />

        {result && (
          <div className="flex flex-col gap-1.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] p-2">
            <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("diagrams.ai.preview", {
                shapes: String(result.nodes.length),
                arrows: String(result.edges.length),
              })}
            </span>
            {/* The labels, not a picture. Rendering a preview would mean a second draw.io — and the
                labels are what tells you whether it understood the question. */}
            <p className="max-h-24 overflow-y-auto text-[11px] leading-relaxed text-[var(--cf-text)]">
              {result.nodes.map((node) => node.label).join(" · ")}
            </p>
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="flex min-w-0 flex-1 items-center gap-1 text-[10px] text-[var(--cf-text-muted)]">
            <ProviderGlyph providerId={providerId} size={11} />
            <span className="truncate">
              {providerLabel} · {modelLabel}
            </span>
          </span>

          {busy ? (
            <>
              <ThinkingOrb size="sm" />
              <button
                type="button"
                onClick={() => runId && void useAiRunStore.getState().cancel(runId)}
                className="rounded-md border border-[var(--cf-field-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
              >
                {t("diagrams.ai.cancel")}
              </button>
            </>
          ) : result ? (
            <button
              type="button"
              onClick={apply}
              className="rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
            >
              {t("diagrams.ai.apply")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!instruction.trim()}
              className="rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {t("diagrams.ai.generate")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
