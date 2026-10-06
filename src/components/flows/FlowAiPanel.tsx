import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { AiSparkles } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { buttonClass } from "../common/Button";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import type { FlowDiff } from "../../lib/flows/diff";
import { useFlowsStore } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";

/** The routing row this runs under — `AiTask::FlowBuilder` on the Rust side. */
const TASK = "flow_builder";

/**
 * "Crear con IA": a flow written or changed from a description.
 *
 * **A window over the canvas, not a modal**, like the diagrams' — the request is written about
 * what is underneath it. **Nothing changes until it is accepted**: the answer is drawn on the
 * canvas as changes (added, changed, removed) while this window holds the summary and the two
 * answers. Accepting is one undo step and saves without carrying trust; asking again refines the
 * proposal on screen rather than starting over.
 *
 * **The run is the flow's** (`flowsStore.aiByFlow`): closing this window, opening another flow or
 * switching workspace leaves it going, and the proposal waiting.
 */
export function FlowAiPanel({ flowId, diff, onClose }: { flowId: string; diff: FlowDiff | null; onClose: () => void }) {
  const t = useT();
  const run = useFlowsStore((s) => s.aiByFlow[flowId]);
  const empty = useFlowsStore((s) => (s.draft?.id === flowId ? s.draft.spec.nodes.length === 0 : true));
  const [prompt, setPrompt] = useState(run?.prompt ?? "");
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Room for a long request (the user's ask, 2026-10-06: "que se vaya agrandando hacia abajo mientras
  // voy escribiendo hasta la mitad del lienzo, de ahí un scroll"): the box fits what is written, down
  // to the middle of the canvas it floats over, and scrolls past that.
  const fit = useCallback(() => {
    const el = field.current;
    const canvas = panel.current?.parentElement;
    if (!el || !canvas) return;
    const area = canvas.getBoundingClientRect();
    const max = Math.max(72, Math.round(area.top + area.height / 2 - el.getBoundingClientRect().top));
    el.style.height = "auto";
    const wanted = el.scrollHeight + 2;
    el.style.height = `${Math.min(wanted, max)}px`;
    el.style.overflowY = wanted > max ? "auto" : "hidden";
  }, []);
  useLayoutEffect(fit, [prompt, fit]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);
  const busy = run?.status === "running";
  const proposal = run?.status === "ready" ? run.proposal : null;
  const store = useFlowsStore.getState;
  const submit = () => {
    if (!prompt.trim() || busy) return;
    void store().buildWithAi(flowId, prompt);
  };

  return (
    <div
      ref={panel}
      data-tour="flows-ai-panel"
      className="absolute right-3 top-3 z-20 w-[min(560px,calc(100%-24px))] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !proposal) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-2.5 py-1.5 text-[11px] text-[var(--cf-accent)]">
        <AiSparkles size={12} />
        <span className="flex-1 font-medium">{t(empty ? "flows.builder.titleNew" : "flows.builder.title")}</span>
        {!proposal && (
          <button
            type="button"
            onClick={onClose}
            aria-label={t("flows.builder.close")}
            title={t("flows.builder.close")}
            className="text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
          >
            <X size={12} />
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 p-2.5">
        <textarea
          ref={field}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            // Enter asks, Shift+Enter breaks the line.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          rows={3}
          autoFocus
          disabled={busy}
          placeholder={t(proposal ? "flows.builder.refinePlaceholder" : "flows.builder.placeholder")}
          className="w-full resize-none rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-2 text-[12.5px] leading-[1.5] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)] disabled:opacity-60"
        />

        {proposal && (
          <div className="flex flex-col gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1.5">
            {proposal.summary && <p className="text-[12px] leading-snug text-[var(--cf-text)]">{proposal.summary}</p>}
            {diff && (
              <span className="flex gap-2.5 text-[11px] tabular-nums" aria-label={t("flows.builder.changes")}>
                <span className="text-[var(--cf-success)]" title={t("flows.builder.added")}>
                  +{diff.counts.added}
                </span>
                <span className="text-[var(--cf-warning)]" title={t("flows.builder.changed")}>
                  ~{diff.counts.changed}
                </span>
                <span className="text-[var(--cf-danger)]" title={t("flows.builder.removed")}>
                  −{diff.counts.removed}
                </span>
              </span>
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <ChatModelPicker task={TASK} liveModel={null} chatActive={false} variant="tag" />
          </div>
          {busy ? (
            <>
              <ThinkingOrb size="sm" />
              <button
                type="button"
                onClick={() => store().discardProposal(flowId)}
                className="rounded-md border border-[var(--cf-field-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
              >
                {t("flows.builder.stop")}
              </button>
            </>
          ) : proposal ? (
            <>
              <button
                type="button"
                onClick={() => {
                  store().discardProposal(flowId);
                  onClose();
                }}
                className="rounded-md border border-[var(--cf-field-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
              >
                {t("flows.builder.discard")}
              </button>
              {prompt.trim() && prompt.trim() !== run?.prompt.trim() && (
                <button
                  type="button"
                  onClick={submit}
                  className="rounded-md border border-[var(--cf-field-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
                >
                  {t("flows.builder.generate")}
                </button>
              )}
              <button
                type="button"
                title={t("flows.builder.acceptHint")}
                onClick={() => {
                  void store().acceptProposal(flowId);
                  onClose();
                }}
                className={buttonClass({ variant: "primary", size: "sm" })}
              >
                {t("flows.builder.accept")}
              </button>
            </>
          ) : (
            <button type="button" onClick={submit} disabled={!prompt.trim()} className={buttonClass({ variant: "primary", size: "sm" })}>
              {t("flows.builder.generate")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
