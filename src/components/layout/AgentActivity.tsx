import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, PauseCircle } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { useAiRunStore } from "../../state/aiRunStore";
import { useChainStore } from "../../state/chainStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { followTarget, type NotificationTarget } from "../../state/notificationStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

const PANEL_WIDTH = 268;

/**
 * One thing a model is doing right now — or one plan waiting on the user to let it carry on.
 *
 * A chain, a chat answer, a wiki page and a PR review are the same row to a reader: something is
 * running, here is what it is, take me there. The only thing the distinction decides is what the
 * row is called and where following it lands.
 */
interface LiveRun {
  key: string;
  /** What kind of work it is — translated at render, never stored as a finished string. */
  kind: string;
  /** What it is acting on: a task, a batch, a question, a file. */
  detail: string;
  /** Where following it goes, or `null` for a run whose place is already on screen — an inline
   * edit in the editor has nowhere to send anybody. */
  go: (() => void) | null;
  /** Parked on the user rather than on an engine: a gate. It is still in progress — nothing moves
   * until it is answered — which is exactly why it is worth a section of its own. */
  attention: boolean;
  /**
   * Which engine is doing it, as a provider id — for the brand mark on the row.
   *
   * `null` in the two cases where there is honestly nothing to draw: a gate, which is waiting on a
   * person and has no engine running at all, and the sliver before the backend's engine banner
   * arrives for a run that has only just started. Both fall back to the plain status dot rather
   * than to a placeholder mark, because a logo that means "we don't know yet" is worse than none.
   */
  providerId: string | null;
  /** "Claude Code · Opus 5", for the row's tooltip. Empty when the engine has not announced itself
   *  yet, in which case the row carries no tooltip rather than an empty one. */
  engineLabel: string;
}

/**
 * Every model this app is running right now, and a way back to each one.
 *
 * **Only while something is in flight.** With nothing running this renders nothing at all — not a
 * zero, not a greyed-out button. A permanent control that says "0" is a control that stops being
 * read, and the whole value of this one is that its presence is the message.
 *
 * The list comes from `aiRunStore`, which is where *every* engine invocation in the app already
 * registers: an agent turn, a chain step, a chat answer, a PR review, a wiki page, a story batch, a
 * fix, an inline edit. That is the whole reason it is read from there rather than assembled from
 * the feature stores — a new feature that runs a model appears here for free, and one that is
 * removed stops appearing, with nothing to keep in sync.
 *
 * Each run says what it is when it starts (`AiRunAbout`), so a chain step reads as its **plan**
 * rather than as the one step mid-flight, and a run that outlives the screen it was started from
 * still knows its own name. Gates come from `chainStore` instead — a plan waiting for an answer has
 * no engine running, which is exactly why it needs saying.
 *
 * Following a row reuses the notification centre's landing (`followTarget`), which is what makes it
 * work across workspaces: a run left going in another workspace is opened by switching to it first,
 * focusing the repository, and only then selecting the row.
 */
export function AgentActivity() {
  const t = useT();
  const agents = useLiveRuns();

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Upward, like every other panel hanging off this footer.
    setPos({ bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onMove = () => reposition();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The last run finishing while the panel is open. Closing it is right: what it was listing has
  // gone, and an empty panel left hanging over the bar is a panel the user has to dismiss by hand.
  useEffect(() => {
    if (agents.length === 0) setOpen(false);
  }, [agents.length]);

  if (agents.length === 0) return null;

  const waiting = agents.filter((agent) => agent.attention);
  const running = agents.filter((agent) => !agent.attention);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-tour="agent-activity"
        title={t("agents.liveTitle")}
        className={`flex h-6 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-[11px] hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
          // Amber only when *nothing* is moving and the app is waiting on the user: a plan that is
          // running has no call on their attention, and a bar that asks for it anyway is one they
          // learn to stop looking at.
          running.length === 0 ? "text-[#f59e0b]" : open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
        }`}
      >
        {/* The app's own "an engine is burning" mark when one is, and a still glyph when the only
            thing left is a gate — the orb would otherwise claim work that has stopped. */}
        {running.length > 0 ? <ThinkingOrb size="sm" /> : <PauseCircle size={12} className="shrink-0" />}
        <span className="tabular-nums">{t("agents.liveN", { n: agents.length })}</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={t("agents.liveTitle")}
            style={{ bottom: pos.bottom, right: pos.right, width: PANEL_WIDTH, maxWidth: "calc(100vw - 16px)" }}
            className="cf-fade-in fixed z-[60] max-h-[50vh] overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] py-1.5 shadow-[var(--cf-shadow)]"
          >
            {waiting.length > 0 && (
              <Section label={t("agents.liveNeedsAttention")}>
                {waiting.map((run) => (
                  <RunRow key={run.key} run={run} onOpen={() => setOpen(false)} />
                ))}
              </Section>
            )}
            {running.length > 0 && (
              <Section label={t("agents.liveRunning")}>
                {running.map((run) => (
                  <RunRow key={run.key} run={run} onOpen={() => setOpen(false)} />
                ))}
              </Section>
            )}
            <p className="mt-1 border-t border-[var(--cf-border)] px-3 pt-1.5 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("agents.liveHint")}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}

/** `anthropic/claude-opus-5` → `claude-opus-5`. The provider prefix repeats what the mark beside it
 *  already says, which is the same trim `RunEngineChip` makes for the same reason. */
function shortModel(model: string): string {
  return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-0.5">
      <p className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </p>
      {children}
    </div>
  );
}

function RunRow({ run, onOpen }: { run: LiveRun; onOpen: () => void }) {
  const body = (
    <>
      {/* A fixed slot, whatever goes in it. The mark arrives one event after the row does, and a
          6px dot growing into a 14px logo would shunt the title sideways on a panel the user is
          already reading. Sizing the slot for the larger of the two costs nothing and the swap is
          then invisible. */}
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        {run.providerId ? (
          // The engine's own mark, the same one Settings → AI → Providers draws. It replaces the
          // dot rather than joining it: "this is running" is already said by the section heading
          // above and the orb in the bar below, and the logo says the thing neither of them can.
          <ProviderGlyph providerId={run.providerId} size={14} />
        ) : (
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              run.attention ? "bg-[#f59e0b]" : "bg-[var(--cf-accent)]"
            }`}
          />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] text-[var(--cf-text)]">{run.kind}</span>
        {run.detail && (
          <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{run.detail}</span>
        )}
      </span>
    </>
  );

  // A row with nowhere to go is drawn as a row, not as a dead button: it is still saying "a model
  // is running", and a hover state that leads nowhere is a promise the row cannot keep.
  if (!run.go) {
    return (
      <div title={run.engineLabel || undefined} className="flex w-full items-center gap-2 px-3 py-1.5">
        {body}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={() => {
        onOpen();
        run.go?.();
      }}
      // The engine and model behind the mark. On the `title` rather than on the row, because the
      // row is already two lines of text in 268px and a third would be the one that gets truncated.
      title={run.engineLabel || undefined}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
    >
      {body}
      <ArrowUpRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
    </button>
  );
}

/**
 * Everything in flight: every live engine, plus every plan parked on a decision.
 *
 * The runs come from `aiRunStore.active` — the one place every model invocation in the app already
 * announces itself — paired with the description each one filed when it started. Nothing here knows
 * what a chain or a wiki page is; it knows what a run said about itself, which is what keeps this
 * list correct as features are added.
 *
 * The gates come from `chainStore`, and they are the exception that proves the rule: a plan waiting
 * for an answer has **no engine running**, so `aiRunStore` cannot know about it, and it is the one
 * state in the app that is genuinely asking the user for something.
 */
function useLiveRuns(): LiveRun[] {
  const active = useAiRunStore((s) => s.active);
  const aboutByRun = useAiRunStore((s) => s.aboutByRun);
  // Announced by the backend once per run, just before its first line — so a row drawn in the same
  // tick the run started shows the dot, and picks up its mark a moment later. See `AiRunEngine`.
  const engineByRun = useAiRunStore((s) => s.engineByRun);
  const chains = useChainStore((s) => s.chains);
  const briefsByChain = useChainStore((s) => s.briefsByChain);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const t = useT();

  return useMemo(() => {
    const follow = (workspaceId: string | null | undefined, target: NotificationTarget) => () => {
      // A deleted workspace is the one case this throws — the run's home is gone, and carrying on
      // would open the destination view here and look like it worked.
      void followTarget(workspaceId ?? activeWorkspaceId, target).catch((e: unknown) =>
        pushErrorToast(String(e)),
      );
    };

    const rows: LiveRun[] = [];

    for (const chain of chains) {
      if (chain.status !== "gated") continue;
      const briefs = briefsByChain[chain.id] ?? [];
      // A gated chain is parked *before* a step, so the one it is waiting on is the first pending.
      const at = briefs.find((brief) => brief.status === "pending") ?? null;
      rows.push({
        key: `chain:${chain.id}`,
        kind: t("agents.liveKindGate"),
        detail: chain.title || chain.goal,
        attention: true,
        // A gate has no engine running behind it — that is what makes it a gate.
        providerId: null,
        engineLabel: "",
        go: follow(activeWorkspaceId, {
          view: "agents",
          projectId: at?.project_id || chain.project_id || undefined,
          select: { kind: "chain", id: chain.id },
        }),
      });
    }

    for (const [runId, running] of Object.entries(active)) {
      if (!running) continue;
      const about = aboutByRun[runId];
      const engine = engineByRun[runId];
      rows.push({
        key: `run:${runId}`,
        // A run that started without describing itself still counts. It should not happen — every
        // `start` in the app passes one — but "a model is running and we cannot say which" is a
        // truer thing to show than nothing at all.
        kind: about ? t(about.kindKey) : t("agents.liveKindUnknown"),
        detail: about?.detail ?? "",
        attention: false,
        providerId: engine?.providerId || null,
        // The engine's own words, not a lookup: this is what ran, as the backend reported it, and
        // the model is worth saying because routing sends different tasks to different ones.
        engineLabel: engine ? (engine.model ? `${engine.engine} · ${shortModel(engine.model)}` : engine.engine) : "",
        go: about?.target ? follow(about.workspaceId, about.target) : null,
      });
    }

    // Gates first: they are the only rows waiting on the reader.
    return rows.sort((a, b) => Number(b.attention) - Number(a.attention));
  }, [active, aboutByRun, engineByRun, chains, briefsByChain, activeWorkspaceId, t]);
}
