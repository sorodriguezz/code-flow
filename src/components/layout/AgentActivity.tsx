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

/** Wider than it was, and the workspace line is why: three lines of text in 268px left the middle
 *  one — the thing the run is *acting on* — truncated on almost every row. */
const PANEL_WIDTH = 300;

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
  /** Where following it goes, or `null` for a run with genuinely nowhere to land. */
  go: (() => void) | null;
  /**
   * The workspace the run is living in, by name and colour — the answer to "where is this
   * happening?", which a global list has to give or it is only telling half the truth.
   *
   * `null` for a run that belongs to no workspace (one driven from a paired phone, an inline edit
   * in a file opened from disk) **and** for one whose workspace has since been deleted. The two
   * read the same on the row on purpose: neither is somewhere the user can be sent.
   */
  workspace: { id: string; name: string; color: string } | null;
  /** Running somewhere other than the workspace on screen. Only changes how the row is labelled —
   * it is still listed, because that is the entire point of a global bar. */
  foreign: boolean;
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
  const t = useT();
  const body = (
    <>
      {/* A fixed slot, whatever goes in it. The mark arrives one event after the row does, and a
          6px dot growing into a 14px logo would shunt the title sideways on a panel the user is
          already reading. Sizing the slot for the larger of the two costs nothing and the swap is
          then invisible. */}
      <span className="mt-[1px] flex h-3.5 w-3.5 shrink-0 items-center justify-center">
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
        {/* Where it is happening, on every row and not only on the foreign ones.

            A bar that names the workspace only when it differs from the current one is a bar you
            have to know the rule of before you can read it — and the row that says nothing is then
            ambiguous between "here" and "we didn't record it". Both states are drawn, so the line
            always answers the question it exists to answer. The dot is the workspace's own identity
            colour, the same one the switcher and the sidebar draw it with. */}
        <span className="mt-[1px] flex items-center gap-1 text-[10px] text-[var(--cf-text-muted)]">
          {run.workspace ? (
            <>
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: run.workspace.color }}
              />
              <span className="min-w-0 truncate" title={run.workspace.name}>
                {run.workspace.name}
              </span>
              {run.foreign && (
                // The one thing the name alone cannot say: this is not where you are standing. It
                // is what turns the row from a label into a warning that following it will move
                // the whole window.
                <span className="shrink-0 rounded-full bg-[color-mix(in_oklab,var(--cf-text)_10%,transparent)] px-1 text-[9px] font-semibold uppercase tracking-wide">
                  {t("agents.liveElsewhere")}
                </span>
              )}
            </>
          ) : (
            <span className="min-w-0 truncate italic">{t("agents.liveNoWorkspace")}</span>
          )}
        </span>
      </span>
    </>
  );

  // A row with nowhere to go is drawn as a row, not as a dead button: it is still saying "a model
  // is running", and a hover state that leads nowhere is a promise the row cannot keep.
  if (!run.go) {
    return (
      <div title={run.engineLabel || undefined} className="flex w-full items-start gap-2 px-3 py-1.5">
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
      // row is three lines of text already and a fourth would be the one that gets truncated.
      title={
        run.foreign && run.workspace
          ? `${t("notifications.goOtherWorkspace", { name: run.workspace.name })}${
              run.engineLabel ? ` — ${run.engineLabel}` : ""
            }`
          : run.engineLabel || undefined
      }
      className="flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
    >
      {body}
      <ArrowUpRight size={12} className="mt-[3px] shrink-0 text-[var(--cf-text-muted)]" />
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
  // Every workspace's, not this one's. `chains` holds the loaded workspace by construction, so a
  // bar built from it stopped listing a parked plan the moment the user looked elsewhere — and a
  // gate files no notification either, so nothing else would have said so. See
  // `chainStore.gatedChains`.
  const gatedChains = useChainStore((s) => s.gatedChains);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  // Every workspace's project list this session has loaded — the map that turns a run's `projectId`
  // into the workspace it belongs to, for the runs whose home is only recoverable that way.
  const projectsByWorkspace = useWorkspaceStore((s) => s.projectsByWorkspace);
  const t = useT();

  return useMemo(() => {
    /** A project knows which workspace it is in, and that outranks the stamp for the same reason
     *  `enterWorkspace` prefers it: the stamp can be stale, a project's home cannot. */
    const workspaceOfProject = (projectId: string): string | null => {
      for (const [workspaceId, projects] of Object.entries(projectsByWorkspace)) {
        if (projects.some((p) => p.id === projectId)) return workspaceId;
      }
      return null;
    };

    /** Where a run lives, resolved exactly the way following it will resolve it — so the name on
     *  the row is a promise the click keeps. */
    const homeOf = (
      stamped: string | null | undefined,
      target: NotificationTarget | undefined,
    ): string | null => (target?.projectId ? workspaceOfProject(target.projectId) : null) ?? stamped ?? null;

    const named = (workspaceId: string | null) => {
      if (!workspaceId) return null;
      // A workspace deleted while its run was going. Drawn as "no workspace" rather than as a name
      // the app can no longer honour — and `go` is dropped with it, below.
      const found = workspaces.find((w) => w.id === workspaceId);
      return found ? { id: found.id, name: found.name, color: found.color } : null;
    };

    const follow = (workspaceId: string | null, target: NotificationTarget) => () => {
      // A deleted workspace is the one case this throws — the run's home is gone, and carrying on
      // would open the destination view here and look like it worked.
      void followTarget(workspaceId, target).catch((e: unknown) => pushErrorToast(String(e)));
    };

    const rows: LiveRun[] = [];

    for (const gate of gatedChains) {
      const target: NotificationTarget = {
        // The repository of the step it is *waiting on*, resolved in SQL — a plan parked between a
        // step in one repository and a step in another is waiting to be let into the second.
        view: "agents",
        projectId: gate.project_id || undefined,
        select: { kind: "chain", id: gate.chain_id },
      };
      // Taken straight from the backend, and deliberately **not** through `homeOf`.
      //
      // `homeOf` prefers the target's project, which is the right precedence for a run — a project
      // knows its own workspace and a stamp can go stale. A chain is the exception: it is only
      // *findable* in the workspace of its primary repository, because that is the join
      // `list_agent_chains` is keyed on and `chainStore.refresh` refuses a chain that list does not
      // hold. `gate.project_id` is the repository of the step it is waiting on, which on a
      // multi-repo plan is a different one — and moving that repository to another workspace makes
      // the two disagree outright, at which point resolving through the project would name a
      // workspace the chain cannot be opened in and land the user on an empty pane.
      const home = gate.workspace_id;
      const workspace = named(home);
      rows.push({
        key: `chain:${gate.chain_id}`,
        kind: t("agents.liveKindGate"),
        detail: gate.title || gate.goal,
        attention: true,
        // A gate has no engine running behind it — that is what makes it a gate.
        providerId: null,
        engineLabel: "",
        workspace,
        foreign: home !== null && home !== activeWorkspaceId,
        // Same rule as a run's: a workspace that no longer exists is nowhere to be sent.
        go: workspace ? follow(home, target) : null,
      });
    }

    for (const [runId, running] of Object.entries(active)) {
      if (!running) continue;
      const about = aboutByRun[runId];
      const engine = engineByRun[runId];
      const home = homeOf(about?.workspaceId, about?.target);
      const workspace = named(home);
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
        workspace,
        foreign: home !== null && home !== activeWorkspaceId,
        // Nowhere to go covers two cases now: a run that filed no target, and one whose workspace
        // has been deleted since — `followTarget` would throw on the second, and a button that
        // only ever produces an error toast is worse than no button.
        go: about?.target && !(home !== null && workspace === null) ? follow(home, about.target) : null,
      });
    }

    // Gates first: they are the only rows waiting on the reader. Then this workspace's runs before
    // the other workspaces', so the list opens on what the user is actually looking at.
    return rows.sort(
      (a, b) => Number(b.attention) - Number(a.attention) || Number(a.foreign) - Number(b.foreign),
    );
  }, [
    active,
    aboutByRun,
    engineByRun,
    gatedChains,
    activeWorkspaceId,
    workspaces,
    projectsByWorkspace,
    t,
  ]);
}
