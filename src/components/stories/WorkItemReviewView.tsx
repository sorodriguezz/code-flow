import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Copy,
  Eraser,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderGit2,
  Gauge,
  Info,
  Link2,
  ListChecks,
  Play,
  Plug,
  Plus,
  ScanSearch,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  User,
  Wrench,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { Select } from "../common/Select";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { confirmAction } from "../../state/confirmStore";
import { effortLabel, kindOf, useWorkItemReviewStore } from "../../state/workItemReviewStore";
import { useT } from "../../state/languageStore";
import { useActiveProjects } from "../../state/workspaceStore";
import { useUiStore } from "../../state/uiStore";
import { loadAdoConnections } from "../../lib/adoConnections";
import { htmlToText } from "../../lib/workItemHtml";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import type {
  AdoWorkItemChild,
  ProposedTask,
  ReviewFinding,
  StorySection,
  WorkItemReviewStage,
} from "../../types/domain";

/**
 * Deliberately carries no width. A `w-full` baked in here loses to — or beats, depending on which
 * Tailwind emits last — every `w-40` or `flex-1` a call site puts next to it, and two utilities
 * fighting over one property is not a fight you can read off the class list.
 */
const FIELD =
  "rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]";
/** The common case, spelled once: a field that owns its row. */
const FIELD_FULL = `${FIELD} w-full`;

/** Severity as a shape on the card's edge, not only as a coloured word too small to compare.
 * The hover repeat is load-bearing: `CARD_MOTION`'s hover tint is the `border-color` shorthand,
 * which at hover specificity resets this longhand too — without the repeat, pointing at a card
 * is exactly when its severity colour would fade out. */
const SEVERITY_RAIL: Record<ReviewFinding["severity"], string> = {
  alta: "border-l-[var(--cf-danger)] hover:border-l-[var(--cf-danger)]",
  media: "border-l-[var(--cf-warning)] hover:border-l-[var(--cf-warning)]",
  baja: "border-l-[var(--cf-border)] hover:border-l-[var(--cf-border)]",
};
const SEVERITY_TEXT: Record<ReviewFinding["severity"], string> = {
  alta: "text-[var(--cf-danger)]",
  media: "text-[var(--cf-warning)]",
  baja: "text-[var(--cf-text-muted)]",
};
const SEVERITY_ICON = { alta: TriangleAlert, media: CircleAlert, baja: Info } as const;

/** The same severity, as a wash over the whole card — faint enough to rank, not to shout. */
const SEVERITY_CARD: Record<ReviewFinding["severity"], string> = {
  alta: "bg-[color-mix(in_oklab,var(--cf-danger)_4%,var(--cf-surface))]",
  media: "bg-[color-mix(in_oklab,var(--cf-warning)_4%,var(--cf-surface))]",
  baja: "bg-[var(--cf-surface)]",
};

/**
 * Every proposal card moves the same way: rises in when it arrives, lifts a shadow under the
 * pointer. One string, so a new kind of card cannot arrive with half the behaviour.
 */
const CARD_MOTION =
  "cf-rise transition-[border-color,box-shadow] duration-150 hover:border-[color-mix(in_oklab,var(--cf-accent)_40%,var(--cf-border))] hover:shadow-[var(--cf-shadow)]";

/** Staggered entry: each card waits on the one above, capped so a long list doesn't crawl. */
function riseDelay(at: number): React.CSSProperties {
  return { "--cf-rise-delay": `${Math.min(at, 8) * 45}ms` } as React.CSSProperties;
}

/**
 * How a child task's state is coloured. Azure states are free strings per process template — and
 * per language — so this matches the families rather than the exact words, and stays quiet for
 * anything it does not recognise: an unknown state is not news, just a state.
 */
function stateTone(state: string): string {
  if (/clos|done|complet|resolv|cerrad|resuelt|termin/i.test(state))
    return "border-[color-mix(in_oklab,var(--cf-success)_45%,transparent)] bg-[color-mix(in_oklab,var(--cf-success)_10%,transparent)] text-[var(--cf-success)]";
  if (/activ|progress|doing|curso|desarrollo/i.test(state))
    return "border-[color-mix(in_oklab,var(--cf-accent)_45%,transparent)] bg-[color-mix(in_oklab,var(--cf-accent)_10%,transparent)] text-[var(--cf-accent)]";
  if (/remov|elimin/i.test(state))
    return "border-[color-mix(in_oklab,var(--cf-danger)_45%,transparent)] bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] text-[var(--cf-danger)]";
  return "border-[var(--cf-border)] bg-transparent text-[var(--cf-text-muted)]";
}

/** Six cells of one size, so the row reads as a gauge rather than as six words. */
const INVEST_CELL = {
  ok: "border-[var(--cf-border)] text-[var(--cf-success)]",
  weak: "border-[color-mix(in_oklab,var(--cf-warning)_50%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] text-[var(--cf-warning)]",
  missing:
    "border-[color-mix(in_oklab,var(--cf-danger)_50%,transparent)] bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] text-[var(--cf-danger)]",
} as const;

const STAGES: { stage: WorkItemReviewStage; icon: typeof ScanSearch }[] = [
  { stage: "analyze", icon: ScanSearch },
  { stage: "criteria", icon: ListChecks },
  { stage: "tasks", icon: ClipboardCheck },
];

function copy(text: string, done: string) {
  void navigator.clipboard
    .writeText(text)
    .then(() => useToastStore.getState().pushToast(done, "success"))
    .catch((e: unknown) => pushErrorToast(String(e)));
}

const store = useWorkItemReviewStore.getState;

/** The tinted square every section heading wears — one shape, so the eye learns it once. */
function IconChip({ icon: Icon, tone = "accent" }: { icon: typeof ScanSearch; tone?: "accent" | "danger" }) {
  return (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md ${
        tone === "danger"
          ? "bg-[color-mix(in_oklab,var(--cf-danger)_12%,transparent)] text-[var(--cf-danger)]"
          : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
      }`}
    >
      <Icon size={11} />
    </span>
  );
}

/** Label, control and an optional line of context — the third beat the story card's fields have. */
function Field({
  icon,
  label,
  hint,
  action,
  children,
}: {
  icon?: typeof ScanSearch;
  label: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="py-3 first:pt-0 last:pb-0">
      <div className="mb-1.5 flex items-center gap-2">
        {icon && <IconChip icon={icon} />}
        <h3 className="text-[13px] font-semibold text-[var(--cf-text)]">{label}</h3>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>}
    </section>
  );
}

/** The aside's section heading: icon chip, title, and how many proposals are alive in it. */
function AsideTitle({
  icon,
  label,
  count,
  action,
}: {
  icon: typeof ScanSearch;
  label: string;
  count?: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <IconChip icon={icon} />
      <h3 className="text-[13px] font-semibold text-[var(--cf-text)]">{label}</h3>
      {(count ?? 0) > 0 && (
        <span className="rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-accent)]">
          {count}
        </span>
      )}
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

/**
 * What a section says before it has anything to say — and the way to fill it.
 *
 * The button repeats the one in the band above on purpose: a rail of three grey sentences reads as
 * three captions, and the user has to work out that the thing that fills them is somewhere else.
 */
function SectionHint({ stage, children }: { stage: WorkItemReviewStage; children: React.ReactNode }) {
  const t = useT();
  const running = useWorkItemReviewStore((s) => Boolean(s.runByStage[stage]));
  const ready = useWorkItemReviewStore((s) => Boolean(s.item) && s.projectIds.length > 0);

  if (running) {
    return (
      <p className="flex items-center gap-2 text-[11.5px] text-[var(--cf-text-muted)]">
        <ThinkingOrb size="sm" />
        {t("huReview.running")}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{children}</p>
      <button
        type="button"
        disabled={!ready}
        title={ready ? t(`huReview.what.${stage}`) : t("huReview.pickReposFirst")}
        onClick={() => void store().run(stage)}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--cf-border)] disabled:hover:text-[var(--cf-text)]"
      >
        <Play size={10} />
        {t(`huReview.run.${stage}`)}
      </button>
    </div>
  );
}

/** Where a proposal came from, shown only when more than one repository was read. */
function RepoChip({ repo }: { repo: string }) {
  if (!repo) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] px-1.5 text-[10px] text-[var(--cf-text-muted)]">
      <FolderGit2 size={9} />
      {repo}
    </span>
  );
}

/** Copy / discard: the two actions every card has, at the weight of neither. */
function CardActions({ onCopy, onDismiss }: { onCopy: () => void; onDismiss: () => void }) {
  const t = useT();
  const icon =
    "flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] dark:hover:bg-white/[0.06]";
  return (
    <>
      <button type="button" onClick={onCopy} title={t("huReview.copy")} aria-label={t("huReview.copy")} className={icon}>
        <Copy size={12} />
      </button>
      <button
        type="button"
        onClick={onDismiss}
        title={t("huReview.discard")}
        aria-label={t("huReview.discard")}
        className={`ml-auto ${icon} hover:text-[var(--cf-danger)]`}
      >
        <Trash2 size={12} />
      </button>
    </>
  );
}

/**
 * How many rows a box needs to show what is in it.
 *
 * Every criterion was a fixed three-row textarea, so a five-line scenario arrived clipped with its
 * own scrollbar — seven of those read as a wall of half-sentences rather than as the acceptance
 * criteria of one story. Counting lines rather than measuring pixels because the text here is
 * line-oriented, and because the CSS that would do it (`field-sizing: content`) is Chromium-only
 * and this app also runs on WKWebView.
 */
function rowsFor(text: string, min: number, max: number): number {
  return Math.min(max, Math.max(min, text.split("\n").length + 1));
}

const PRIMARY_ACTION =
  "rounded-md border border-[var(--cf-border)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-accent)] hover:border-[var(--cf-accent)]";

function FindingRow({ finding, at }: { finding: ReviewFinding; at: number }) {
  const t = useT();
  const key = `finding:${at}`;
  const dismissed = useWorkItemReviewStore((s) => Boolean(s.dismissed[key]));
  if (dismissed) return null;

  const Icon = SEVERITY_ICON[finding.severity] ?? Info;
  const insert = () => {
    const text = finding.proposal.trim();
    if (!text) return;
    // Appends rather than replaces, except for the title where there is only one line to hold: the
    // proposal is one move in an argument the user is having with their own story, and overwriting
    // what they wrote would be the review editing the story after all.
    const target: StorySection = finding.section;
    const current = store();
    if (target === "titulo") current.setTitle(text);
    else if (target === "criterios") current.addCriterion(text);
    else current.setDescription(`${current.description}${current.description ? "\n\n" : ""}${text}`);
    current.dismiss(key);
  };

  return (
    <article
      style={riseDelay(at)}
      className={`rounded-md border border-l-2 border-[var(--cf-border)] px-2.5 py-2 ${SEVERITY_RAIL[finding.severity] ?? SEVERITY_RAIL.baja} ${SEVERITY_CARD[finding.severity] ?? SEVERITY_CARD.baja} ${CARD_MOTION}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon size={11} className={`shrink-0 ${SEVERITY_TEXT[finding.severity] ?? SEVERITY_TEXT.baja}`} />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t(`huReview.section.${finding.section}`)}
        </span>
        <RepoChip repo={finding.repo} />
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--cf-text)]">{finding.issue}</p>
      {finding.proposal.trim() && (
        <p className="mt-1.5 whitespace-pre-wrap break-words rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5 text-[13px] leading-relaxed text-[var(--cf-text)]">
          {finding.proposal}
        </p>
      )}
      {finding.evidence.length > 0 && (
        <p className="mt-1 break-words font-mono text-[10.5px] text-[var(--cf-text-muted)]">
          {finding.evidence.join(" · ")}
        </p>
      )}
      <div className="mt-2 flex items-center gap-1">
        {finding.proposal.trim() && (
          <button type="button" onClick={insert} title={t("huReview.insertHint")} className={PRIMARY_ACTION}>
            {t("huReview.insert")}
          </button>
        )}
        <CardActions onCopy={() => copy(finding.proposal, t("huReview.copied"))} onDismiss={() => store().dismiss(key)} />
      </div>
    </article>
  );
}

function TaskRow({ task, at }: { task: ProposedTask; at: number }) {
  const t = useT();
  const key = `task:${at}`;
  const dismissed = useWorkItemReviewStore((s) => Boolean(s.dismissed[key]));
  if (dismissed) return null;

  return (
    <article
      style={riseDelay(at)}
      className={`flex gap-2 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 ${CARD_MOTION}`}
    >
      <span
        title={task.kind === "qa" ? t("huReview.qaTask") : t("huReview.devTask")}
        className={`mt-[3px] flex h-5 w-5 shrink-0 items-center justify-center rounded ${
          task.kind === "qa"
            ? "bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] text-[var(--cf-warning)]"
            : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
        }`}
      >
        {task.kind === "qa" ? <FlaskConical size={11} /> : <Wrench size={11} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="break-words font-mono text-[12px] font-medium text-[var(--cf-text)]">{task.title}</p>
        {task.detail && (
          <p className="mt-1 break-words text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{task.detail}</p>
        )}
        {(task.evidence.length > 0 || task.repo) && (
          <p className="mt-1 flex flex-wrap items-center gap-1.5 break-words font-mono text-[10.5px] text-[var(--cf-text-muted)]">
            <RepoChip repo={task.repo} />
            {task.evidence.join(" · ")}
          </p>
        )}
        <div className="mt-2 flex items-center gap-1">
          <CardActions
            onCopy={() => copy(`${task.title}\n\n${task.detail}`, t("huReview.copied"))}
            onDismiss={() => store().dismiss(key)}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * One task the story already has, readable in place.
 *
 * The row used to be nothing but a link to the browser, which made the board the only place the
 * task's text could be read — mid-review, that is a context switch per task. The content now
 * arrives with the title in the same batch read, so the chevron opens it here; the browser link
 * stays for editing, which this screen deliberately does not do.
 */
function ChildTaskRow({ child, at }: { child: AdoWorkItemChild; at: number }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const isBugChild = kindOf(child.work_item_type) === "bug";
  const content = htmlToText(child.description_html);

  return (
    <article
      style={riseDelay(at)}
      className={`overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] ${CARD_MOTION}`}
    >
      <div className="flex items-center gap-1.5 py-1 pl-1.5 pr-1">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          aria-controls={`hu-child-${child.id}`}
          title={open ? t("huReview.hideTaskContent") : t("huReview.showTaskContent")}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--cf-text-muted)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          <span title={child.work_item_type}>
            <IconChip icon={isBugChild ? Bug : ClipboardCheck} tone={isBugChild ? "danger" : "accent"} />
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">#{child.id}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">{child.title}</span>
          <span
            className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${stateTone(child.state)}`}
          >
            {child.state}
          </span>
        </button>
        <button
          type="button"
          onClick={() => void openExternalUrl(child.url).catch((e: unknown) => pushErrorToast(String(e)))}
          title={t("huReview.openChildHint")}
          aria-label={t("huReview.openChildHint")}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
        >
          <ExternalLink size={12} />
        </button>
      </div>
      {/* 0fr→1fr is the height animation CSS can do without measuring: the row grows to whatever
          the task says, and a paragraph of it stays one smooth open instead of a jump. The
          animated `visibility` is what makes the collapse true for assistive tech as well —
          overflow clipping alone leaves the text in the accessibility tree under a button that
          says `aria-expanded=false`. Transitioned with the same duration so it flips to hidden
          only once the row has finished closing. */}
      <div
        id={`hu-child-${child.id}`}
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div
          className={`min-h-0 overflow-hidden transition-[visibility] duration-200 ${open ? "visible" : "invisible"}`}
        >
          <div className="border-t border-[var(--cf-border)] px-3 py-2">
            <p className="flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
              <User size={10} className="shrink-0" />
              {child.assigned_to || t("huReview.unassigned")}
            </p>
            {content ? (
              <p className="mt-1.5 whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--cf-text)]">
                {content}
              </p>
            ) : (
              <p className="mt-1.5 text-[11.5px] italic text-[var(--cf-text-muted)]">{t("huReview.taskNoContent")}</p>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Which repositories the review reads. Several, because a story rarely lives in one. */
function RepoPicker() {
  const t = useT();
  const repos = useActiveProjects();
  const picked = useWorkItemReviewStore((s) => s.projectIds);
  const [open, setOpen] = useState(false);
  const chosen = repos.filter((repo) => picked.includes(repo.id));

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        title={t("huReview.reposHint")}
        className="flex max-w-[22rem] items-center gap-1.5 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] hover:border-[var(--cf-accent)]"
      >
        <FolderGit2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className={`min-w-0 truncate ${chosen.length ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
          {chosen.length === 0 ? t("huReview.pickRepos") : chosen.map((repo) => repo.name).join(" · ")}
        </span>
        {chosen.length > 1 && (
          <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
            {chosen.length}
          </span>
        )}
        <ChevronDown size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
            {repos.length === 0 && (
              <p className="px-2 py-1.5 text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.noRepos")}</p>
            )}
            {repos.map((repo) => (
              <label
                key={repo.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12px] text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <Checkbox checked={picked.includes(repo.id)} onChange={() => store().toggleProject(repo.id)} />
                <span className="min-w-0 truncate">{repo.name}</span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** One of the three steps, in the order they are meant to be taken. */
function StageChip({
  stage,
  icon: Icon,
  index,
  count,
  primary,
}: {
  stage: WorkItemReviewStage;
  icon: typeof ScanSearch;
  index: number;
  count: number;
  primary: boolean;
}) {
  const t = useT();
  const running = useWorkItemReviewStore((s) => Boolean(s.runByStage[stage]));
  const ready = useWorkItemReviewStore((s) => Boolean(s.item) && s.projectIds.length > 0);

  const label = running ? t("huReview.stop") : t(`huReview.run.${stage}`);
  // Produced something and is at rest: the step is behind you, and its number can say so.
  const done = count > 0 && !running;
  return (
    <button
      type="button"
      disabled={!ready && !running}
      title={running ? t("huReview.stopHint") : ready ? t(`huReview.what.${stage}`) : t("huReview.pickReposFirst")}
      onClick={() => void (running ? store().stop(stage) : store().run(stage))}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-[background-color,border-color,color,box-shadow] duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${
        primary && !running
          ? "bg-[var(--cf-accent)] text-white shadow-[0_1px_6px_color-mix(in_oklab,var(--cf-accent)_45%,transparent)] hover:brightness-110"
          : "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      }`}
    >
      {done ? (
        <Check size={11} className={primary ? "" : "text-[var(--cf-success)]"} />
      ) : (
        <span className="tabular-nums opacity-60">{index}</span>
      )}
      {running ? <ThinkingOrb size="sm" /> : <Icon size={11} />}
      {label}
      {count > 0 && !running && (
        <span className="rounded-full border border-current px-1 text-[10px] tabular-nums opacity-70">{count}</span>
      )}
    </button>
  );
}

/**
 * Reviewing a work item that is already written on the board.
 *
 * The opposite direction to the rest of this workspace: instead of deriving a backlog from
 * documentation, it takes one item that exists and asks what it is missing. The item sits on the
 * left, editable; what the AI proposes sits on the right, and moves left only when the user says so.
 *
 * Nothing is written to Azure DevOps from this screen. Everything the review produces leaves through
 * the user's own hands — inserted into the local copy, or copied out — which is what makes it safe to
 * run against a board other people are working from.
 */
export function WorkItemReviewView() {
  const t = useT();
  const openSettings = useUiStore((s) => s.openSettings);
  const input = useWorkItemReviewStore((s) => s.input);
  const org = useWorkItemReviewStore((s) => s.org);
  const loading = useWorkItemReviewStore((s) => s.loading);
  const error = useWorkItemReviewStore((s) => s.error);
  const item = useWorkItemReviewStore((s) => s.item);
  const title = useWorkItemReviewStore((s) => s.title);
  const description = useWorkItemReviewStore((s) => s.description);
  const reproSteps = useWorkItemReviewStore((s) => s.reproSteps);
  const criteria = useWorkItemReviewStore((s) => s.criteria);
  const analysis = useWorkItemReviewStore((s) => s.analysis);
  const proposedCriteria = useWorkItemReviewStore((s) => s.proposedCriteria);
  const proposedTasks = useWorkItemReviewStore((s) => s.proposedTasks);
  const dismissed = useWorkItemReviewStore((s) => s.dismissed);
  const running = useWorkItemReviewStore((s) => s.runByStage);

  const [orgs, setOrgs] = useState<string[]>([]);
  // Guards the auto-pick: the organisation must be chosen for the user only while they have not
  // chosen one, and only once — a second pass would overwrite what they picked.
  const seeded = useRef(false);
  useEffect(() => {
    void loadAdoConnections()
      .then((connections) => {
        const names = connections.map((connection) => connection.org);
        setOrgs(names);
        if (!seeded.current && names.length > 0 && !store().org) store().setOrg(names[0]);
        seeded.current = true;
      })
      .catch(() => setOrgs([]));
  }, []);

  const isBug = item ? kindOf(item.work_item_type) === "bug" : false;
  const TypeIcon = isBug ? Bug : FileText;
  const anyRunning = Object.keys(running).length > 0;
  const liveCounts = useMemo(
    () => ({
      analyze: (analysis?.findings ?? []).filter((_, at) => !dismissed[`finding:${at}`]).length,
      criteria: proposedCriteria.filter((_, at) => !dismissed[`criterion:${at}`]).length,
      tasks: proposedTasks.filter((_, at) => !dismissed[`task:${at}`]).length,
    }),
    [analysis, proposedCriteria, proposedTasks, dismissed],
  );
  // Exactly one step is offered as the next thing to do: the first that has produced nothing yet.
  const nextStage = !analysis ? "analyze" : proposedCriteria.length === 0 ? "criteria" : "tasks";

  const clearSession = () => {
    void confirmAction(t("huReview.discardSessionConfirm")).then((ok) => {
      if (ok) store().reset();
    });
  };

  return (
    // `flex-1`, not `h-full`: this is one child of the stories view's column, under the tab strip.
    // A hundred percent of the parent would be the strip's height too much, and with the parent
    // clipping its overflow the footer — the one place that says nothing is written to Azure — is
    // exactly what would fall off the bottom.
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--cf-surface)]">
      {/* 1 — what to load */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        {orgs.length === 0 ? (
          <button
            type="button"
            onClick={() => openSettings("azure", "azure")}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[11px] font-medium text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <Plug size={12} />
            {t("huReview.connectAzure")}
          </button>
        ) : (
          <div className="ml-1 w-44 shrink-0" title={t("huReview.orgHint")}>
            <Select
              size="field"
              value={org}
              placeholder={t("huReview.orgPlaceholder")}
              ariaLabel={t("huReview.orgPlaceholder")}
              onChange={(value) => store().setOrg(value)}
              options={orgs.map((name) => ({ value: name, label: name }))}
            />
          </div>
        )}

        {/* Bounded rather than free to grow: on a wide window a `flex-1` field becomes a 1500px box
            for a forty-character link, which reads as a text editor rather than as a lookup. */}
        <div className="relative min-w-[14rem] max-w-xl flex-1">
          <Link2
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
          />
          <input
            value={input}
            onChange={(e) => store().setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void store().load();
            }}
            placeholder={t("huReview.inputPlaceholder")}
            className={`${FIELD_FULL} pl-6`}
          />
        </div>
        <button
          type="button"
          disabled={loading || !input.trim()}
          title={t("huReview.loadHint")}
          onClick={() => void store().load()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? t("huReview.loading") : t("huReview.load")}
        </button>
      </div>

      {error && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-danger)_7%,transparent)] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-danger)]">
          <CircleAlert size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">{error}</span>
        </p>
      )}

      {!item ? (
        <div className="cf-fade-in flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-10">
          <EmptyState icon={ScanSearch} title={t("huReview.emptyTitle")} subtitle={t("huReview.emptyShort")} />
          <p className="-mt-2 max-w-md break-all rounded-md border border-dashed border-[var(--cf-border)] px-3 py-2 text-center font-mono text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("huReview.emptyExample")}
          </p>
        </div>
      ) : (
        <>
          {/* 2 — what is loaded. The title lives here, at the top of the type scale, instead of
              inside a 12px field under a 10px label. */}
          <div className="cf-fade-in flex shrink-0 items-start gap-2.5 border-b border-[var(--cf-border)] px-4 py-2.5">
            <span
              className={`mt-[3px] flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
                isBug
                  ? "bg-[color-mix(in_oklab,var(--cf-danger)_12%,transparent)] text-[var(--cf-danger)]"
                  : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
              }`}
            >
              {anyRunning ? <ThinkingOrb size="sm" /> : <TypeIcon size={14} />}
            </span>
            <div className="min-w-0 flex-1">
              <input
                value={title}
                onChange={(e) => store().setTitle(e.target.value)}
                aria-label={t("stories.fieldTitle")}
                className="w-full rounded-md border border-transparent bg-transparent px-1 py-0.5 text-[15px] font-semibold leading-tight text-[var(--cf-text)] outline-none hover:border-[var(--cf-field-border)] focus:border-[var(--cf-accent)] focus:bg-[var(--cf-field)]"
              />
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[11px] text-[var(--cf-text-muted)]">
                <span className="font-mono">#{item.id}</span>
                <span>{item.work_item_type}</span>
                <span className={`rounded-full border px-1.5 py-px text-[10px] font-medium ${stateTone(item.state)}`}>
                  {item.state}
                </span>
                <span aria-hidden>·</span>
                <span className="inline-flex items-center gap-1">
                  <Gauge size={11} />
                  {effortLabel(item) || t("huReview.effortUnset")}
                </span>
                {item.team_project && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="min-w-0 truncate">{item.team_project}</span>
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void openExternalUrl(item.url).catch((e: unknown) => pushErrorToast(String(e)))}
              title={t("huReview.openInAzureHint")}
              className="mt-[3px] flex shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <ExternalLink size={11} />
              {t("huReview.openInAzure")}
            </button>
          </div>

          {/* 3 — what it is read against, and the three steps in order */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
            <RepoPicker />
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {STAGES.map(({ stage, icon }, at) => (
                <div key={stage} className="flex items-center gap-1.5">
                  {at > 0 && <ChevronRight size={11} className="shrink-0 text-[var(--cf-text-muted)]" />}
                  <StageChip
                    stage={stage}
                    icon={icon}
                    index={at + 1}
                    count={liveCounts[stage]}
                    primary={stage === nextStage}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="cf-fade-in flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
            {/* The item itself, editable and local. `mx-auto` because on a wide window the capped
                column otherwise hugs the left edge with a third of the pane empty beside it. */}
            <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="mx-auto w-full max-w-3xl divide-y divide-[var(--cf-border)]">
                <Field
                  icon={FileText}
                  label={isBug ? t("huReview.fieldRepro") : t("stories.fieldDescription")}
                  hint={isBug ? t("huReview.reproHint") : t("huReview.descriptionHint")}
                >
                  <textarea
                    value={isBug ? reproSteps : description}
                    rows={rowsFor(isBug ? reproSteps : description, 7, 24)}
                    onChange={(e) => (isBug ? store().setReproSteps(e.target.value) : store().setDescription(e.target.value))}
                    className={`${FIELD_FULL} min-h-[9rem] resize-y leading-relaxed`}
                  />
                </Field>

                {/* A bug can carry both: the steps are its prose, but somebody may also have filled
                    in the description box that the form does not show. Hiding it would silently
                    drop text the review is about to be asked to judge. */}
                {isBug && description.trim() && (
                  <Field icon={FileText} label={t("stories.fieldDescription")} hint={t("huReview.bugDescriptionHint")}>
                    <textarea
                      value={description}
                      rows={rowsFor(description, 4, 16)}
                      onChange={(e) => store().setDescription(e.target.value)}
                      className={`${FIELD_FULL} resize-y leading-relaxed`}
                    />
                  </Field>
                )}

                <Field
                  icon={ListChecks}
                  label={t("stories.fieldCriteria")}
                  hint={t("huReview.criteriaFieldHint")}
                  action={
                    <button
                      type="button"
                      onClick={() => store().addCriterion("")}
                      title={t("huReview.addCriterionHint")}
                      className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
                    >
                      <Plus size={11} />
                      {t("stories.addCriterion")}
                    </button>
                  }
                >
                  <div className="space-y-1.5">
                    {criteria.length === 0 && (
                      <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.noCriteria")}</p>
                    )}
                    {criteria.map((criterion, at) => (
                      <div key={at} className="flex items-start gap-1.5">
                        <span className="mt-[7px] w-5 shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                          {at + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <textarea
                            value={criterion}
                            rows={rowsFor(criterion, 3, 20)}
                            onChange={(e) => store().setCriterion(at, e.target.value)}
                            className={`${FIELD_FULL} resize-y font-mono text-[11px] leading-relaxed`}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => store().removeCriterion(at)}
                          title={t("stories.removeCriterion")}
                          aria-label={t("stories.removeCriterion")}
                          className="mt-1.5 shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </Field>

                <Field icon={ClipboardCheck} label={t("huReview.existingTasks")} hint={t("huReview.existingTasksHint")}>
                  {item.children.length === 0 ? (
                    <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.noTasks")}</p>
                  ) : (
                    <div className="space-y-1.5">
                      {item.children.map((child, at) => (
                        <ChildTaskRow key={child.id} child={child} at={at} />
                      ))}
                    </div>
                  )}
                </Field>
              </div>
            </div>

            {/* What the review proposes. One step back from the editor's surface — recessed in
                dark, faintly grey in light — so the rail reads as its own region and the white
                cards on it keep an edge, without needing a heavier border. */}
            <aside className="flex w-full min-w-0 flex-col overflow-y-auto border-t border-[var(--cf-border)] bg-[var(--cf-bg)] lg:w-[26rem] lg:shrink-0 lg:border-l lg:border-t-0">
              <section className="border-b border-[var(--cf-border)] px-3 py-3">
                <AsideTitle icon={ScanSearch} label={t("huReview.analysis")} count={liveCounts.analyze} />
                {!analysis ? (
                  <SectionHint stage="analyze">{t("huReview.analysisHint")}</SectionHint>
                ) : (
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                        {isBug ? t("huReview.bugGauge") : "INVEST"}
                      </span>
                      {analysis.invest.map((letter) => (
                        <span
                          key={letter.letter}
                          title={letter.note}
                          aria-label={`${letter.letter}: ${letter.note}`}
                          className={`inline-flex h-5 w-5 items-center justify-center rounded border text-[11px] font-semibold ${
                            INVEST_CELL[letter.verdict] ?? INVEST_CELL.ok
                          }`}
                        >
                          {letter.letter}
                        </span>
                      ))}
                      <span className="ml-1 text-[11px] tabular-nums text-[var(--cf-text-muted)]">
                        {analysis.invest.filter((l) => l.verdict === "ok").length}/{analysis.invest.length}
                      </span>
                    </div>
                    {analysis.summary && (
                      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--cf-text)]">
                        {analysis.summary}
                      </p>
                    )}
                    {analysis.findings.map((finding, at) => (
                      <FindingRow key={at} finding={finding} at={at} />
                    ))}
                  </div>
                )}
              </section>

              <section className="border-b border-[var(--cf-border)] px-3 py-3">
                <AsideTitle icon={ListChecks} label={t("huReview.criteria")} count={liveCounts.criteria} />
                {liveCounts.criteria === 0 ? (
                  <SectionHint stage="criteria">{t("huReview.criteriaHint")}</SectionHint>
                ) : (
                  <div className="space-y-2">
                    {proposedCriteria.map((criterion, at) =>
                      dismissed[`criterion:${at}`] ? null : (
                        <article
                          key={at}
                          style={riseDelay(at)}
                          className={`rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 ${CARD_MOTION}`}
                        >
                          <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                            <ListChecks size={11} className="text-[var(--cf-success)]" />
                            {t("huReview.gherkin")}
                            <span className="tabular-nums">#{at + 1}</span>
                            <RepoChip repo={criterion.repo} />
                          </div>
                          <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--cf-text)]">
                            {criterion.gherkin}
                          </p>
                          {criterion.rationale && (
                            <p className="mt-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
                              {criterion.rationale}
                            </p>
                          )}
                          <div className="mt-2 flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                store().addCriterion(criterion.gherkin);
                                store().dismiss(`criterion:${at}`);
                              }}
                              title={t("huReview.addToStoryHint")}
                              className={PRIMARY_ACTION}
                            >
                              {t("huReview.addToStory")}
                            </button>
                            <CardActions
                              onCopy={() => copy(criterion.gherkin, t("huReview.copied"))}
                              onDismiss={() => store().dismiss(`criterion:${at}`)}
                            />
                          </div>
                        </article>
                      ),
                    )}
                  </div>
                )}
              </section>

              <section className="px-3 py-3">
                <AsideTitle
                  icon={ClipboardCheck}
                  label={t("huReview.tasks")}
                  count={liveCounts.tasks}
                  action={
                    liveCounts.tasks > 0 ? (
                      <button
                        type="button"
                        onClick={() =>
                          copy(
                            proposedTasks
                              .filter((_, at) => !dismissed[`task:${at}`])
                              .map((task) => task.title)
                              .join("\n"),
                            t("huReview.copied"),
                          )
                        }
                        title={t("huReview.copyAllTasksHint")}
                        className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
                      >
                        <Copy size={11} />
                        {t("huReview.copyAllTasks")}
                      </button>
                    ) : undefined
                  }
                />
                {liveCounts.tasks === 0 ? (
                  <SectionHint stage="tasks">{t("huReview.tasksHint")}</SectionHint>
                ) : (
                  <div className="space-y-2">
                    {proposedTasks.map((task, at) => (
                      <TaskRow key={at} task={task} at={at} />
                    ))}
                  </div>
                )}
              </section>
            </aside>
          </div>

          {/* 5 — the promise this screen makes, and the only way to undo the session */}
          <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <ShieldCheck size={11} className="shrink-0 text-[var(--cf-success)]" />
            <span className="min-w-0 truncate" title={t("huReview.localOnly")}>
              {t("huReview.localOnly")}
            </span>
            <button
              type="button"
              onClick={clearSession}
              title={t("huReview.discardSessionHint")}
              className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 font-medium hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            >
              <Eraser size={11} />
              {t("huReview.discardSession")}
            </button>
          </footer>
        </>
      )}
    </div>
  );
}
