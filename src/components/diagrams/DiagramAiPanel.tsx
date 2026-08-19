import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GripHorizontal, Maximize2, Minimize2, Sparkles, X } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { DiagramPreview } from "./DiagramPreview";
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
 *
 * **The run is not this component's**, which is the thing that changed. It belongs to the diagram,
 * in `diagramsStore.aiByDiagram`, and this window is a view over that entry — so closing it, going
 * back to the gallery or changing workspace no longer destroys a generation in flight or an answer
 * waiting to be applied. Coming back to the diagram finds both, Stop button included. See
 * `DiagramAiRun`.
 */
export function DiagramAiPanel({ diagramId, onClose }: { diagramId: string; onClose: () => void }) {
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const routedProvider = useAiProviderStore((s) => s.taskProviders[TASK]);
  const routedModel = useAiProviderStore((s) => s.taskModels[TASK]);
  const applyGenerated = useDiagramsStore((s) => s.applyGenerated);
  const settleAiRun = useDiagramsStore((s) => s.settleAiRun);
  /** This diagram's run, and only this diagram's. A stable object reference, so a generation on
   *  another diagram does not re-render this one's window. */
  const run = useDiagramsStore((s) => s.aiByDiagram[diagramId]);
  /** Whether the canvas this window belongs to is actually loaded and is actually this diagram —
   *  the same pair `applyGenerated` checks before it writes, read here so the button can say so
   *  instead of being pressed for nothing. */
  const canApply = useDiagramsStore((s) => s.draft?.id === diagramId);
  const title = useDiagramsStore((s) => s.diagrams.find((d) => d.id === diagramId)?.title ?? "");
  const t = useT();

  const [instruction, setInstruction] = useState("");
  /** Whether the preview is drawn at a readable size and scrolled, rather than fitted to the panel.
   *  Reset with every new answer: a zoom that outlived the diagram it was set for would open the
   *  next generation halfway down a picture nobody has seen the top of yet. */
  const [zoomed, setZoomed] = useState(false);
  const busy = run?.status === "running";
  /** The validated answer, waiting to be applied. `null` until one arrives. */
  const result = run?.status === "ready" ? run.graph : null;

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
    setZoomed(false);
  }, [run?.runId]);

  useEffect(() => {
    // Escape closes even mid-generation, and so does the ✕ — both used to be refused while busy.
    // They were, back when closing this window was the same thing as throwing the run away; now
    // the run lives on the diagram, so leaving is just leaving. The Stop button is what stops it,
    // and it is here again the moment the window is re-opened.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async () => {
    if (!instruction.trim() || busy) return;
    const state = useDiagramsStore.getState();
    const draft = state.draft;
    // The window is drawn over an open diagram, so these disagree only when the store moved
    // underneath it — a workspace switched from the palette while the instruction was being
    // typed. Refusing beats generating an outline of one drawing into another.
    if (draft?.id !== diagramId) return;
    const id = newRunId("diagram-ai");
    // The stamp, taken before the first await and quoted by everything below rather than re-read
    // at the end: a run that outlives the screen it was started from — which every one of these
    // now can — has to be able to say which workspace's diagram it drew into. `startAiRun` is also
    // what refuses a second run on this diagram, so nothing is dispatched until it has agreed.
    const started = state.startAiRun(diagramId, id);
    if (!started) return;
    const workspaceId = started.workspaceId;
    /**
     * Whether a toast still has an audience.
     *
     * A toast is for the workspace you are standing in. This run can finish minutes after the user
     * walked away from it, and a red bar over another workspace about a diagram they cannot see
     * from there is noise — the notification carries `workspaceId` and is the channel that can
     * take them back. The store's own workspace is what is compared, never the active one: that is
     * the value that changed underneath us.
     */
    const stillInWorkspace = () => useDiagramsStore.getState().workspaceId === workspaceId;
    /** The answer, if one arrives. Parked against the diagram in the `finally`. */
    let graph: AiGraph | null = null;
    useAiRunStore.getState().start(id, {
      kindKey: "diagrams.ai.runKind",
      detail: title,
      workspaceId,
      // Which makes the status-bar row clickable from anywhere: `followTarget` crosses into the
      // workspace above and opens this diagram. Without it the row could only say a run existed.
      target: { view: "diagrams", select: { kind: "diagram", id: diagramId } },
    });
    try {
      const raw = await diagramsDrawWithAi({
        title,
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
        if (stillInWorkspace()) pushErrorToast(t(`diagrams.ai.error.${parsed.error}`));
        notify({
          source: "diagrams",
          titleKey: "notifications.diagramDrawFailed",
          target: { view: "diagrams", select: { kind: "diagram", id: diagramId } },
          status: "error",
          detail: `${title} · ${t(`diagrams.ai.error.${parsed.error}`)}`,
          workspaceId,
        });
        return;
      }
      graph = parsed.graph;
      notify({
        source: "diagrams",
        titleKey: "notifications.diagramDrawn",
        target: { view: "diagrams", select: { kind: "diagram", id: diagramId } },
        status: "success",
        detail: title,
        workspaceId,
      });
    } catch (error) {
      // Stopping it yourself is not a failure worth a red toast.
      if (!isCancellation(error)) {
        if (stillInWorkspace()) pushErrorToast(String(error));
        notify({
          source: "diagrams",
          titleKey: "notifications.diagramDrawFailed",
          target: { view: "diagrams", select: { kind: "diagram", id: diagramId } },
          status: "error",
          detail: title,
          workspaceId,
        });
      }
    } finally {
      useAiRunStore.getState().finish(id);
      // Into the store, not into this component: by now the window may well be gone — closed,
      // left behind by a trip to the gallery, unmounted by a workspace switch — and `setResult`
      // on an unmounted panel is how a finished generation used to disappear while its
      // notification went on claiming it existed. `settleAiRun` files it against the diagram, or
      // clears the slot when there is nothing to keep.
      useDiagramsStore.getState().settleAiRun(diagramId, id, graph);
    }
  };

  const apply = () => {
    if (run?.status !== "ready" || !canApply) return;
    // The prefix is what keeps a generated id from landing on a hand-drawn shape with the same
    // name — draw.io's merge matches on id, and a collision replaces silently. Timestamped rather
    // than counted, so two generations in one session cannot collide with each other either.
    const landed = applyGenerated(
      diagramId,
      graphToMxGraph(run.graph, `ai${Date.now().toString(36)}_`),
    );
    // Nothing is consumed until it is actually on the canvas. This window can be up over a diagram
    // whose document has not arrived yet — `openDiagram` sets `activeId` at once and fetches the
    // row afterwards, which is precisely the state following one of these notifications in from
    // another workspace lands in, and the header's own button can open this window during it. In
    // that gap `applyGenerated` writes nothing; dropping the entry anyway would throw away the
    // generation the user came back for and close the only window that could say so.
    if (!landed) return;
    // Consumed: it is on the canvas now, and the undo button in the header is what takes it back
    // out. Addressed by run id so this cannot clear a generation started since.
    settleAiRun(diagramId, run.runId, null);
    onClose();
  };

  return (
    <div
      ref={panel}
      data-tour="diagrams-ai"
      // Wider than it was: the window now carries a rendered preview, and 340px of it was a
      // picture too small to answer the question it exists to answer.
      className="absolute z-30 w-[392px] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
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
        {/* Not disabled while busy — see the Escape handler for why closing is no longer the same
            thing as abandoning the run. */}
        <button
          type="button"
          onClick={onClose}
          aria-label={t("diagrams.close")}
          className="text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
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
            <div className="flex items-center gap-1.5">
              <span className="flex-1 truncate text-[10px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
                {t("diagrams.ai.preview", {
                  shapes: String(result.nodes.length),
                  arrows: String(result.edges.length),
                })}
              </span>
              <button
                type="button"
                onClick={() => setZoomed((on) => !on)}
                title={t(zoomed ? "diagrams.ai.previewFit" : "diagrams.ai.previewZoom")}
                aria-label={t(zoomed ? "diagrams.ai.previewFit" : "diagrams.ai.previewZoom")}
                className="shrink-0 text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
              >
                {zoomed ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>
            </div>
            {/* **The picture, not the list of labels.** This is the moment the decision is made,
                and "did it understand the question?" is a question about the shape of the thing —
                where it branches, what ended up inside the boundary, which way the arrow points.
                It is `layoutGraph`'s own output, so what is drawn here is what lands on the canvas.

                Fitted by default and scrolled at a readable size behind the button above: a
                fifteen-node diagram fitted into a 340px panel has legible geometry and illegible
                text, and both halves are worth being able to look at. */}
            <div
              className={`rounded border border-[var(--cf-border)] bg-[var(--cf-surface)] ${
                zoomed ? "max-h-[260px] overflow-auto p-1" : "h-[168px] p-1"
              }`}
            >
              <DiagramPreview
                graph={result}
                zoom={zoomed ? 0.62 : undefined}
                className={zoomed ? "block" : "h-full w-full"}
              />
            </div>
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
              {/* Re-attachable: `run` comes from the store, so this button is here again when the
                  window is re-opened over a diagram whose generation is still going. It was the
                  only stop control this run ever had, and it used to leave with the panel. */}
              <button
                type="button"
                onClick={() => run && void useAiRunStore.getState().cancel(run.runId)}
                className="rounded-md border border-[var(--cf-field-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
              >
                {t("diagrams.ai.cancel")}
              </button>
            </>
          ) : result ? (
            <>
              {/* The way past an answer you do not want. It matters now that the answer outlives
                  the window: closing and re-opening used to be how you got the Generate button
                  back, and that is exactly the gesture that must no longer throw the result away.
                  Generating again takes this diagram's slot, which is what discards it. */}
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!instruction.trim()}
                className="rounded-md border border-[var(--cf-field-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
              >
                {t("diagrams.ai.generate")}
              </button>
              <button
                type="button"
                onClick={apply}
                // Off while the document it would draw into has not arrived. `openDiagram` sets
                // `activeId` at once and fetches the row afterwards, and following one of these
                // notifications in from another workspace lands squarely in that gap — where
                // `applyGenerated` writes nothing and returns false. A button that silently does
                // nothing reads as a broken generation; a disabled one reads as "not yet", which is
                // what it is, and it becomes live on its own a moment later.
                disabled={!canApply}
                className="rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                {t("diagrams.ai.apply")}
              </button>
            </>
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
