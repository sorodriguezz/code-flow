import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleDot,
  CircleHelp,
  ExternalLink,
  FileDiff as FileDiffIcon,
  Loader2,
  MessagesSquare,
  MessageSquareText,
  Pause,
  Play,
  Rocket,
  RotateCcw,
  Send,
  SkipForward,
  Square,
  TriangleAlert,
  UsersRound,
} from "lucide-react";
import { t, type MobileKey } from "../i18n";
import { rpc } from "../transport";
import { teamRunWaits, useBusy, useMobileStore, type TeamRunRow } from "../store";
import { useNav } from "../nav";
import { onInvalidate } from "../invalidate";
import { clearDraft, readDraft, writeDraft } from "../drafts";
import { navigated } from "../haptics";
import { sinceIso } from "../time";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Button } from "../ui/Button";
import { ConfirmAction } from "../ui/ConfirmAction";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";

/**
 * Teams on a phone: the runs of the workspace, and one of them opened.
 *
 * # What this is for
 *
 * A team's run parks itself on a person the way a chain does, only more often and in more ways: the
 * lead's plan waits for a yes, a task that touches something sensitive waits for a yes, the merge
 * waits for a yes, and any member can stop to ask a question. Each of those leaves agents idle
 * until somebody answers — and until this screen existed the only place to answer was the desk.
 *
 * # What it deliberately is not
 *
 * The desk's live view. There is no graph here, no per-member spend, no worktrees, no policy
 * editor, and no way to start a run: those are for arranging work, and a phone is for unblocking
 * it. The desktop sends a view cut to that (`remotectl/teams.rs`), which is also why nothing here
 * can show a member's prompt — it never arrives.
 */

interface ItemRow {
  id: string;
  title: string;
  member: string;
  kind: string;
  status: string;
  phase: string;
  attempts: number;
  lastError: string;
  canRetry: boolean;
  canSkip: boolean;
  /** Whether it has work of its own to read — what "see the changes" is offered by. */
  hasChanges: boolean;
}

interface QuestionRow {
  id: string;
  from: string;
  body: string;
  options: string[];
  task: string;
  createdAt: string;
}

interface MessageRow {
  id: string;
  from: string;
  to: string;
  kind: string;
  body: string;
  answer: string;
  createdAt: string;
}

interface RepoRow {
  projectId: string;
  name: string;
  targetBranch: string;
  status: string;
  lastError: string;
  prUrl: string;
}

interface MemberRow {
  id: string;
  name: string;
  role: string;
  lead: boolean;
}

/** One run, opened — `teams::RunView`. */
interface RunView {
  run: TeamRunRow;
  goal: string;
  gateNote: string;
  gateTask: ItemRow | null;
  gateInstruction: string;
  planned: ItemRow[];
  gateReasons: string[];
  gateFiles: string[];
  gateAdds: string[];
  gateCancels: number;
  integrate: string;
  repos: RepoRow[];
  items: ItemRow[];
  questions: QuestionRow[];
  messages: MessageRow[];
  members: MemberRow[];
}

type Tone = "accent" | "success" | "danger" | "neutral" | "warning";

const RUN_STATUS: Record<string, { key: MobileKey; tone: Tone }> = {
  running: { key: "teams.status.running", tone: "success" },
  gated: { key: "teams.status.gated", tone: "accent" },
  paused: { key: "teams.status.paused", tone: "warning" },
  done: { key: "teams.status.done", tone: "neutral" },
  failed: { key: "teams.status.failed", tone: "danger" },
  aborted: { key: "teams.status.aborted", tone: "neutral" },
};

/**
 * The badge a run wears in a list.
 *
 * A question outranks the run's own status: a run that is `running` while one member waits on an
 * answer reads as fine in every other respect, and it is the one thing on the row that is a request.
 */
export function TeamRunBadge({ run }: { run: TeamRunRow }) {
  if (run.status !== "gated" && run.questions > 0) {
    return (
      <Badge tone="accent" icon={<CircleHelp size={11} aria-hidden />}>
        {t("teams.asks")}
        {run.questions > 1 ? ` · ${run.questions}` : ""}
      </Badge>
    );
  }
  const look = RUN_STATUS[run.status] ?? { key: "teams.status.running" as MobileKey, tone: "neutral" as Tone };
  return (
    <Badge
      tone={look.tone}
      icon={
        run.status === "running" ? (
          <Loader2 size={11} className="animate-spin" aria-hidden />
        ) : run.status === "gated" ? (
          <CircleDot size={11} aria-hidden />
        ) : run.status === "failed" ? (
          <TriangleAlert size={11} aria-hidden />
        ) : undefined
      }
    >
      {t(look.key)}
    </Badge>
  );
}

/** "3 de 7 tareas", or nothing while the lead is still planning and there is no work to count. */
export function progressText(run: TeamRunRow): string {
  return run.total > 0 ? t("teams.progress", { done: run.done, total: run.total }) : t("teams.planning");
}

/** One run as a row — shared by this view and the summary, so a run reads the same in both. */
export function TeamRunRowView({ run }: { run: TeamRunRow }) {
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const push = useNav((s) => s.push);
  const waits = teamRunWaits(run);
  return (
    <Row
      title={run.title}
      titleClassName={waits ? "font-semibold" : ""}
      subtitle={[run.teamName, progressText(run), sinceIso(run.updatedAt)].filter(Boolean).join(" · ")}
      trailing={<TeamRunBadge run={run} />}
      onClick={() => {
        navigated();
        push({ k: "teamRun", workspaceId: workspaceId ?? "", runId: run.id, title: run.title });
      }}
    />
  );
}

/** One team, as the desk lists it for a phone (`teams::TeamRow`). */
interface TeamRow {
  id: string;
  name: string;
  description: string;
  lead: string;
  members: string[];
  runnable: boolean;
  problem: string;
}

/**
 * The teams of the workspace, each with the two things a phone starts with one: a conversation, and
 * a task.
 *
 * A team that cannot take a task — no members, no lead and no plan — says why instead of offering a
 * button that would fail: the reason is the engine's own sentence, and it names where to fix it.
 */
function TeamList() {
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const readOnly = useMobileStore((s) => s.readOnly);
  const push = useNav((s) => s.push);
  const [teams, setTeams] = useState<TeamRow[] | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    setTeams(null);
    // Quiet on failure: the runs above are the screen's content, and a desktop older than this
    // client has no such command. The section is then simply absent.
    void rpc<TeamRow[]>("team_phone_teams", { workspaceId })
      .then((rows) => alive && setTeams(rows))
      .catch(() => alive && setTeams([]));
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  if (!teams || teams.length === 0 || !workspaceId) return null;
  return (
    <Section title={t("teams.list")}>
      <Card>
        {teams.map((team, index) => (
          <div key={team.id}>
            {index > 0 && <Divider />}
            <div className="px-3 py-2.5">
              <p className="truncate text-md font-medium">{team.name}</p>
              <p className="mt-0.5 truncate text-xs text-[var(--cf-text-muted)]">
                {[team.lead ? t("teams.leadIs", { name: team.lead }) : "", t("teams.memberCount", { n: team.members.length })]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {!team.runnable && <p className="mt-1 text-xs text-[var(--cf-warning-text)]">{team.problem}</p>}
              <div className="mt-2 flex gap-2">
                <Button
                  full
                  size="sm"
                  icon={<MessagesSquare size={14} />}
                  // A chat needs a lead to talk to; a team that works from a fixed plan has none.
                  disabled={!team.lead}
                  onClick={() => {
                    navigated();
                    push({ k: "teamChat", workspaceId, teamId: team.id, teamName: team.name });
                  }}
                >
                  {t("teams.chat.open")}
                </Button>
                <Button
                  full
                  size="sm"
                  icon={<Rocket size={14} />}
                  disabled={!team.runnable || readOnly}
                  onClick={() => {
                    navigated();
                    push({ k: "teamStart", workspaceId, teamId: team.id, teamName: team.name });
                  }}
                >
                  {t("teams.start.open")}
                </Button>
              </div>
            </div>
          </div>
        ))}
      </Card>
    </Section>
  );
}

/** The Agents tab's teams view: every run of the workspace, the ones waiting first, and the teams. */
export function TeamsView() {
  const runs = useMobileStore((s) => s.teamRuns);
  const state = useMobileStore((s) => s.teamsState);
  const error = useMobileStore((s) => s.teamsError);
  const refresh = useMobileStore((s) => s.refreshTeams);

  if (runs.length === 0) {
    if (state === "loading") {
      return (
        <Section>
          <SkeletonList rows={3} />
        </Section>
      );
    }
    if (state === "error") {
      return <ErrorState title={t("teams.failed")} detail={error} onRetry={() => void refresh()} />;
    }
    // No run yet is where a first run is started from, so the teams are still offered.
    return (
      <>
        <TeamList />
        <EmptyState icon={<UsersRound size={26} aria-hidden />} title={t("teams.none")} hint={t("teams.noneHint")} />
      </>
    );
  }

  const waiting = runs.filter(teamRunWaits);
  const moving = runs.filter((run) => !teamRunWaits(run) && (run.status === "running" || run.status === "paused"));
  const over = runs.filter((run) => !teamRunWaits(run) && run.status !== "running" && run.status !== "paused");

  const group = (title: string, rows: TeamRunRow[], highlight = false) =>
    rows.length > 0 && (
      <Section title={title}>
        <Card>
          {rows.map((run, index) => (
            <div key={run.id} className={highlight ? "bg-[var(--cf-accent-soft)]" : ""}>
              {index > 0 && <Divider />}
              <TeamRunRowView run={run} />
            </div>
          ))}
        </Card>
      </Section>
    );

  return (
    <>
      {group(t("teams.waiting"), waiting, true)}
      {group(t("teams.moving"), moving)}
      <TeamList />
      {group(t("teams.over"), over)}
    </>
  );
}

/**
 * What a gate is asking, in the words the desk uses for the same gate (`RunParts.tsx`).
 *
 * The three strings are the whole contract of a gate on a phone: a title that says what happened,
 * and what each of the two answers *does*. "Aprobar / Rechazar" for all of them would be wrong for
 * most — rejecting a plan asks for another, rejecting a merge leaves the work on its branch, and
 * rejecting a stuck run fails it — and a button that does not say which is a button somebody presses
 * to find out.
 */
function gateWords(view: RunView): { title: MobileKey; yes: MobileKey; no: MobileKey } {
  const kind = view.run.gateKind;
  // `impact:<id>:<version>` — a version that starts `tests-` is the weakened-tests gate.
  const weakenedTests = kind === "impact" && (view.run.gate.split(":")[2] ?? "").startsWith("tests-");
  switch (kind) {
    case "plan":
      return { title: "teams.gate.plan", yes: "teams.gate.planYes", no: "teams.gate.planNo" };
    case "item":
      return { title: "teams.gate.item", yes: "teams.gate.itemYes", no: "teams.gate.itemNo" };
    case "merge":
      return view.integrate === "pr"
        ? { title: "teams.gate.pr", yes: "teams.gate.prYes", no: "teams.gate.mergeNo" }
        : { title: "teams.gate.merge", yes: "teams.gate.mergeYes", no: "teams.gate.mergeNo" };
    case "review":
      return { title: "teams.gate.review", yes: "teams.gate.reviewYes", no: "teams.gate.reviewNo" };
    case "deps":
      return { title: "teams.gate.deps", yes: "teams.gate.depsYes", no: "teams.gate.depsNo" };
    case "budget":
      return { title: "teams.gate.budget", yes: "teams.gate.budgetYes", no: "teams.gate.budgetNo" };
    case "sandbox":
      return { title: "teams.gate.sandbox", yes: "teams.gate.sandboxYes", no: "teams.gate.sandboxNo" };
    case "amend":
      return { title: "teams.gate.amend", yes: "teams.gate.amendYes", no: "teams.gate.amendNo" };
    case "amend_failed":
      return { title: "teams.gate.amendFailed", yes: "teams.gate.amendRetry", no: "teams.gate.amendNo" };
    case "impact":
      return weakenedTests
        ? { title: "teams.gate.tests", yes: "teams.gate.testsYes", no: "teams.gate.testsNo" }
        : { title: "teams.gate.impact", yes: "teams.gate.impactYes", no: "teams.gate.impactNo" };
    default:
      return { title: "teams.gate.stuck", yes: "teams.gate.stuckYes", no: "teams.gate.stuckNo" };
  }
}

const ITEM_STATUS: Record<string, { key: MobileKey; tone: Tone }> = {
  pending: { key: "teams.item.pending", tone: "neutral" },
  gated: { key: "teams.item.gated", tone: "accent" },
  running: { key: "teams.item.running", tone: "success" },
  waiting: { key: "teams.item.waiting", tone: "warning" },
  done: { key: "teams.item.done", tone: "neutral" },
  error: { key: "teams.item.error", tone: "danger" },
  cancelled: { key: "teams.item.cancelled", tone: "neutral" },
  skipped: { key: "teams.item.skipped", tone: "neutral" },
};

function itemBadge(item: ItemRow) {
  const look = ITEM_STATUS[item.status] ?? ITEM_STATUS.pending;
  // A running task says where it really is: waiting for a slot, working, or having its checks run.
  const key: MobileKey =
    item.status === "running" && item.phase === "queued"
      ? "teams.item.queued"
      : item.status === "running" && item.phase === "verifying"
        ? "teams.item.verifying"
        : look.key;
  return (
    <Badge
      tone={look.tone}
      icon={item.status === "running" && item.phase !== "queued" ? <Loader2 size={11} className="animate-spin" aria-hidden /> : undefined}
    >
      {t(key)}
    </Badge>
  );
}

const fieldClass =
  "mt-1 w-full resize-none rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none focus:border-[var(--cf-accent)]";

/** A list of short lines inside a gate card — the plan's tasks, an impact's files. */
function Lines({ title, lines, mono }: { title: string; lines: string[]; mono?: boolean }) {
  if (lines.length === 0) return null;
  return (
    <>
      <p className="mt-3 text-xs font-semibold text-[var(--cf-text-faint)]">{title}</p>
      <ul className="cf-scroll mt-1 max-h-48 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5">
        {lines.map((line, index) => (
          <li
            key={`${index}:${line}`}
            className={`py-0.5 text-[var(--cf-text-muted)] ${mono ? "break-all font-mono text-xs" : "text-base"}`}
          >
            {line}
          </li>
        ))}
      </ul>
    </>
  );
}

/** One question a member asked, with its own answer box. */
function QuestionCard({ question, onAnswer, busy, readOnly }: { question: QuestionRow; onAnswer: (answer: string) => void; busy: boolean; readOnly: boolean }) {
  const [answer, setAnswer] = useState(() => readDraft("teamAnswer", question.id));
  const write = (value: string) => {
    setAnswer(value);
    writeDraft("teamAnswer", question.id, value);
  };
  return (
    <Card raised padded className="mt-3 border-[var(--cf-accent)]/40 bg-[var(--cf-accent-soft)]">
      <p className="flex items-center gap-1.5 text-base font-semibold text-[var(--cf-accent-text)]">
        <CircleHelp size={15} aria-hidden />
        {t("teams.question.from", { name: question.from })}
      </p>
      {question.task && <p className="mt-0.5 text-xs text-[var(--cf-text-muted)]">{question.task}</p>}
      <p className="cf-prose cf-selectable mt-2 whitespace-pre-wrap">{question.body}</p>
      {/* The options the member offered: a tap fills the box rather than sending, so the answer is
          still read once more before it goes — and can be edited into "the second one, but…". */}
      {question.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {question.options.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={answer === option}
              onClick={() => write(option)}
              className={`cf-press rounded-full border px-3 py-1.5 text-left text-base ${
                answer === option
                  ? "border-[var(--cf-accent)] bg-[var(--cf-surface)] font-medium text-[var(--cf-accent-text)]"
                  : "border-[var(--cf-border)] bg-[var(--cf-surface)] text-[var(--cf-text)]"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <label htmlFor={`cf-team-answer-${question.id}`} className="mt-3 block text-xs font-semibold text-[var(--cf-text-faint)]">
        {t("teams.question.answer")}
      </label>
      <textarea
        id={`cf-team-answer-${question.id}`}
        value={answer}
        onChange={(e) => write(e.target.value)}
        rows={2}
        className={fieldClass}
      />
      <Button
        full
        size="lg"
        variant="primary"
        className="mt-2"
        icon={<Send size={15} />}
        loading={busy}
        disabled={readOnly || answer.trim().length === 0}
        onClick={() => onAnswer(answer.trim())}
      >
        {t("teams.question.send")}
      </Button>
    </Card>
  );
}

/** One task: its status, and — opened — why it failed and the two things to do about it. */
function ItemLine({
  item,
  onControl,
  onDiff,
  busy,
  readOnly,
}: {
  item: ItemRow;
  onControl: (action: string, success: string) => void;
  onDiff: (item: ItemRow) => void;
  busy: boolean;
  readOnly: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(item.lastError) || item.canRetry || item.canSkip || item.hasChanges;
  return (
    <div>
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((v) => !v)}
        className="cf-press-row flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="flex w-4 shrink-0 justify-center text-[var(--cf-text-faint)]">
          {expandable ? open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden /> : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-md">{item.title}</span>
          <span className="mt-0.5 block truncate text-xs text-[var(--cf-text-muted)]">
            {[item.member, item.attempts > 1 ? t("teams.item.attempts", { n: item.attempts }) : ""].filter(Boolean).join(" · ")}
          </span>
        </span>
        {itemBadge(item)}
      </button>
      {open && expandable && (
        <div className="px-3 pb-3 pl-9">
          {item.lastError && (
            <p className="cf-selectable whitespace-pre-wrap rounded-md bg-[var(--cf-danger-soft)] px-2.5 py-2 text-xs text-[var(--cf-danger-text)]">
              {item.lastError}
            </p>
          )}
          {item.hasChanges && (
            <Button full size="sm" icon={<FileDiffIcon size={14} />} className={item.lastError ? "mt-2" : ""} onClick={() => onDiff(item)}>
              {t("teams.diff.open")}
            </Button>
          )}
          {(item.canRetry || item.canSkip) && (
            <div className="mt-2 flex gap-2">
              {item.canRetry && (
                <Button
                  full
                  size="sm"
                  icon={<RotateCcw size={14} />}
                  disabled={busy || readOnly}
                  onClick={() => onControl(`retry:${item.id}`, t("toast.teamRetried"))}
                >
                  {t("teams.item.retry")}
                </Button>
              )}
              {item.canSkip && (
                <ConfirmAction
                  label={t("teams.item.skip")}
                  confirmLabel={t("teams.item.skipConfirm")}
                  icon={<SkipForward size={14} />}
                  variant="secondary"
                  disabled={busy || readOnly}
                  onConfirm={() => onControl(`skip:${item.id}`, t("toast.teamSkipped"))}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const REPO_STATUS: Record<string, { key: MobileKey; tone: Tone }> = {
  ready: { key: "teams.repo.ready", tone: "accent" },
  merged: { key: "teams.repo.merged", tone: "success" },
  left: { key: "teams.repo.left", tone: "neutral" },
  pr: { key: "teams.repo.pr", tone: "success" },
  failed: { key: "teams.repo.failed", tone: "danger" },
};

export function TeamRunScreen({ runId, title }: { runId: string; title: string }) {
  const push = useNav((s) => s.push);
  const workspaceId = useMobileStore((s) => s.workspaceId) ?? "";
  const run = useMobileStore((s) => s.run);
  const refreshTeams = useMobileStore((s) => s.refreshTeams);
  const readOnly = useMobileStore((s) => s.readOnly);
  const busy = useBusy("teams");
  const [view, setView] = useState<RunView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "gone" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);
  const [comment, setComment] = useState(() => readDraft("teamGate", runId));
  const [note, setNote] = useState(() => readDraft("teamNote", runId));
  const [noteTo, setNoteTo] = useState("all");
  const [showTalk, setShowTalk] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await rpc<RunView>("team_phone_run", { runId }));
      setState("ready");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // The engine's own sentinel for a run that was deleted (`RUN_GONE` in `team/engine`). Said,
      // with the back control still there, rather than drawn as a failure to retry.
      if (message.includes("ya no existe")) {
        setState("gone");
        return;
      }
      setFailure(message);
      // A read that fails once the run is on screen keeps what is there: the socket's next frame
      // retries it, and blanking a gate somebody is reading is worse than leaving it a beat stale.
      setState((current) => (current === "ready" ? "ready" : "error"));
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The run moved — a task ended, a gate opened, somebody answered at the desk.
  useEffect(
    () =>
      onInvalidate("teams", null, (detail) => {
        if (!detail.run || detail.run === runId) void load();
      }),
    [load, runId],
  );

  /**
   * Runs one of the four verbs and draws what it answered.
   *
   * Every one of them answers the run as it is afterwards, so the screen is redrawn from the reply
   * rather than from a second read — and the list is re-read explicitly, because the frame the
   * engine emits for this change comes back down this client's own socket a moment later, and the
   * badge on the tab bar should not wait for it.
   */
  const act = (cmd: string, args: Record<string, unknown>, success: string, after?: () => void) =>
    void run(
      async () => {
        setView(await rpc<RunView>(cmd, { runId, ...args }));
        after?.();
        void refreshTeams();
      },
      "teams",
      success,
    );

  const control = (action: string, success: string) => act("team_control", { action }, success);
  const openItemDiff = (item: ItemRow) => {
    navigated();
    push({ k: "teamDiff", workspaceId, runId, itemId: item.id, title: item.title });
  };

  if (state === "loading") {
    return (
      <Screen bar={<PushBar title={title} subtitle={t("common.loading")} />}>
        <Section>
          <SkeletonList rows={4} />
        </Section>
      </Screen>
    );
  }
  if (state === "gone") {
    return (
      <Screen bar={<PushBar title={title} />}>
        <EmptyState icon={<UsersRound size={26} aria-hidden />} title={t("teams.gone")} />
      </Screen>
    );
  }
  if (state === "error" || !view) {
    return (
      <Screen bar={<PushBar title={title} />}>
        <ErrorState title={t("teams.runFailed")} detail={failure} onRetry={() => void load()} />
      </Screen>
    );
  }

  const row = view.run;
  const gated = row.status === "gated";
  const words = gateWords(view);
  const live = row.status === "running" || row.status === "gated" || row.status === "paused";
  const percent = row.total > 0 ? Math.round((row.done / row.total) * 100) : 0;
  const decide = (approve: boolean) =>
    act(
      "team_decide",
      // The gate this screen is showing, as a precondition: the engine refuses when the run has
      // moved to another one, so a tap on a stale screen never answers a question nobody read.
      { approve, comment: comment.trim() || null, expectedGate: row.gate },
      t(approve ? "toast.teamApproved" : "toast.teamRejected"),
      () => {
        setComment("");
        clearDraft("teamGate", runId);
      },
    );

  return (
    <Screen
      onRefresh={() => load()}
      bar={<PushBar title={row.title} subtitle={row.teamName} actions={<TeamRunBadge run={row} />} />}
    >
      {readOnly && (
        <p className="mt-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 text-xs text-[var(--cf-text-muted)]">
          {t("readOnly.banner")}
        </p>
      )}

      {/* The gate, first: it is the thing being asked, and everything under it is context. */}
      {gated && (
        <Card raised padded className="mt-3 border-[var(--cf-accent)]/40 bg-[var(--cf-accent-soft)]">
          <p className="text-base font-semibold text-[var(--cf-accent-text)]">{t(words.title)}</p>
          {view.gateTask && <p className="mt-1 text-md font-medium">{view.gateTask.title}</p>}
          {view.gateNote && (
            <p className="cf-prose cf-scroll cf-selectable mt-2 max-h-56 whitespace-pre-wrap rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2.5 text-[var(--cf-text-muted)]">
              {view.gateNote}
            </p>
          )}
          {view.gateInstruction && row.gateKind === "item" && (
            <>
              <p className="mt-3 text-xs font-semibold text-[var(--cf-text-faint)]">{t("teams.gate.instruction")}</p>
              <p className="cf-prose cf-scroll cf-selectable mt-1 max-h-48 whitespace-pre-wrap rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2.5 text-[var(--cf-text-muted)]">
                {view.gateInstruction}
              </p>
            </>
          )}
          <Lines title={t("teams.gate.planned", { n: view.planned.length })} lines={view.planned.map((item) => `${item.member} · ${item.title}`)} />
          <Lines title={t("teams.gate.reasons")} lines={view.gateReasons} />
          <Lines title={t("teams.gate.adds", { n: view.gateAdds.length })} lines={view.gateAdds} />
          {view.gateCancels > 0 && (
            <p className="mt-2 text-xs text-[var(--cf-text-muted)]">{t("teams.gate.cancels", { n: view.gateCancels })}</p>
          )}
          <Lines title={t("teams.gate.files", { n: view.gateFiles.length })} lines={view.gateFiles} mono />
          {/* The change itself, one tap from the buttons that decide it. A gate about a task opens
              that task's changes; the last gate opens, per repository, what integrating would bring
              into its branch. Approving either without being able to read it would be approving on
              faith. */}
          {(view.gateTask?.hasChanges || row.gateKind === "merge") && (
            <div className="mt-3 flex flex-col gap-2">
              {view.gateTask?.hasChanges && (
                <Button full size="sm" icon={<FileDiffIcon size={14} />} onClick={() => view.gateTask && openItemDiff(view.gateTask)}>
                  {t("teams.diff.open")}
                </Button>
              )}
              {row.gateKind === "merge" &&
                view.repos.map((repo) => (
                  <Button
                    key={repo.projectId}
                    full
                    size="sm"
                    icon={<FileDiffIcon size={14} />}
                    onClick={() => {
                      navigated();
                      push({ k: "teamDiff", workspaceId, runId, projectOf: repo.projectId, title: repo.name });
                    }}
                  >
                    {t("teams.diff.openRepo", { name: repo.name })}
                  </Button>
                ))}
            </div>
          )}

          <label htmlFor="cf-team-gate" className="mt-3 block text-xs font-semibold text-[var(--cf-text-faint)]">
            {t("teams.gate.comment")}
          </label>
          <textarea
            id="cf-team-gate"
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              writeDraft("teamGate", runId, e.target.value);
            }}
            placeholder={t("teams.gate.commentPlaceholder")}
            rows={2}
            className={fieldClass}
          />
          <Button full size="lg" variant="primary" className="mt-2" loading={busy} disabled={readOnly} onClick={() => decide(true)}>
            {t(words.yes)}
          </Button>
          {/* "No" takes two taps. It is the answer that throws something away — a plan, a task, a
              run — and the one that is easiest to hit by reaching for the button above it. */}
          <div className="mt-2 flex">
            <ConfirmAction
              label={t(words.no)}
              confirmLabel={t("teams.gate.noConfirm", { action: t(words.no) })}
              icon={null}
              variant="danger"
              disabled={busy || readOnly}
              onConfirm={() => decide(false)}
            />
          </div>
        </Card>
      )}

      {view.questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          busy={busy}
          readOnly={readOnly}
          onAnswer={(answer) =>
            act("team_answer", { messageId: question.id, answer }, t("toast.teamAnswered"), () => clearDraft("teamAnswer", question.id))
          }
        />
      ))}

      <Section title={t("teams.goal")}>
        <Card padded>
          <p className="cf-prose cf-selectable whitespace-pre-wrap">{view.goal}</p>
          {row.total > 0 && (
            <>
              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--cf-sunken)]"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={row.total}
                aria-valuenow={row.done}
                aria-label={progressText(row)}
              >
                <div className="h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-300" style={{ width: `${percent}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-[var(--cf-text-muted)]">
                {[
                  progressText(row),
                  row.running > 0 ? t("teams.runningNow", { n: row.running }) : "",
                  row.failed > 0 ? t("teams.failedCount", { n: row.failed }) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </>
          )}
        </Card>
      </Section>

      {view.items.length > 0 && (
        <Section title={t("teams.tasks")}>
          <Card>
            {view.items.map((item, index) => (
              <div key={item.id}>
                {index > 0 && <Divider />}
                <ItemLine item={item} onControl={control} onDiff={openItemDiff} busy={busy} readOnly={readOnly} />
              </div>
            ))}
          </Card>
        </Section>
      )}

      {view.repos.length > 0 && (
        <Section title={t("teams.repos")}>
          <Card>
            {view.repos.map((repo, index) => {
              const look = REPO_STATUS[repo.status];
              return (
                <div key={`${repo.name}:${repo.targetBranch}`}>
                  {index > 0 && <Divider />}
                  <div className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-md">{repo.name}</span>
                        <span className="mt-0.5 block truncate font-mono text-xs text-[var(--cf-text-muted)]">→ {repo.targetBranch}</span>
                      </span>
                      {look && <Badge tone={look.tone}>{t(look.key)}</Badge>}
                    </div>
                    {repo.lastError && (
                      <p className="cf-selectable mt-1.5 whitespace-pre-wrap rounded-md bg-[var(--cf-danger-soft)] px-2.5 py-2 text-xs text-[var(--cf-danger-text)]">
                        {repo.lastError}
                      </p>
                    )}
                    {repo.prUrl && (
                      <a
                        href={repo.prUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="cf-press mt-1.5 inline-flex items-center gap-1 text-base font-medium text-[var(--cf-accent-text)]"
                      >
                        <ExternalLink size={13} aria-hidden />
                        {t("teams.repo.openPr")}
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>
        </Section>
      )}

      {/* The conversation, folded: it is context for the gate above, not the reason the screen was
          opened, and on a long run it is most of the page. */}
      {view.messages.length > 0 && (
        <Section>
          <Card>
            <button
              type="button"
              aria-expanded={showTalk}
              onClick={() => setShowTalk((v) => !v)}
              className="cf-press-row flex w-full items-center gap-2 px-3 py-2.5 text-left"
            >
              <MessageSquareText size={16} className="shrink-0 text-[var(--cf-text-muted)]" aria-hidden />
              <span className="min-w-0 flex-1 text-md">{t("teams.talk", { n: view.messages.length })}</span>
              {showTalk ? <ChevronDown size={15} aria-hidden /> : <ChevronRight size={15} aria-hidden />}
            </button>
            {showTalk &&
              view.messages.map((message) => (
                <div key={message.id}>
                  <Divider />
                  <div className="px-3 py-2.5">
                    <p className="text-xs text-[var(--cf-text-muted)]">
                      <span className="font-semibold text-[var(--cf-text)]">{message.from}</span>
                      {message.to ? ` → ${message.to}` : ""}
                      {sinceIso(message.createdAt) ? ` · ${sinceIso(message.createdAt)}` : ""}
                    </p>
                    <p className="cf-prose cf-selectable mt-1 whitespace-pre-wrap">{message.body}</p>
                    {message.answer && (
                      <p className="cf-prose cf-selectable mt-1.5 whitespace-pre-wrap border-l-2 border-[var(--cf-accent)] pl-2.5 text-[var(--cf-text-muted)]">
                        {message.answer}
                      </p>
                    )}
                  </div>
                </div>
              ))}
          </Card>
        </Section>
      )}

      {/* A note and the run's own controls, only while there is a run to tell or to steer. */}
      {live && !readOnly && (
        <>
          <Section title={t("teams.note.title")}>
            <Card padded>
              <label htmlFor="cf-team-note-to" className="block text-xs font-semibold text-[var(--cf-text-faint)]">
                {t("teams.note.to")}
              </label>
              <select
                id="cf-team-note-to"
                value={noteTo}
                onChange={(e) => setNoteTo(e.target.value)}
                className="mt-1 w-full rounded-lg border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-3 py-2 outline-none focus:border-[var(--cf-accent)]"
              >
                <option value="all">{t("teams.note.everyone")}</option>
                {view.members.map((member) => (
                  <option key={member.id} value={member.lead ? "lead" : member.id}>
                    {member.lead ? t("teams.note.lead", { name: member.name }) : member.name}
                  </option>
                ))}
              </select>
              <textarea
                aria-label={t("teams.note.title")}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  writeDraft("teamNote", runId, e.target.value);
                }}
                placeholder={t("teams.note.placeholder")}
                rows={2}
                className={`${fieldClass} mt-2`}
              />
              <Button
                full
                size="sm"
                className="mt-2"
                icon={<Send size={14} />}
                disabled={busy || note.trim().length === 0}
                onClick={() =>
                  act("team_note", { toId: noteTo, body: note.trim() }, t("toast.teamNoted"), () => {
                    setNote("");
                    clearDraft("teamNote", runId);
                  })
                }
              >
                {t("teams.note.send")}
              </Button>
            </Card>
          </Section>

          <Section>
            <div className="flex gap-2">
              {row.status === "paused" ? (
                <Button full size="sm" icon={<Play size={14} />} disabled={busy} onClick={() => control("resume", t("toast.teamResumed"))}>
                  {t("teams.resume")}
                </Button>
              ) : (
                <Button full size="sm" icon={<Pause size={14} />} disabled={busy} onClick={() => control("pause", t("toast.teamPaused"))}>
                  {t("teams.pause")}
                </Button>
              )}
              <ConfirmAction
                label={t("teams.abort")}
                confirmLabel={t("teams.abortConfirm")}
                icon={<Square size={14} />}
                variant="danger"
                disabled={busy}
                onConfirm={() => control("abort", t("toast.teamAborted"))}
              />
            </div>
          </Section>
        </>
      )}
    </Screen>
  );
}
