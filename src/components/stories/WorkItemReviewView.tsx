import { useEffect, useRef, useState } from "react";
import {
  BookText,
  Bug,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  ClipboardCheck,
  Copy,
  Cpu,
  Eraser,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderGit2,
  Gauge,
  History,
  Info,
  Link2,
  ListChecks,
  Play,
  Plug,
  Plus,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
  UploadCloud,
  User,
  Wrench,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { Select } from "../common/Select";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { confirmAction } from "../../state/confirmStore";
import {
  REVIEW_STEPS,
  STAGE_OF_STEP,
  effortLabel,
  kindOf,
  useWorkItemReviewStore,
  type PublishStep,
  type ReviewStep,
} from "../../state/workItemReviewStore";
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

/** Six cells of one size, so the row reads as a gauge rather than as six words. */
const INVEST_CELL = {
  ok: "border-[var(--cf-border)] text-[var(--cf-success)]",
  weak: "border-[color-mix(in_oklab,var(--cf-warning)_50%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] text-[var(--cf-warning)]",
  missing:
    "border-[color-mix(in_oklab,var(--cf-danger)_50%,transparent)] bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] text-[var(--cf-danger)]",
} as const;

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

/**
 * Moves something into the publish column.
 *
 * Deliberately quiet — a link, not a button. Staging is not the commitment; it is the step *before*
 * the commitment, and dressing it as a primary action would put the same visual weight on "I might
 * send this" as the publish button puts on "send it".
 */
function StageButton({ onStage }: { onStage: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onStage}
      title={t("huReview.stageHint")}
      className="flex items-center gap-1 text-[11px] text-[var(--cf-accent)] hover:underline"
    >
      <UploadCloud size={11} />
      {t("huReview.stage")}
    </button>
  );
}

/**
 * Gherkin as something you can read at a glance rather than parse.
 *
 * Only the keyword is coloured, and only at the start of a line. Highlighting the whole line would
 * make a scenario a wall of colour, and matching the keyword anywhere would light up every "cuando"
 * inside a sentence — the point is the *shape* of the scenario, which lives in the left margin.
 */
const GHERKIN_KEYWORD =
  /^(\s*)(Feature|Característica|Scenario Outline|Esquema del escenario|Scenario|Escenario|Background|Antecedentes|Given|Dado|Dada|Dados|Dadas|When|Cuando|Then|Entonces|And|Y|E|But|Pero|Examples|Ejemplos)\b/i;

function GherkinText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, at) => {
        const match = GHERKIN_KEYWORD.exec(line);
        return (
          <span key={at} className="block">
            {match ? (
              <>
                {match[1]}
                <span className="font-semibold text-[var(--cf-accent)]">{match[2]}</span>
                {line.slice(match[0].length)}
              </>
            ) : (
              line || " "
            )}
          </span>
        );
      })}
    </>
  );
}

/**
 * Text that reads as text until you want to change it.
 *
 * The story used to live in textareas that were always open, which is what made the left column a
 * stack of grey boxes: a border, a scrollbar and a fixed height per field, whether or not anybody
 * was editing. Reading is what this column is for ninety per cent of the time, so reading is the
 * resting state and the editor arrives on click — same text, same position, no dialog.
 *
 * Focus is taken on mount so the click that opens it also lands the caret; blur closes it. There is
 * no save button because there is nothing to save to: the value is already in the store.
 */
function EditableText({
  value,
  onChange,
  placeholder,
  gherkin = false,
  minRows = 3,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  gherkin?: boolean;
  minRows?: number;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const editLabel = t("huReview.clickToEdit");

  if (editing) {
    return (
      <textarea
        autoFocus
        value={value}
        rows={Math.max(minRows, value.split("\n").length + 1)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setEditing(false)}
        className={`w-full resize-y rounded-md border border-[var(--cf-accent)] bg-[var(--cf-field)] px-2.5 py-2 text-[12px] leading-relaxed outline-none ${
          gherkin ? "font-mono text-[11.5px]" : ""
        }`}
      />
    );
  }

  // A button, not a `role="textbox"` div. There is no editable region here until the click lands,
  // and announcing one that does not exist strands a screen-reader user on a control that ignores
  // every key they press. `aria-label` says what pressing it does.
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        setEditing(true);
      }}
      onClick={() => setEditing(true)}
      aria-label={editLabel}
      className={`block w-full cursor-text whitespace-pre-wrap break-words rounded-md border border-transparent px-2.5 py-2 text-left text-[12px] leading-relaxed text-[var(--cf-text)] transition-colors hover:border-[var(--cf-field-border)] hover:bg-[var(--cf-field)] focus:border-[var(--cf-accent)] focus:outline-none ${
        gherkin ? "font-mono text-[11.5px]" : ""
      }`}
    >
      {value.trim() ? (
        gherkin ? (
          <GherkinText text={value} />
        ) : (
          value
        )
      ) : (
        <span className="italic text-[var(--cf-text-muted)]">{placeholder}</span>
      )}
    </button>
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
    else {
      // Where a work item of this type keeps its prose. A bug keeps it in Repro Steps — appending
      // to Description would put the proposal in a box the bug form does not show and that
      // publishing never sends, so the user would watch it vanish.
      const isBug = current.item ? kindOf(current.item.work_item_type) === "bug" : false;
      const held = isBug ? current.reproSteps : current.description;
      const merged = `${held}${held ? "\n\n" : ""}${text}`;
      if (isBug) current.setReproSteps(merged);
      else current.setDescription(merged);
    }
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
        <div className="mt-2 flex items-center gap-2">
          <StageButton onStage={() => store().stageTask({ title: task.title, detail: task.detail })} />
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

/**
 * What the review is read against — none, some, or all of the workspace's repositories.
 *
 * Zero is a first-class answer and is labelled as one. A workspace is a project, and a story is
 * routinely written before the code that satisfies it; the picker that *required* a repository made
 * the screen unusable at exactly the moment refinement happens. The empty state therefore says
 * "sin repositorio" as a choice rather than "elige uno" as an instruction.
 */
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
        title={chosen.length === 0 ? t("huReview.noReposHint") : t("huReview.reposHint")}
        className="flex max-w-[22rem] items-center gap-1.5 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] transition-colors hover:border-[var(--cf-accent)]"
      >
        <FolderGit2 size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className={`min-w-0 truncate ${chosen.length ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
          {chosen.length === 0 ? t("huReview.noReposPicked") : chosen.map((repo) => repo.name).join(" · ")}
        </span>
        {chosen.length > 1 && (
          <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-accent)]">
            {chosen.length}
          </span>
        )}
        <ChevronDown size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="cf-fade-in absolute left-0 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
            <p className="px-2 py-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("huReview.reposOptional")}
            </p>
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

/** Whether the workspace's saved context notes travel with the story. */
function ContextToggle() {
  const t = useT();
  const on = useWorkItemReviewStore((s) => s.useContext);
  return (
    <button
      type="button"
      onClick={() => store().setUseContext(!on)}
      aria-pressed={on}
      title={on ? t("huReview.useContextHint") : t("huReview.useContextOff")}
      className={`flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 text-[12px] transition-colors ${
        on
          ? "border-[color-mix(in_oklab,var(--cf-accent)_45%,transparent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "border-[var(--cf-field-border)] bg-[var(--cf-field)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)]"
      }`}
    >
      <BookText size={12} className="shrink-0" />
      <span className="min-w-0 truncate">{t("huReview.useContext")}</span>
    </button>
  );
}

/** What produced one stage's answer, in the one line it deserves. */
function Provenance({ stage }: { stage: WorkItemReviewStage }) {
  const t = useT();
  const at = useWorkItemReviewStore((s) => s.provenance[stage]);
  if (!at) return null;

  const seconds = at.elapsed_ms / 1000;
  const took = seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const grounding =
    at.repos_read > 0 ? t("huReview.groundedIn").replace("{n}", String(at.repos_read)) : t("huReview.groundedInNone");

  return (
    <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-[var(--cf-text-muted)]">
      <Cpu size={10} className="shrink-0" />
      <span className="font-mono">{at.model || at.engine}</span>
      {at.version && <span className="font-mono opacity-70">{at.engine} {at.version}</span>}
      <span aria-hidden>·</span>
      <span className="inline-flex items-center gap-1">
        <Timer size={10} />
        {took}
      </span>
      <span aria-hidden>·</span>
      <span>{grounding}</span>
    </p>
  );
}

const STEP_ICON: Record<ReviewStep, typeof ScanSearch> = {
  analysis: ScanSearch,
  description: FileText,
  criteria: ListChecks,
  tasks: ClipboardCheck,
};

/**
 * The order the three decisions are taken in, and where the user is in it.
 *
 * A marker, not a gate: nothing stops someone publishing tasks before the description, because a
 * team that has already agreed the description elsewhere should not have to click through it. What
 * the bar does is say what the recommended order *is*, and colour the step whose work is on screen.
 */
function StepBar() {
  const t = useT();
  const step = useWorkItemReviewStore((s) => s.step);
  const queue = useWorkItemReviewStore((s) => s.queue);
  const analysis = useWorkItemReviewStore((s) => s.analysis);
  const dismissed = useWorkItemReviewStore((s) => s.dismissed);
  const proposedCriteria = useWorkItemReviewStore((s) => s.proposedCriteria);
  const proposedTasks = useWorkItemReviewStore((s) => s.proposedTasks);
  const running = useWorkItemReviewStore((s) => s.runByStage);

  // What each step has produced, so the bar carries the counts the old AI-stage chips used to and
  // the user never has to look in two places to know where the work is.
  const liveFindings = (analysis?.findings ?? [])
    .map((finding, at) => ({ finding, at }))
    .filter(({ at }) => !dismissed[`finding:${at}`]);
  const produced: Record<ReviewStep, number> = {
    analysis: liveFindings.length,
    // The same filter the description column applies, so the chip and the column can never
    // disagree about how much work is waiting in that step.
    description: liveFindings.filter(({ finding }) => finding.section !== "criterios").length,
    criteria: proposedCriteria.filter((_, at) => !dismissed[`criterion:${at}`]).length,
    tasks: proposedTasks.filter((_, at) => !dismissed[`task:${at}`]).length,
  };
  const staged = (at: ReviewStep) =>
    at === "analysis" ? false : at === "tasks" ? (queue.tasks?.length ?? 0) > 0 : queue[at] !== null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
      {REVIEW_STEPS.map((at, index) => {
        const Icon = STEP_ICON[at];
        const active = step === at;
        const published = at !== "analysis" && Boolean(queue.published[at as PublishStep]);
        const busy = Boolean(running[STAGE_OF_STEP[at] as WorkItemReviewStage]);
        return (
          <div key={at} className="flex shrink-0 items-center gap-0.5">
            {index > 0 && <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />}
            <button
              type="button"
              onClick={() => store().setStep(at)}
              aria-current={active ? "step" : undefined}
              className={`relative flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors ${
                active
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
              }`}
            >
              <span className={`tabular-nums text-[11px] ${active ? "opacity-70" : "opacity-50"}`}>{index + 1}</span>
              {busy ? (
                <ThinkingOrb size="sm" />
              ) : published ? (
                <Check size={13} className="text-[var(--cf-success)]" />
              ) : (
                <Icon size={13} />
              )}
              {t(`huReview.step_${at}` as "huReview.step_analysis")}
              {produced[at] > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${
                    active ? "bg-[var(--cf-accent)] text-white" : "bg-[var(--cf-border)] text-[var(--cf-text-muted)]"
                  }`}
                >
                  {produced[at]}
                </span>
              )}
              {staged(at) && !published && (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--cf-accent)]" aria-hidden />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The third column: what goes back to the board, and the only place it leaves from.
 *
 * Everything else on this screen is local — the left column is the item as it stands, the middle is
 * what a model proposed. This is the one that writes, so it is the one that asks: each step
 * confirms separately, names what it is about to overwrite, and afterwards says what it did rather
 * than quietly resetting.
 */
/** One column's chrome: a heading with its icon, and whatever the step put in it. */
function Column({
  icon,
  label,
  hint,
  count,
  action,
  footer,
  width,
  tinted = false,
  children,
}: {
  icon: typeof ScanSearch;
  label: string;
  hint?: string;
  count?: number;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
  tinted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden border-[var(--cf-border)] ${
        width ?? "flex-1"
      } ${tinted ? "bg-[var(--cf-bg)]" : "bg-[var(--cf-surface)]"}`}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
        <IconChip icon={icon} />
        <h3 className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--cf-text)]">{label}</h3>
        {(count ?? 0) > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-accent)]">
            {count}
          </span>
        )}
        {action && <span className="ml-auto shrink-0">{action}</span>}
      </div>
      {hint && (
        <p className="shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {hint}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{children}</div>
      {footer && <div className="shrink-0 border-t border-[var(--cf-border)] px-3 py-2.5">{footer}</div>}
    </section>
  );
}

/** Nothing here yet, and the one thing that would change that. */
function ColumnEmpty({ icon: Icon, children }: { icon: typeof ScanSearch; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon size={20} className="text-[var(--cf-border)]" />
      <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{children}</p>
    </div>
  );
}

/** The button that runs this step's AI stage, sitting in the column whose content it produces. */
function RunStage({ stage }: { stage: WorkItemReviewStage }) {
  const t = useT();
  const running = useWorkItemReviewStore((s) => Boolean(s.runByStage[stage]));
  const ready = useWorkItemReviewStore((s) => Boolean(s.item));
  const label = running ? t("huReview.stop") : t(`huReview.run.${stage}`);

  return (
    <button
      type="button"
      disabled={!ready && !running}
      title={running ? t("huReview.stopHint") : t(`huReview.what.${stage}`)}
      onClick={() => void (running ? store().stop(stage) : store().run(stage))}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium transition-[filter,border-color,color] disabled:cursor-not-allowed disabled:opacity-40 ${
        running
          ? "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
          : "bg-[var(--cf-accent)] text-white hover:brightness-110"
      }`}
    >
      {running ? <Square size={10} /> : <Play size={10} />}
      {label}
    </button>
  );
}

/**
 * The story, filtered to the step on screen.
 *
 * Showing description, criteria and child tasks all at once was the old shape and it is what made
 * the column a scroll: two thirds of it was always about something the user was not looking at,
 * while the publish column next to it sat empty. One step, one subject, three columns that agree.
 */
function StoryColumn({ step }: { step: ReviewStep }) {
  const t = useT();
  const item = useWorkItemReviewStore((s) => s.item);
  const description = useWorkItemReviewStore((s) => s.description);
  const reproSteps = useWorkItemReviewStore((s) => s.reproSteps);
  const criteria = useWorkItemReviewStore((s) => s.criteria);
  const analysis = useWorkItemReviewStore((s) => s.analysis);
  if (!item) return null;

  const isBug = kindOf(item.work_item_type) === "bug";
  const prose = isBug ? reproSteps : description;

  if (step === "analysis") {
    return (
      <Column icon={FileText} label={t("huReview.storyColumn")} hint={t("huReview.storyColumnHint")}>
        <div className="space-y-3">
          {analysis?.invest?.length ? (
            <div className="rounded-lg border border-[var(--cf-border)] p-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                {isBug ? t("huReview.bugGauge") : "INVEST"}
              </p>
              <div className="flex flex-wrap items-center gap-1">
                {analysis.invest.map((letter) => (
                  <span
                    key={letter.letter}
                    title={letter.note}
                    aria-label={`${letter.letter}: ${letter.note}`}
                    className={`inline-flex h-6 w-6 items-center justify-center rounded-md border text-[11px] font-semibold ${
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
            </div>
          ) : null}

          <div>
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {isBug ? t("huReview.fieldRepro") : t("stories.fieldDescription")}
            </p>
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-2.5 text-[12px] leading-relaxed text-[var(--cf-text)]">
              {prose.trim() || <span className="italic text-[var(--cf-text-muted)]">{t("huReview.noDescription")}</span>}
            </p>
          </div>

          <div>
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("stories.fieldCriteria")} · {criteria.length}
            </p>
            {criteria.length === 0 ? (
              <p className="px-2.5 text-[11.5px] italic text-[var(--cf-text-muted)]">{t("huReview.noCriteria")}</p>
            ) : (
              <p className="px-2.5 text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.criteriaCountHint")}</p>
            )}
          </div>
        </div>
      </Column>
    );
  }

  if (step === "description") {
    return (
      <Column
        icon={FileText}
        label={isBug ? t("huReview.fieldRepro") : t("stories.fieldDescription")}
        hint={t("huReview.clickToEdit")}
        action={<StageButton onStage={() => store().stageDescription(prose)} />}
      >
        <EditableText
          value={prose}
          onChange={(value) => (isBug ? store().setReproSteps(value) : store().setDescription(value))}
          placeholder={t("huReview.noDescription")}
          minRows={10}
        />

        {/* A bug carries both fields: the steps are its prose, but somebody may also have filled in
            the Description box that the bug form does not show. Hiding it would silently drop text
            the review is about to be asked to judge. It stays editable — the review reads it — but
            publishing this step writes the steps, not this, and the note under it says so. */}
        {isBug && description.trim() && (
          <div className="mt-4 border-t border-[var(--cf-border)] pt-3">
            <p className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("stories.fieldDescription")}
            </p>
            <p className="mb-1 px-2.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("huReview.bugDescriptionNotPublished")}
            </p>
            <EditableText
              value={description}
              onChange={(value) => store().setDescription(value)}
              placeholder={t("huReview.noDescription")}
              minRows={4}
            />
          </div>
        )}
      </Column>
    );
  }

  if (step === "criteria") {
    return (
      <Column
        icon={ListChecks}
        label={t("stories.fieldCriteria")}
        count={criteria.length}
        action={
          <span className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => store().addCriterion("")}
              title={t("huReview.addCriterionHint")}
              aria-label={t("stories.addCriterion")}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
            >
              <Plus size={13} />
            </button>
            <StageButton onStage={() => store().stageCriteria(criteria.filter((c) => c.trim()))} />
          </span>
        }
      >
        {criteria.length === 0 ? (
          <ColumnEmpty icon={ListChecks}>{t("huReview.noCriteria")}</ColumnEmpty>
        ) : (
          <div className="space-y-1.5">
            {criteria.map((criterion, at) => (
              <article
                key={at}
                style={riseDelay(at)}
                className={`group rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] ${CARD_MOTION}`}
              >
                <div className="flex items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1">
                  <span className="text-[10px] font-semibold tabular-nums text-[var(--cf-text-muted)]">
                    #{at + 1}
                  </span>
                  <button
                    type="button"
                    onClick={() => store().removeCriterion(at)}
                    title={t("stories.removeCriterion")}
                    aria-label={t("stories.removeCriterion")}
                    className="ml-auto flex h-5 w-5 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <EditableText
                  value={criterion}
                  onChange={(value) => store().setCriterion(at, value)}
                  placeholder={t("huReview.emptyCriterion")}
                  gherkin
                />
              </article>
            ))}
          </div>
        )}
      </Column>
    );
  }

  return (
    <Column icon={ClipboardCheck} label={t("huReview.existingTasks")} count={item.children.length}>
      {item.children.length === 0 ? (
        <ColumnEmpty icon={ClipboardCheck}>{t("huReview.noTasks")}</ColumnEmpty>
      ) : (
        <div className="space-y-1.5">
          {item.children.map((child, at) => (
            <ChildTaskRow key={child.id} child={child} at={at} />
          ))}
        </div>
      )}
    </Column>
  );
}

/**
 * What the AI proposes for this step, and the button that produces it.
 *
 * The run button lives here rather than in a strip of its own: "generar criterios" belongs to the
 * criteria the run produces, and putting it anywhere else is what created a second sequence of
 * steps competing with the real one.
 */
function ProposalColumn({ step }: { step: ReviewStep }) {
  const t = useT();
  const analysis = useWorkItemReviewStore((s) => s.analysis);
  const proposedCriteria = useWorkItemReviewStore((s) => s.proposedCriteria);
  const proposedTasks = useWorkItemReviewStore((s) => s.proposedTasks);
  const dismissed = useWorkItemReviewStore((s) => s.dismissed);
  const stage = STAGE_OF_STEP[step];
  const running = useWorkItemReviewStore((s) => (stage ? Boolean(s.runByStage[stage]) : false));

  const alive = <T,>(items: T[], prefix: string) => items.filter((_, at) => !dismissed[`${prefix}:${at}`]);

  // The description step has no run of its own: what it works from are the analysis findings that
  // point at the story's prose, which is exactly what "arreglar la descripción" means here.
  const proseFindings = (analysis?.findings ?? [])
    .map((finding, at) => ({ finding, at }))
    .filter(({ finding }) => finding.section !== "criterios")
    .filter(({ at }) => !dismissed[`finding:${at}`]);

  const body = () => {
    if (running) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2">
          <ThinkingOrb size="lg" />
          <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.running")}</p>
        </div>
      );
    }

    if (step === "analysis") {
      if (!analysis) return <ColumnEmpty icon={ScanSearch}>{t("huReview.analysisHint")}</ColumnEmpty>;
      return (
        <div className="space-y-2">
          {analysis.summary && (
            <p className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 text-[12px] leading-relaxed text-[var(--cf-text)]">
              {analysis.summary}
            </p>
          )}
          {analysis.findings.map((finding, at) => (
            <FindingRow key={at} finding={finding} at={at} />
          ))}
        </div>
      );
    }

    if (step === "description") {
      if (proseFindings.length === 0) {
        return <ColumnEmpty icon={FileText}>{t("huReview.noProseFindings")}</ColumnEmpty>;
      }
      return (
        <div className="space-y-2">
          {proseFindings.map(({ finding, at }) => (
            <FindingRow key={at} finding={finding} at={at} />
          ))}
        </div>
      );
    }

    if (step === "criteria") {
      if (alive(proposedCriteria, "criterion").length === 0) {
        return <ColumnEmpty icon={ListChecks}>{t("huReview.criteriaHint")}</ColumnEmpty>;
      }
      return (
        <div className="space-y-2">
          {proposedCriteria.map((criterion, at) =>
            dismissed[`criterion:${at}`] ? null : (
              <article
                key={at}
                style={riseDelay(at)}
                className={`rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 ${CARD_MOTION}`}
              >
                <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                  <ListChecks size={11} className="text-[var(--cf-success)]" />
                  {t("huReview.gherkin")}
                  <span className="tabular-nums">#{at + 1}</span>
                  <RepoChip repo={criterion.repo} />
                </div>
                <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--cf-text)]">
                  <GherkinText text={criterion.gherkin} />
                </p>
                {criterion.rationale && (
                  <p className="mt-1 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{criterion.rationale}</p>
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
      );
    }

    if (alive(proposedTasks, "task").length === 0) {
      return <ColumnEmpty icon={ClipboardCheck}>{t("huReview.tasksHint")}</ColumnEmpty>;
    }
    return (
      <div className="space-y-2">
        {proposedTasks.map((task, at) => (
          <TaskRow key={at} task={task} at={at} />
        ))}
      </div>
    );
  };

  const count =
    step === "analysis"
      ? alive(analysis?.findings ?? [], "finding").length
      : step === "description"
        ? proseFindings.length
        : step === "criteria"
          ? alive(proposedCriteria, "criterion").length
          : alive(proposedTasks, "task").length;

  const aliveTasks = alive(proposedTasks, "task");
  // The description step shows the analysis findings, so the analysis is what produced them.
  const provenanceStage: WorkItemReviewStage = stage ?? "analyze";
  const hasProvenance = useWorkItemReviewStore((s) => Boolean(s.provenance[provenanceStage]));

  return (
    <Column
      icon={Sparkles}
      label={t("huReview.aiColumn")}
      count={count}
      action={
        <span className="flex items-center gap-1.5">
          {step === "tasks" && aliveTasks.length > 0 && (
            <button
              type="button"
              onClick={() => copy(aliveTasks.map((task) => task.title).join("\n"), t("huReview.copied"))}
              title={t("huReview.copyAllTasksHint")}
              aria-label={t("huReview.copyAllTasks")}
              className="flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-accent)] dark:hover:bg-white/[0.06]"
            >
              <Copy size={12} />
            </button>
          )}
          {stage && <RunStage stage={stage} />}
        </span>
      }
      footer={hasProvenance ? <Provenance stage={provenanceStage} /> : undefined}
      tinted
    >
      {body()}
    </Column>
  );
}

/**
 * The third column: what goes back to the board, and the only place it leaves from.
 *
 * Everything else on this screen is local — the first column is the item as it stands, the second is
 * what a model proposed. This is the one that writes, so it is the one that asks: each step confirms
 * separately, names what it is about to overwrite, and afterwards says what it did rather than
 * quietly resetting.
 *
 * On the analysis step there is nothing to publish — a judgement has no field on the board — so the
 * column says what the step is for instead of showing an empty queue with a dead button.
 */
function PublishColumn({ step }: { step: ReviewStep }) {
  const t = useT();
  const queue = useWorkItemReviewStore((s) => s.queue);
  const publishing = useWorkItemReviewStore((s) => s.publishing);
  const item = useWorkItemReviewStore((s) => s.item);
  const isBug = item ? kindOf(item.work_item_type) === "bug" : false;

  if (step === "analysis") {
    return (
      <Column icon={UploadCloud} label={t("huReview.publishColumn")} width="lg:w-[19rem]">
        <ColumnEmpty icon={UploadCloud}>{t("huReview.publishNotInAnalysis")}</ColumnEmpty>
      </Column>
    );
  }

  const publishStep = step as PublishStep;
  const done = queue.published[publishStep];
  const busy = publishing === publishStep;
  const tasks = queue.tasks ?? [];
  const criteria = queue.criteria ?? [];
  const ready =
    publishStep === "tasks"
      ? tasks.length > 0
      : publishStep === "criteria"
        ? queue.criteria !== null
        : queue.description !== null;
  const count = publishStep === "tasks" ? tasks.length : publishStep === "criteria" ? criteria.length : ready ? 1 : 0;

  const confirmText = () => {
    if (publishStep === "description") return t("huReview.confirmDescription");
    if (publishStep === "criteria") return t("huReview.confirmCriteria").replace("{n}", String(criteria.length));
    return t("huReview.confirmTasks").replace("{n}", String(tasks.length));
  };

  return (
    <Column
      icon={UploadCloud}
      label={t("huReview.publishColumn")}
      count={count}
      width="lg:w-[19rem]"
      footer={
        <div className="space-y-1.5">
          <p className="flex items-start gap-1.5 text-[10.5px] leading-snug text-[var(--cf-warning)]">
            <TriangleAlert size={10} className="mt-[2px] shrink-0" />
            <span className="min-w-0">{t("huReview.writesToAzure")}</span>
          </p>
          {done && (
            <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-success)]">
              <Check size={11} className="mt-[2px] shrink-0" />
              <span className="min-w-0 break-words">
                {t("huReview.publishedAt")
                  .replace("{at}", new Date(done.at).toLocaleTimeString())
                  .replace("{n}", String(done.count))}
              </span>
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!ready || busy}
              onClick={() => {
                void confirmAction(confirmText()).then((ok) => {
                  if (ok) void store().publish(publishStep);
                });
              }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <ThinkingOrb size="sm" /> : <UploadCloud size={12} />}
              {busy ? t("huReview.publishing") : done ? t("huReview.publishAgain") : t("huReview.publish")}
            </button>
            {ready && (
              <button
                type="button"
                onClick={() => store().clearStep(publishStep)}
                title={t("huReview.clearStep")}
                aria-label={t("huReview.clearStep")}
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
              >
                <Eraser size={12} />
              </button>
            )}
          </div>
        </div>
      }
    >
      {!ready ? (
        <ColumnEmpty icon={UploadCloud}>{t("huReview.publishNothing")}</ColumnEmpty>
      ) : publishStep === "description" ? (
        <article className={`cf-rise rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 ${CARD_MOTION}`}>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {isBug ? t("huReview.fieldRepro") : t("stories.fieldDescription")}
          </p>
          <p className="whitespace-pre-wrap break-words text-[12px] leading-relaxed text-[var(--cf-text)]">
            {queue.description}
          </p>
        </article>
      ) : publishStep === "criteria" ? (
        <div className="space-y-2">
          {criteria.map((criterion, at) => (
            <article
              key={at}
              style={riseDelay(at)}
              className={`rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 ${CARD_MOTION}`}
            >
              <p className="mb-1 text-[10px] font-semibold tabular-nums text-[var(--cf-text-muted)]">#{at + 1}</p>
              <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-[var(--cf-text)]">
                <GherkinText text={criterion} />
              </p>
            </article>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map((task, at) => (
            <article
              key={at}
              style={riseDelay(at)}
              className={`flex gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-2 ${CARD_MOTION}`}
            >
              <div className="min-w-0 flex-1">
                <p className="break-words font-mono text-[11.5px] font-medium text-[var(--cf-text)]">{task.title}</p>
                {task.detail && (
                  <p className="mt-1 break-words text-[11px] leading-snug text-[var(--cf-text-muted)]">{task.detail}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => store().unstageTask(at)}
                title={t("huReview.unstage")}
                aria-label={t("huReview.unstage")}
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={12} />
              </button>
            </article>
          ))}
        </div>
      )}
    </Column>
  );
}

/** Reviews saved in this workspace, and the way back into one. */
function HistoryPicker() {
  const t = useT();
  const history = useWorkItemReviewStore((s) => s.history);
  const openId = useWorkItemReviewStore((s) => s.sessionId);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void store().loadHistory();
  }, []);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        title={t("huReview.historyHint")}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        <History size={12} className="shrink-0" />
        {t("huReview.history")}
        {history.length > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-accent)]">
            {history.length}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="cf-fade-in absolute right-0 top-full z-20 mt-1 max-h-96 w-[26rem] overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
            {history.length === 0 ? (
              <p className="px-2 py-3 text-center text-[11.5px] text-[var(--cf-text-muted)]">
                {t("huReview.historyEmpty")}
              </p>
            ) : (
              history.map((row, at) => (
                <div
                  key={row.id}
                  style={riseDelay(at)}
                  className={`cf-rise group flex items-center gap-1 rounded-md ${
                    row.id === openId ? "bg-[var(--cf-accent-soft)]" : "hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      store().openFromHistory(row);
                      setOpen(false);
                    }}
                    className="min-w-0 flex-1 px-2 py-1.5 text-left"
                  >
                    <p className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
                      <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">
                        #{row.work_item_id}
                      </span>
                      <span className="min-w-0 truncate font-medium">{row.title}</span>
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                      <span>{new Date(row.updated_at).toLocaleString()}</span>
                      {row.model && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="min-w-0 truncate font-mono">{row.model}</span>
                        </>
                      )}
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void confirmAction(t("huReview.historyDeleteConfirm")).then((ok) => {
                        if (ok) void store().removeFromHistory(row.id);
                      });
                    }}
                    title={t("huReview.historyDelete")}
                    aria-label={t("huReview.historyDelete")}
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus:opacity-100 group-hover:opacity-100"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </>
      )}
    </div>
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
  const running = useWorkItemReviewStore((s) => s.runByStage);
  const openedFrom = useWorkItemReviewStore((s) => s.openedFrom);
  const step = useWorkItemReviewStore((s) => s.step);

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
        <HistoryPicker />
      </div>

      {openedFrom && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-accent)]">
          <History size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words" title={t("huReview.snapshotHint")}>
            {t("huReview.snapshot").replace("{at}", new Date(openedFrom.at).toLocaleString())}
          </span>
        </p>
      )}

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
            {/* What the review reads against, on the item's own row rather than on a band of its
                own: these two are settings for the runs, not a step, and giving them a strip made
                the screen four horizontal bands deep before any content started. */}
            <div className="mt-[2px] flex shrink-0 items-center gap-1.5">
              <RepoPicker />
              <ContextToggle />
              <button
                type="button"
                onClick={() => void openExternalUrl(item.url).catch((e: unknown) => pushErrorToast(String(e)))}
                title={t("huReview.openInAzureHint")}
                aria-label={t("huReview.openInAzure")}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <ExternalLink size={13} />
              </button>
            </div>
          </div>

          {/* 3 — the one path. Nothing else lives on this band: the AI runs used to sit here as a
              second, near-identical triad, and each now lives inside the column whose content it
              produces. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5">
            <StepBar />
            {anyRunning && (
              <button
                type="button"
                onClick={() => {
                  for (const stage of Object.keys(running) as WorkItemReviewStage[]) {
                    void store().stop(stage);
                  }
                }}
                title={t("huReview.stopHint")}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11.5px] font-medium text-[var(--cf-text)] transition-colors hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
              >
                <Square size={10} />
                {t("huReview.stop")}
              </button>
            )}
          </div>

          {/* 4 — the three columns, all filtered to the step above. */}
          <div className="cf-fade-in flex min-h-0 flex-1 flex-col divide-y divide-[var(--cf-border)] overflow-hidden lg:flex-row lg:divide-x lg:divide-y-0">
            <StoryColumn key={`story-${step}`} step={step} />
            <ProposalColumn key={`ai-${step}`} step={step} />
            <PublishColumn key={`publish-${step}`} step={step} />
          </div>

          {/* 5 — the promise this screen makes, and the only way to undo the session.

              The promise changed when the third column arrived: it used to be "nothing is written
              back", which is no longer true and would have been the worst possible thing to keep
              saying. What survives is the part that still holds — the reading and the proposing
              change nothing, and the only writes are the ones the user staged and confirmed. */}
          <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
            <ShieldCheck size={11} className="shrink-0 text-[var(--cf-success)]" />
            <span className="min-w-0 truncate" title={t("huReview.stagedOnly")}>
              {t("huReview.stagedOnly")}
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
