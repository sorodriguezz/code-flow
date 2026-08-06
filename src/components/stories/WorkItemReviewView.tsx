import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  Clock,
  Gauge,
  History,
  Layers,
  ListChecks,
  Lock,
  Pencil,
  Play,
  Plug,
  Plus,
  Save,
  ScanSearch,
  Send,
  Sparkles,
  Square,
  Tag,
  Timer,
  Trash2,
  TriangleAlert,
  UploadCloud,
  User,
  Wrench,
  X,
} from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { EmptyState } from "../common/EmptyState";
import { MarkdownEditor } from "../common/MarkdownEditor";
import { ResizeHandle } from "../common/ResizeHandle";
import { Select } from "../common/Select";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { confirmAction } from "../../state/confirmStore";
import { useLayoutStore } from "../../state/layoutStore";
import {
  REVIEW_TABS,
  STAGE_OF_TAB,
  criterionText,
  draftIsEmpty,
  effortLabel,
  isRewrite,
  isSessionRunning,
  kindOf,
  stagesRunning,
  useWorkItemReviewStore,
  type CriterionProposal,
  type DraftTask,
  type PublishPart,
  type ReviewTab,
  type TaskProposal,
} from "../../state/workItemReviewStore";
import { ContextMenu } from "../api/CollectionTree";
import { useT } from "../../state/languageStore";
import { useActiveProjects } from "../../state/workspaceStore";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { AI_PROVIDERS, modelDisplayLabel } from "../../lib/aiProviders";
import { useUiStore } from "../../state/uiStore";
import { loadAdoConnections } from "../../lib/adoConnections";
import { htmlToText } from "../../lib/workItemHtml";
import { renderInlineMarkdown, renderMarkdown } from "../../lib/markdown";
import { riseDelay } from "../../lib/rise";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import type {
  BoardWorkItem,
  BoardWorkItemChild,
  CriterionFormat,
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

/**
 * Every proposal card moves the same way: rises in when it arrives, lifts a shadow under the
 * pointer. One string, so a new kind of card cannot arrive with half the behaviour.
 */
const CARD_MOTION =
  "cf-rise transition-[border-color,box-shadow] duration-150 hover:border-[color-mix(in_oklab,var(--cf-accent)_40%,var(--cf-border))] hover:shadow-[var(--cf-shadow)]";

/**
 * The left column's width, read from a custom property the board sets rather than from an inline
 * style of its own.
 *
 * The panes are side by side only from `lg` up — below that they stack, and a stacked column wants
 * the full width. An inline `style={{ width }}` cannot be told about a breakpoint, so the number
 * travels as a variable and the breakpoint stays where every other one in this file is: in the
 * class list.
 */
const SOURCE_WIDTH = "w-full shrink-0 lg:w-[var(--cf-hu-source-w)]";
const SOURCE_MIN = 280;
const SOURCE_MAX = 720;

const PRIMARY_ACTION =
  "flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 py-0.5 text-[11px] font-medium text-[var(--cf-accent)] transition-colors hover:border-[var(--cf-accent)] disabled:cursor-not-allowed disabled:opacity-40";

const ICON_ACTION =
  "flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.06]";

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
 * Gherkin as something you can read at a glance rather than parse.
 *
 * Only the keyword is coloured, and only at the start of a line. Highlighting the whole line would
 * make a scenario a wall of colour, and matching the keyword anywhere would light up every "cuando"
 * inside a sentence — the point is the *shape* of the scenario, which lives in the left margin.
 */
const GHERKIN_KEYWORD =
  /^(\s*)(Feature|Característica|Scenario Outline|Esquema del escenario|Scenario|Escenario|Background|Antecedentes|Given|Dado|Dada|Dados|Dadas|When|Cuando|Then|Entonces|And|Y|E|But|Pero|Examples|Ejemplos)\b/i;

/**
 * Angle brackets, kept out of the Markdown renderers' way.
 *
 * `<importe>` is a scenario-outline placeholder and `<html>` in a description is something somebody
 * wrote about, not markup: `marked` passes both straight through as inline HTML and the sanitiser
 * after it drops unknown elements, so the text would come out one word lighter than it went in.
 * Nothing is given up by escaping — everything on this screen arrives through `htmlToText`, which
 * has already turned every real tag into the text of that tag.
 */
function escapeAngles(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * One line of a criterion with its Markdown drawn rather than spelled.
 *
 * Criteria are Markdown all the way round the trip: the prompt asks for it, the publish sends it to
 * the board as HTML, and `htmlToText` brings the same marks back as `**…**` when the story is read
 * again a sprint later. Rendering them as literal asterisks was the one point in that loop where
 * the text stopped being what it meant — a scenario headed `**Riesgo:** ALTO` read as punctuation.
 *
 * Inline, not block: a criterion's line breaks are load-bearing (one step per line) and the block
 * renderer would reflow them into paragraphs, which is exactly the shape the Gherkin highlighter
 * exists to preserve.
 */
function MarkdownLine({ text }: { text: string }) {
  const html = useMemo(() => renderInlineMarkdown(escapeAngles(text)), [text]);
  return <span className="cf-markdown-inline" dangerouslySetInnerHTML={{ __html: html }} />;
}

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
                <MarkdownLine text={line.slice(match[0].length)} />
              </>
            ) : line ? (
              <MarkdownLine text={line} />
            ) : (
              " "
            )}
          </span>
        );
      })}
    </>
  );
}

/**
 * Which shape a criterion off the board is in, since Azure does not record it.
 *
 * A proposal knows its own format because the model was asked for it; a criterion the story
 * already had is just text. Every non-empty line being a bullet is the only signal there is, and
 * it is a good one — a Gherkin scenario has at most its first line bulleted, from the `<li>` it
 * was stored in.
 */
function looksLikeChecklist(text: string): boolean {
  const lines = text.split("\n").filter((line) => line.trim());
  return lines.length > 1 && lines.every((line) => /^\s*[-*]\s+/.test(line));
}

/**
 * A criterion's short title and its body, out of the one string both live in.
 *
 * The title is a bold first line — `**Título**\nDado que…` — and that spelling is doing real work
 * rather than being a convention this screen invented. It is Markdown, so the publish turns it
 * into a `<strong>` lead-in inside the criterion's own `<li>` and it reads as a heading on the
 * board; and `htmlToText` brings that same `<strong>` back as `**…**`, so a story loaded from the
 * board a sprint later arrives with its titles already on. Nothing has to be stored beside the
 * criteria, and nothing is lost by a round trip through a field that only holds one string.
 *
 * A first line that is not bold is not a title — it is the first line of a criterion somebody else
 * wrote, and claiming it would silently retitle their work.
 */
function splitCriterion(value: string): { title: string; body: string } {
  const [first, ...rest] = value.split("\n");
  const match = /^\s*\*\*(.+?)\*\*\s*$/.exec(first ?? "");
  if (!match) return { title: "", body: value };
  return { title: match[1].trim(), body: rest.join("\n").replace(/^\n+/, "") };
}

function joinCriterion(title: string, body: string): string {
  const named = title.trim();
  return named ? `**${named}**\n${body}` : body;
}

/**
 * The one line a collapsed criterion is folded down to.
 *
 * Its title when it has one, its first line of substance otherwise — and either way with the
 * Markdown marks taken off rather than rendered. A row set entirely in bold is a row with no
 * hierarchy left in it, and the marks are what a one-line summary has no room for. Only the paired
 * ones go, so `look_up_service` survives being named in a title.
 *
 * "Of substance" is the part that matters. A criterion pasted off a board opens with whatever the
 * editor left behind — a stray `****`, a horizontal rule, an empty bullet — and a collapsed row
 * reading `#1 ****` names nothing at all. Lines with no letter or digit in them are skipped until
 * one that says something turns up.
 */
function criterionSummary(text: string): string {
  const strip = (line: string) =>
    line
      .replace(/^\s*[-*]\s+/, "")
      .replace(/^\s*#{1,6}\s+/, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .trim();
  const { title, body } = splitCriterion(text);
  const lines = title ? [title] : body.split("\n");
  return lines.map(strip).find((line) => /[\p{L}\p{N}]/u.test(line)) ?? "";
}

/**
 * A criterion's text, drawn as whatever it is.
 *
 * A checklist rendered with the Gherkin highlighter lights up every line starting with "Y", and a
 * scenario rendered as a flat block loses the one thing that makes it scannable. One component, one
 * decision, taken from the criterion's own format.
 */
function CriterionText({ text, format }: { text: string; format: CriterionFormat | "checklist" | "gherkin" }) {
  if (format === "checklist") {
    return (
      <ul className="space-y-0.5">
        {text
          .split("\n")
          .map((line) => line.replace(/^\s*[-*]\s*/, "").trim())
          .filter(Boolean)
          .map((line, at) => (
            <li key={at} className="flex gap-1.5 text-[12px] leading-relaxed text-[var(--cf-text)]">
              <span className="mt-[5px] h-[5px] w-[5px] shrink-0 rounded-[1px] border border-[var(--cf-text-muted)]" />
              <span className="min-w-0 break-words">
                <MarkdownLine text={line} />
              </span>
            </li>
          ))}
      </ul>
    );
  }
  return (
    <p className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-[var(--cf-text)]">
      <GherkinText text={text} />
    </p>
  );
}

// ---------- chrome ----------

/**
 * One pane's chrome: a heading with its icon, whatever the tab put in it, and a footer.
 *
 * The footer is the reason this component still exists rather than being three divs at each call
 * site. Only the AI pane has something to say down there — which model answered, how long it took —
 * and when only one pane in a row draws a bottom bar, that row has one panel whose content stops
 * 34px above its neighbours'. It read as a misaligned column and it was one. Every pane in a row
 * now reserves the same strip, so the bottom edges line up whether or not there is anything in it.
 */
function Pane({
  icon,
  label,
  badge,
  count,
  action,
  footer,
  width,
  tinted = false,
  children,
}: {
  icon: typeof ScanSearch;
  label: string;
  badge?: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  /** `undefined` draws no strip at all; `null` draws an empty one, which is how a plain pane keeps
   *  its bottom edge level with the AI pane beside it. */
  footer?: React.ReactNode | null;
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
      {/* A fixed height, not `py-2`. What a header carries differs per pane — a count here, a
          padlock there, a bin only once something is staged — and the tallest of those (a 24px
          icon button) was setting the height on its own. The panes sit side by side, so a pane
          with nothing on its right was 4px shorter than its neighbours and its title and its rule
          both sat off the line they share. */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <IconChip icon={icon} />
        <h3 className="min-w-0 truncate text-[12.5px] font-semibold text-[var(--cf-text)]">{label}</h3>
        {(count ?? 0) > 0 && (
          <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-accent)]">
            {count}
          </span>
        )}
        {badge}
        {action && <span className="ml-auto flex shrink-0 items-center gap-1.5">{action}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">{children}</div>
      {footer !== undefined && (
        <div className="flex min-h-[34px] shrink-0 items-center border-t border-[var(--cf-border)] px-3 py-1.5">
          {footer}
        </div>
      )}
    </section>
  );
}

/** Nothing here yet, and the one thing that would change that. */
function PaneEmpty({ icon: Icon, children }: { icon: typeof ScanSearch; children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
      <Icon size={20} className="text-[var(--cf-border)]" />
      <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{children}</p>
    </div>
  );
}

/**
 * The model said this part is already fine.
 *
 * Deliberately not the same as an empty pane. "Nothing here yet" and "I read it and there is
 * nothing to propose" are different facts, and showing the first when the second is true is how a
 * user pays for a run three times looking for output that was never coming. There is no send
 * button under it because there is nothing to send.
 */
function NothingToPropose({ children }: { children: React.ReactNode }) {
  return (
    <div className="cf-rise flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-success)]">
        <Check size={18} />
      </span>
      <p className="text-[12px] leading-snug text-[var(--cf-text)]">{children}</p>
    </div>
  );
}

/**
 * What produced this pane's answer, in the one line it deserves.
 *
 * Takes several stages because one pane can be fed by more than one run — the tasks pane holds a
 * DEV answer and a QA answer at once — and the stamp that describes what is on screen is the last
 * of them that actually ran.
 */
function Provenance({ stages }: { stages: WorkItemReviewStage[] }) {
  const t = useT();
  const provenance = useWorkItemReviewStore((s) => s.provenance);
  const at = [...stages].reverse().map((stage) => provenance[stage]).find(Boolean);
  if (!at) return null;

  const seconds = at.elapsed_ms / 1000;
  const took = seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
  const grounding =
    at.repos_read > 0 ? t("huReview.groundedIn").replace("{n}", String(at.repos_read)) : t("huReview.groundedInNone");

  return (
    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10.5px] text-[var(--cf-text-muted)]">
      <Cpu size={10} className="shrink-0" />
      <span className="font-mono">{at.model || at.engine}</span>
      {at.version && (
        <span className="font-mono opacity-70">
          {at.engine} {at.version}
        </span>
      )}
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

/**
 * Which model is about to answer, next to the pane that will hold its answer.
 *
 * Routing lives three screens away in Settings, and a review is a judgement whose weight depends
 * entirely on who made it. Saying so *before* the run — rather than only in the provenance line
 * afterwards — is what lets someone notice they are about to refine a sprint's backlog on the
 * cheap model they picked for commit messages.
 */
function ModelTag() {
  const t = useT();
  const taskProviders = useAiProviderStore((s) => s.taskProviders);
  const taskModels = useAiProviderStore((s) => s.taskModels);
  const defaultProvider = useAiProviderStore((s) => s.providerId);

  // The task these runs route to in Rust (`AiTask::WorkItemReview`). It has to stay that one: this
  // tag is the only place the screen says which engine is about to rewrite a sprint's backlog, and
  // naming a task it does not run on would be worse than not showing it.
  const providerId = taskProviders["work_item_review"]?.trim() || defaultProvider;
  const provider = AI_PROVIDERS.find((p) => p.id === providerId);
  const engine = provider ? (provider.label ?? (provider.labelKey ? t(provider.labelKey) : providerId)) : providerId;
  const model = modelDisplayLabel(providerId, taskModels["work_item_review"] ?? "", t);

  return (
    <span
      title={t("huReview.modelTagHint")}
      className="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 py-px text-[10px] text-[var(--cf-text-muted)]"
    >
      <Cpu size={9} className="shrink-0" />
      <span className="min-w-0 truncate font-mono">{model}</span>
      <span className="shrink-0 opacity-60">{engine}</span>
    </span>
  );
}

/** The button that runs one tab's AI stage, sitting in the pane whose content it produces. */
function RunStage({ stage, label }: { stage: WorkItemReviewStage; label: string }) {
  const t = useT();
  const running = useWorkItemReviewStore((s) => Boolean(stagesRunning(s)[stage]));
  const ready = useWorkItemReviewStore((s) => Boolean(s.item) && s.status === "open");

  return (
    <button
      type="button"
      disabled={!ready && !running}
      title={running ? t("huReview.stopHint") : label}
      onClick={() => void (running ? store().stop(stage) : store().run(stage))}
      className={`flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium transition-[filter,border-color,color] disabled:cursor-not-allowed disabled:opacity-40 ${
        running
          ? "border border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
          : "bg-[var(--cf-accent)] text-white hover:brightness-110"
      }`}
    >
      {running ? <Square size={10} /> : <Play size={10} />}
      {running ? t("huReview.stop") : label}
    </button>
  );
}

/**
 * The tasks tab's Generate, which is three buttons pretending to be one.
 *
 * DEV and QA are separate runs against separate prompts, and which of them a refinement session
 * wants is genuinely open: a story whose development is already broken down still needs its QA
 * ladder, and a spike needs the opposite. Offering only "generate tasks" would mean always paying
 * for both.
 */
function RunTasksMenu() {
  const t = useT();
  const running = useWorkItemReviewStore((s) => Boolean(stagesRunning(s).tasks || stagesRunning(s).tasksqa));
  const ready = useWorkItemReviewStore((s) => Boolean(s.item) && s.status === "open");
  const [open, setOpen] = useState(false);

  if (running) {
    return (
      <button
        type="button"
        onClick={() => {
          void store().stop("tasks");
          void store().stop("tasksqa");
        }}
        title={t("huReview.stopHint")}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11.5px] font-medium text-[var(--cf-text)] transition-colors hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
      >
        <Square size={10} />
        {t("huReview.stop")}
      </button>
    );
  }

  const OPTIONS = [
    { scope: "dev" as const, icon: Wrench, label: t("huReview.tasksScopeDev"), hint: t("huReview.tasksScopeDevHint") },
    { scope: "qa" as const, icon: FlaskConical, label: t("huReview.tasksScopeQa"), hint: t("huReview.tasksScopeQaHint") },
    { scope: "both" as const, icon: Layers, label: t("huReview.tasksScopeBoth"), hint: t("huReview.tasksScopeBothHint") },
  ];

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={!ready}
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        title={t("huReview.generateTasksHint")}
        className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2 py-1 text-[11.5px] font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Play size={10} />
        {t("huReview.generateTasks")}
        <ChevronDown size={11} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="cf-fade-in absolute right-0 top-full z-20 mt-1 w-64 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
            {OPTIONS.map(({ scope, icon: Icon, label, hint }) => (
              <button
                key={scope}
                type="button"
                onClick={() => {
                  setOpen(false);
                  void store().runTasks(scope);
                }}
                className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <Icon size={12} className="mt-[3px] shrink-0 text-[var(--cf-accent)]" />
                <span className="min-w-0">
                  <span className="block text-[12px] font-medium text-[var(--cf-text)]">{label}</span>
                  <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{hint}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** The pane's body while its stage is in flight. */
function Thinking() {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2">
      <ThinkingOrb size="lg" />
      <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("huReview.running")}</p>
    </div>
  );
}

/**
 * A card that opens.
 *
 * The same shape everywhere something is a list of things whose contents are long: the story's
 * criteria, its child tasks, and every proposal. Collapsed you can count them and scan their
 * titles; open you read one. A screen that showed all of them expanded was a scroll where the
 * only way to find the third criterion was to read the first two.
 */
function Collapsible({
  at,
  head,
  actions,
  defaultOpen = false,
  tone,
  children,
}: {
  at: number;
  head: React.ReactNode;
  actions?: React.ReactNode;
  defaultOpen?: boolean;
  /** An extra border colour, for the cards that mean something other than "new". */
  tone?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <article
      style={riseDelay(at)}
      className={`overflow-hidden rounded-lg border bg-[var(--cf-surface)] ${tone ?? "border-[var(--cf-border)]"} ${CARD_MOTION}`}
    >
      <div className="flex items-center gap-1 py-1 pl-1.5 pr-1">
        <button
          type="button"
          onClick={() => setOpen((was) => !was)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-[var(--cf-text-muted)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
          />
          {head}
        </button>
        {actions}
      </div>
      {/* 0fr→1fr is the height animation CSS can do without measuring. The animated `visibility` is
          what makes the collapse true for assistive tech as well — overflow clipping alone leaves
          the text in the accessibility tree under a button that says `aria-expanded=false`. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-out ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className={`min-h-0 overflow-hidden transition-[visibility] duration-200 ${open ? "visible" : "invisible"}`}>
          <div className="border-t border-[var(--cf-border)] px-3 py-2">{children}</div>
        </div>
      </div>
    </article>
  );
}

// ---------- tab 1: the story ----------

/** The shortest a story block may be dragged: what it was fixed at before it could be dragged at
 *  all. Enough to see a description has structure, and — the reason the handle exists — not enough
 *  to read one. */
const STORY_BLOCK_MIN = 288;

/** The tallest, measured against the window rather than fixed: the point of growing the block is to
 *  read the HU without scrolling, and a block taller than the viewport just moves the scrolling up
 *  a level. The chrome subtracted is the pane header, the tab strip and the label above the box. */
function storyBlockMax(): number {
  return Math.max(STORY_BLOCK_MIN, window.innerHeight - 200);
}

/**
 * A read-only block of the work item, boxed so it reads as a quotation rather than as a field.
 *
 * Rendered as Markdown, because that is what it is. The board stores this field as HTML and
 * `htmlToText` brings it back spelled in marks — `**IT vigente**`, `` `ServiceID` ``, a `- ` per
 * bullet — so showing the string raw meant showing the punctuation of a document instead of the
 * document. The same text goes to the model either way; only the reading of it changes.
 *
 * How far it goes before it scrolls is the reader's call, and it is one height for every block on
 * the tab: they are all the same kind of thing — the item's own prose, quoted — and giving each a
 * remembered height of its own would mean setting the same preference three times.
 */
function StoryBlock({ label, text, empty }: { label: string; text: string; empty: string }) {
  const html = useMemo(() => renderMarkdown(escapeAngles(text)), [text]);
  const stored = useLayoutStore((s) => s.sizes.huReviewStoryHeight);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const boxRef = useRef<HTMLDivElement>(null);
  /** Whether there is anything below the fold — which is the only case a taller box would show
   *  more of, and so the only case the handle is worth drawing. */
  const [clipped, setClipped] = useState(false);

  // Clamped on read rather than on write: the stored height outlives the window it was set in, and
  // a value dragged on an external monitor would otherwise leave the box taller than the laptop.
  const max = storyBlockMax();
  const height = Math.min(stored, max);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setClipped(box.scrollHeight > box.clientHeight + 1);
    measure();
    // Not only on the text and the height: the pane beside this one is draggable, and the width it
    // leaves decides how many lines the same description wraps to.
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [html, height]);

  return (
    <div>
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</p>
      {/* The border says "there is something here and it goes on past the fold". Faint on purpose:
          it is a mark, not a field — nothing inside it can be typed into. */}
      <div
        ref={boxRef}
        style={{ maxHeight: height }}
        className="overflow-y-auto rounded-lg border border-[var(--cf-field-border)] bg-[color-mix(in_oklab,var(--cf-field)_45%,transparent)] px-3 py-2"
      >
        {text.trim() ? (
          // The first and last child lose their margin: a rendered document opens with a paragraph
          // whose top margin is measured against the one above it, and here there is nothing above
          // it but the box, so the text would sit a line lower than its own border.
          <div
            className="cf-markdown-preview break-words text-[12px] [&>:first-child]:mt-0 [&>:last-child]:mb-0"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : (
          <p className="text-[11.5px] italic text-[var(--cf-text-muted)]">{empty}</p>
        )}
      </div>
      {/* Only under a box that is actually cutting text off. A block shorter than the cap sits at
          its own height, so a handle under it would move the pointer and nothing else. */}
      {clipped && (
        <div className="mt-1.5">
          <ResizeHandle
            axis="y"
            value={height}
            min={STORY_BLOCK_MIN}
            max={max}
            onChange={(next) => setSize("huReviewStoryHeight", next)}
            onCommit={(next) => commitSize("huReviewStoryHeight", next)}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One task the story already has, readable in place.
 *
 * The row used to be nothing but a link to the browser, which made the board the only place the
 * task's text could be read — mid-review, that is a context switch per task. The content arrives
 * with the title in the same batch read, so the chevron opens it here; the browser link stays for
 * editing, which this screen deliberately does not do.
 */
function ChildTaskRow({ child, at }: { child: BoardWorkItemChild; at: number }) {
  const t = useT();
  const isBugChild = kindOf(child.work_item_type) === "bug";
  const content = htmlToText(child.description_html);

  return (
    <Collapsible
      at={at}
      head={
        <>
          <span title={child.work_item_type}>
            <IconChip icon={isBugChild ? Bug : ClipboardCheck} tone={isBugChild ? "danger" : "accent"} />
          </span>
          <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">#{child.id}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">{child.title}</span>
          <span className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium ${stateTone(child.state)}`}>
            {child.state}
          </span>
        </>
      }
      actions={
        <button
          type="button"
          onClick={() => void openExternalUrl(child.url).catch((e: unknown) => pushErrorToast(String(e)))}
          title={t("huReview.openChildHint")}
          aria-label={t("huReview.openChildHint")}
          className={`shrink-0 ${ICON_ACTION} hover:text-[var(--cf-accent)]`}
        >
          <ExternalLink size={12} />
        </button>
      }
    >
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
    </Collapsible>
  );
}

/** A heading with a count that folds the list under it away. */
function StorySection({
  icon,
  label,
  count,
  defaultOpen = false,
  children,
}: {
  icon: typeof ScanSearch;
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-[var(--cf-text-muted)] transition-transform duration-200 ${open ? "rotate-90" : ""}`}
        />
        <IconChip icon={icon} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[var(--cf-text)]">{label}</span>
        {count !== undefined && (
          <span className="shrink-0 rounded-full bg-[var(--cf-border)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-text-muted)]">
            {count}
          </span>
        )}
      </button>
      {open && <div className="cf-fade-in px-1 pb-2 pt-1">{children}</div>}
    </section>
  );
}

/**
 * The work item, whole and read-only.
 *
 * The one tab that is a *record* rather than a workspace: no proposals, no draft, nothing to type
 * into. Everything else on this screen is a copy the user is changing, and having one place that
 * says what the board actually holds is what makes "did I already publish that?" answerable
 * without opening a browser.
 *
 * Everything folds except the description, because the description is what a refinement session
 * reads first and the criteria and tasks are what it counts.
 */
function StoryTab() {
  const t = useT();
  const item = useWorkItemReviewStore((s) => s.item);
  const description = useWorkItemReviewStore((s) => s.description);
  const reproSteps = useWorkItemReviewStore((s) => s.reproSteps);
  const criteria = useWorkItemReviewStore((s) => s.criteria);
  if (!item) return null;

  const isBug = kindOf(item.work_item_type) === "bug";
  const systemInfo = htmlToText(item.system_info_html);

  return (
    <Pane
      icon={FileText}
      label={t("huReview.storyColumn")}
      badge={
        <span
          title={t("huReview.readOnlyHint")}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] px-1.5 py-px text-[10px] font-medium text-[var(--cf-text-muted)]"
        >
          <Lock size={9} />
          {t("huReview.readOnly")}
        </span>
      }
    >
      <div className="space-y-1">
        <div className="pb-2">
          <StoryBlock
            label={isBug ? t("huReview.fieldRepro") : t("stories.fieldDescription")}
            text={isBug ? reproSteps : description}
            empty={t("huReview.noDescription")}
          />
        </div>

        {/* A bug carries both fields: the steps are its prose, but somebody may also have filled in
            the Description box that the bug form does not show. Hiding it would drop text the
            review is judged against. */}
        {isBug && description.trim() && (
          <StorySection icon={FileText} label={t("stories.fieldDescription")}>
            <StoryBlock label={t("stories.fieldDescription")} text={description} empty={t("huReview.noDescription")} />
          </StorySection>
        )}

        {isBug && systemInfo.trim() && (
          <StorySection icon={Cpu} label={t("huReview.fieldSystemInfo")}>
            <StoryBlock label={t("huReview.fieldSystemInfo")} text={systemInfo} empty={t("huReview.noDescription")} />
          </StorySection>
        )}

        <StorySection icon={ListChecks} label={t("stories.fieldCriteria")} count={criteria.length}>
          {criteria.length === 0 ? (
            <p className="px-1 text-[11.5px] italic text-[var(--cf-text-muted)]">{t("huReview.noCriteria")}</p>
          ) : (
            <div className="space-y-1.5">
              {criteria.map((criterion, at) => (
                <Collapsible
                  key={at}
                  at={at}
                  head={
                    <>
                      <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">#{at + 1}</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                        {criterionSummary(criterion)}
                      </span>
                    </>
                  }
                  actions={
                    <button
                      type="button"
                      onClick={() => copy(criterion, t("huReview.copied"))}
                      title={t("huReview.copy")}
                      aria-label={t("huReview.copy")}
                      className={`shrink-0 ${ICON_ACTION}`}
                    >
                      <Copy size={12} />
                    </button>
                  }
                >
                  <CriterionText text={criterion} format={looksLikeChecklist(criterion) ? "checklist" : "gherkin"} />
                </Collapsible>
              ))}
            </div>
          )}
        </StorySection>

        <StorySection icon={ClipboardCheck} label={t("huReview.existingTasks")} count={item.children.length}>
          {item.children.length === 0 ? (
            <p className="px-1 text-[11.5px] italic text-[var(--cf-text-muted)]">{t("huReview.noTasks")}</p>
          ) : (
            <div className="space-y-1.5">
              {item.children.map((child, at) => (
                <ChildTaskRow key={child.id} child={child} at={at} />
              ))}
            </div>
          )}
        </StorySection>

        <StorySection icon={Tag} label={t("huReview.fieldDetails")}>
          <dl className="space-y-1 px-1 text-[11.5px]">
            {[
              [t("huReview.fieldState"), item.state],
              [t("huReview.fieldType"), item.work_item_type],
              [t("huReview.fieldEffort"), effortLabel(item) || t("huReview.effortUnset")],
              [t("huReview.fieldProject"), item.team_project],
              [t("huReview.fieldArea"), item.area_path],
              [t("huReview.fieldIteration"), item.iteration_path],
              [t("huReview.fieldTags"), item.tags],
            ]
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <dt className="w-28 shrink-0 text-[var(--cf-text-muted)]">{label}</dt>
                  <dd className="min-w-0 break-words text-[var(--cf-text)]">{value}</dd>
                </div>
              ))}
          </dl>
        </StorySection>
      </div>
    </Pane>
  );
}

// ---------- tab 2: the description ----------

function DescriptionTab({ width, seam }: { width: string; seam: React.ReactNode }) {
  const t = useT();
  const item = useWorkItemReviewStore((s) => s.item);
  const description = useWorkItemReviewStore((s) => s.description);
  const reproSteps = useWorkItemReviewStore((s) => s.reproSteps);
  const proposal = useWorkItemReviewStore((s) => s.proposedDescription);
  const produced = useWorkItemReviewStore((s) => s.producedByStage.description);
  const running = useWorkItemReviewStore((s) => Boolean(stagesRunning(s).description));
  const open = useWorkItemReviewStore((s) => s.status === "open");
  if (!item) return null;

  const isBug = kindOf(item.work_item_type) === "bug";
  const prose = isBug ? reproSteps : description;
  const label = isBug ? t("huReview.fieldRepro") : t("stories.fieldDescription");

  const body = () => {
    if (running) return <Thinking />;
    // Ran, and came back with nothing — which is an answer about the description, not an empty pane.
    if (produced === 0 && !proposal) return <NothingToPropose>{t("huReview.nothingDescription")}</NothingToPropose>;
    if (!proposal) return <PaneEmpty icon={Sparkles}>{t("huReview.descriptionAiHint")}</PaneEmpty>;

    return (
      <div className="flex h-full min-h-0 flex-col gap-2">
        {proposal.rationale && (
          <p className="shrink-0 rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
            {proposal.rationale}
          </p>
        )}
        <div className="min-h-0 flex-1">
          <MarkdownEditor
            value={proposal.description}
            readOnly
            placeholder={t("huReview.noDescription")}
            ariaLabel={t("huReview.aiColumn")}
          />
        </div>
        {proposal.evidence.length > 0 && (
          <p className="shrink-0 break-words font-mono text-[10.5px] text-[var(--cf-text-muted)]">
            {proposal.evidence.join(" · ")}
          </p>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={!open}
            onClick={() => store().sendDescriptionToDraft()}
            title={t("huReview.sendToDraftHint")}
            className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white transition-[filter] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Send size={12} />
            {t("huReview.sendToDraft")}
          </button>
          <button
            type="button"
            onClick={() => copy(proposal.description, t("huReview.copied"))}
            title={t("huReview.copy")}
            aria-label={t("huReview.copy")}
            className={`shrink-0 h-[30px] w-[30px] ${ICON_ACTION} border border-[var(--cf-border)]`}
          >
            <Copy size={12} />
          </button>
          <button
            type="button"
            disabled={!open}
            onClick={() => store().clearDescriptionProposal()}
            title={t("huReview.clearPanel")}
            aria-label={t("huReview.clearPanel")}
            className={`shrink-0 h-[30px] w-[30px] ${ICON_ACTION} border border-[var(--cf-border)] hover:text-[var(--cf-danger)] disabled:cursor-not-allowed disabled:opacity-40`}
          >
            <Eraser size={12} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <>
      <Pane icon={FileText} label={label} width={width} footer={null}>
        {/* Fills the pane top to bottom: the description is the tab's subject, and a field that
            stops a third of the way down leaves two thirds of the panel saying nothing. */}
        <div className="h-full min-h-0">
          <MarkdownEditor
            value={prose}
            readOnly={!open}
            onChange={(value) => (isBug ? store().setReproSteps(value) : store().setDescription(value))}
            placeholder={t("huReview.noDescription")}
            ariaLabel={label}
            historyKey={`${item.id}:${isBug ? "repro" : "description"}`}
          />
        </div>
      </Pane>
      {seam}
      <ProposalPane
        stages={["description"]}
        action={open && <RunStage stage="description" label={t("huReview.generateDescription")} />}
      >
        {body()}
      </ProposalPane>
    </>
  );
}

/** The right-hand pane of the three working tabs: same heading, same model tag, same footer. */
function ProposalPane({
  stages,
  count,
  action,
  children,
}: {
  stages: WorkItemReviewStage[];
  count?: number;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <Pane
      icon={Sparkles}
      label={t("huReview.aiColumn")}
      count={count}
      badge={<ModelTag />}
      action={action}
      footer={<Provenance stages={stages} />}
      tinted
    >
      {children}
    </Pane>
  );
}

// ---------- tab 3: the criteria ----------

/** One AI-proposed criterion: collapsed, editable, and colour-coded by whether it rewrites one. */
function CriterionCard({ proposal, at }: { proposal: CriterionProposal; at: number }) {
  const t = useT();
  const criteriaCount = useWorkItemReviewStore((s) => s.criteria.length);
  const open = useWorkItemReviewStore((s) => s.status === "open");
  const [editing, setEditing] = useState(false);
  const rewrite = isRewrite(proposal, criteriaCount);
  const shown = proposal.format === "ambos" ? proposal.pick : proposal.format;
  const text = criterionText(proposal);

  const FORMAT_LABEL: Record<string, string> = {
    gherkin: t("huReview.formatGherkin"),
    checklist: t("huReview.formatChecklist"),
  };

  return (
    <Collapsible
      at={at}
      // A rewrite is not a new criterion and must not look like one: the two together in one list
      // are how a story ends up holding the old wording and its correction side by side.
      tone={
        rewrite
          ? "border-[color-mix(in_oklab,var(--cf-warning)_55%,transparent)] bg-[color-mix(in_oklab,var(--cf-warning)_4%,var(--cf-surface))]"
          : undefined
      }
      head={
        <>
          <span
            className={`shrink-0 rounded-full px-1.5 py-px text-[10px] font-semibold ${
              rewrite
                ? "bg-[color-mix(in_oklab,var(--cf-warning)_16%,transparent)] text-[var(--cf-warning)]"
                : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            }`}
          >
            {rewrite ? t("huReview.rewriteOf").replace("{n}", String(proposal.replaces)) : t("huReview.newCriterion")}
          </span>
          <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 py-px text-[10px] text-[var(--cf-text-muted)]">
            {proposal.format === "ambos" ? t("huReview.formatBoth") : FORMAT_LABEL[proposal.format]}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{criterionSummary(text)}</span>
          <RepoChip repo={proposal.repo} />
        </>
      }
      actions={
        <>
          <button
            type="button"
            onClick={() => copy(text, t("huReview.copied"))}
            title={t("huReview.copy")}
            aria-label={t("huReview.copy")}
            className={`shrink-0 ${ICON_ACTION}`}
          >
            <Copy size={12} />
          </button>
          <button
            type="button"
            disabled={!open}
            onClick={() => store().removeCriterionProposal(proposal.id)}
            title={t("huReview.discard")}
            aria-label={t("huReview.discard")}
            className={`shrink-0 ${ICON_ACTION} hover:text-[var(--cf-danger)] disabled:opacity-30`}
          >
            <Trash2 size={12} />
          </button>
        </>
      }
    >
      {/* When the model could not decide, the user does — and the choice is the first thing in the
          card, because it decides what the text under it even is. */}
      {proposal.format === "ambos" && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[10.5px] text-[var(--cf-text-muted)]">{t("huReview.pickFormat")}</span>
          {(["gherkin", "checklist"] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={!open}
              onClick={() => store().editCriterionProposal(proposal.id, { pick: option })}
              className={`rounded-full border px-2 py-px text-[10.5px] font-medium transition-colors disabled:opacity-40 ${
                proposal.pick === option
                  ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)]"
              }`}
            >
              {FORMAT_LABEL[option]}
            </button>
          ))}
        </div>
      )}

      {editing ? (
        <textarea
          autoFocus
          value={text}
          rows={Math.max(4, text.split("\n").length + 1)}
          onChange={(e) =>
            store().editCriterionProposal(proposal.id, { [shown]: e.target.value } as Partial<CriterionProposal>)
          }
          onBlur={() => setEditing(false)}
          className="w-full resize-y rounded-md border border-[var(--cf-accent)] bg-[var(--cf-field)] px-2.5 py-2 font-mono text-[11.5px] leading-relaxed outline-none"
        />
      ) : (
        <CriterionText text={text} format={shown} />
      )}

      {proposal.rationale && (
        <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{proposal.rationale}</p>
      )}
      {proposal.evidence.length > 0 && (
        <p className="mt-1 break-words font-mono text-[10.5px] text-[var(--cf-text-muted)]">
          {proposal.evidence.join(" · ")}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!open}
          onClick={() => store().sendCriterionToDraft(proposal.id)}
          title={t("huReview.sendToDraftHint")}
          className={PRIMARY_ACTION}
        >
          <Send size={10} />
          {t("huReview.sendToDraft")}
        </button>
        <button
          type="button"
          disabled={!open}
          onClick={() => setEditing((was) => !was)}
          className={`${PRIMARY_ACTION} text-[var(--cf-text-muted)]`}
        >
          <Pencil size={10} />
          {editing ? t("huReview.doneEditing") : t("huReview.edit")}
        </button>
      </div>
    </Collapsible>
  );
}

function CriteriaTab({ width, seam }: { width: string; seam: React.ReactNode }) {
  const t = useT();
  const criteria = useWorkItemReviewStore((s) => s.criteria);
  const proposals = useWorkItemReviewStore((s) => s.proposedCriteria);
  const produced = useWorkItemReviewStore((s) => s.producedByStage.criteria);
  const running = useWorkItemReviewStore((s) => Boolean(stagesRunning(s).criteria));
  const open = useWorkItemReviewStore((s) => s.status === "open");

  const body = () => {
    if (running) return <Thinking />;
    if (proposals.length === 0 && produced === 0) {
      return <NothingToPropose>{t("huReview.nothingCriteria")}</NothingToPropose>;
    }
    if (proposals.length === 0) return <PaneEmpty icon={ListChecks}>{t("huReview.criteriaAiHint")}</PaneEmpty>;
    return (
      <div className="space-y-1.5">
        {proposals.map((proposal, at) => (
          <CriterionCard key={proposal.id} proposal={proposal} at={at} />
        ))}
      </div>
    );
  };

  return (
    <>
      <Pane icon={ListChecks} label={t("stories.fieldCriteria")} count={criteria.length} width={width} footer={null}>
        {criteria.length === 0 ? (
          <PaneEmpty icon={ListChecks}>{t("huReview.noCriteria")}</PaneEmpty>
        ) : (
          <div className="space-y-1.5">
            {criteria.map((criterion, at) => (
              // Folded, and the same fold as the story tab. Thirteen criteria drawn open is a pane
              // you scroll looking for the one you meant, which is the opposite of the question
              // this column answers — "which of these does the proposal beside it rewrite?".
              //
              // No delete here on purpose. This pane is what the item says today; removing a
              // criterion from it would look like removing it from the story, and the place a
              // criterion actually stops existing is the draft.
              <Collapsible
                key={at}
                at={at}
                head={
                  <>
                    <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">#{at + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">
                      {criterionSummary(criterion)}
                    </span>
                  </>
                }
                actions={
                  <button
                    type="button"
                    onClick={() => copy(criterion, t("huReview.copied"))}
                    title={t("huReview.copy")}
                    aria-label={t("huReview.copy")}
                    className={`shrink-0 ${ICON_ACTION}`}
                  >
                    <Copy size={12} />
                  </button>
                }
              >
                <CriterionText text={criterion} format={looksLikeChecklist(criterion) ? "checklist" : "gherkin"} />
              </Collapsible>
            ))}
          </div>
        )}
      </Pane>
      {seam}
      <ProposalPane
        stages={["criteria"]}
        count={proposals.length}
        action={
          <>
            {open && proposals.length > 0 && (
              <>
                <button type="button" onClick={() => store().sendAllCriteriaToDraft()} className={PRIMARY_ACTION}>
                  <Send size={10} />
                  {t("huReview.sendAllToDraft")}
                </button>
                <button
                  type="button"
                  onClick={() => store().clearCriterionProposals()}
                  title={t("huReview.clearPanel")}
                  aria-label={t("huReview.clearPanel")}
                  className={`${ICON_ACTION} hover:text-[var(--cf-danger)]`}
                >
                  <Eraser size={12} />
                </button>
              </>
            )}
            {open && <RunStage stage="criteria" label={t("huReview.generateCriteria")} />}
          </>
        }
      >
        {body()}
      </ProposalPane>
    </>
  );
}

// ---------- tab 4: the tasks ----------

/** The DEV/QA marker, one shape wherever a task is drawn. */
function KindChip({ kind }: { kind: "dev" | "qa" }) {
  const t = useT();
  return (
    <span
      title={kind === "qa" ? t("huReview.qaTask") : t("huReview.devTask")}
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded ${
        kind === "qa"
          ? "bg-[color-mix(in_oklab,var(--cf-warning)_14%,transparent)] text-[var(--cf-warning)]"
          : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
      }`}
    >
      {kind === "qa" ? <FlaskConical size={11} /> : <Wrench size={11} />}
    </span>
  );
}

/** One field of a generated task, labelled with the question it answers. */
function TaskField({
  label,
  value,
  editing,
  onChange,
}: {
  label: string;
  value: string;
  editing: boolean;
  onChange: (value: string) => void;
}) {
  if (!editing && !value.trim()) return null;
  return (
    <div className="mt-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</p>
      {editing ? (
        <textarea
          value={value}
          rows={Math.max(2, value.split("\n").length)}
          onChange={(e) => onChange(e.target.value)}
          className="mt-0.5 w-full resize-y rounded-md border border-[var(--cf-accent)] bg-[var(--cf-field)] px-2 py-1.5 text-[11.5px] leading-relaxed outline-none"
        />
      ) : (
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-[var(--cf-text)]">
          {value}
        </p>
      )}
    </div>
  );
}

function TaskCard({ proposal, at }: { proposal: TaskProposal; at: number }) {
  const t = useT();
  const open = useWorkItemReviewStore((s) => s.status === "open");
  const [editing, setEditing] = useState(false);

  /**
   * Edits keep `detail` in step with the parts, because `detail` is what gets published.
   *
   * The same Markdown the backend composes in `compose_task_detail` — label bold on its own line,
   * answer under it — so a task the user edited by hand publishes looking like one that came back
   * from a run. Both spellings have to move together.
   */
  const patch = (part: "what" | "how" | "why", value: string) => {
    const next = { ...proposal, [part]: value };
    store().editTaskProposal(proposal.id, {
      [part]: value,
      detail: [
        ["¿Qué?", next.what],
        ["¿Cómo?", next.how],
        ["¿Para qué?", next.why],
      ]
        .filter(([, text]) => text.trim())
        .map(([label, text]) => `**${label}**\n${text.trim()}`)
        .join("\n\n"),
    } as Partial<TaskProposal>);
  };

  return (
    <Collapsible
      at={at}
      head={
        <>
          <KindChip kind={proposal.kind} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] font-medium text-[var(--cf-text)]">
            {proposal.title}
          </span>
          <RepoChip repo={proposal.repo} />
        </>
      }
      actions={
        <>
          <button
            type="button"
            onClick={() => copy(`${proposal.title}\n\n${proposal.detail}`, t("huReview.copied"))}
            title={t("huReview.copy")}
            aria-label={t("huReview.copy")}
            className={`shrink-0 ${ICON_ACTION}`}
          >
            <Copy size={12} />
          </button>
          <button
            type="button"
            disabled={!open}
            onClick={() => store().removeTaskProposal(proposal.id)}
            title={t("huReview.discard")}
            aria-label={t("huReview.discard")}
            className={`shrink-0 ${ICON_ACTION} hover:text-[var(--cf-danger)] disabled:opacity-30`}
          >
            <Trash2 size={12} />
          </button>
        </>
      }
    >
      {editing && (
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
            {t("stories.fieldTitle")}
          </p>
          <input
            value={proposal.title}
            onChange={(e) => store().editTaskProposal(proposal.id, { title: e.target.value })}
            className={`${FIELD_FULL} mt-0.5 font-mono`}
          />
        </div>
      )}
      <TaskField label="¿Qué?" value={proposal.what} editing={editing} onChange={(v) => patch("what", v)} />
      <TaskField label="¿Cómo?" value={proposal.how} editing={editing} onChange={(v) => patch("how", v)} />
      <TaskField label="¿Para qué?" value={proposal.why} editing={editing} onChange={(v) => patch("why", v)} />
      {/* A customised prompt is allowed to answer in one block rather than in three parts; when it
          does, that block is the whole content of the task and has to be shown. */}
      {!proposal.what && !proposal.how && !proposal.why && proposal.detail && (
        <p className="mt-1.5 whitespace-pre-wrap break-words text-[11.5px] leading-snug text-[var(--cf-text)]">
          {proposal.detail}
        </p>
      )}
      {proposal.evidence.length > 0 && (
        <p className="mt-1.5 break-words font-mono text-[10.5px] text-[var(--cf-text-muted)]">
          {proposal.evidence.join(" · ")}
        </p>
      )}

      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          disabled={!open}
          onClick={() => store().sendTaskToDraft(proposal.id)}
          title={t("huReview.sendToDraftHint")}
          className={PRIMARY_ACTION}
        >
          <Send size={10} />
          {t("huReview.sendToDraft")}
        </button>
        <button
          type="button"
          disabled={!open}
          onClick={() => setEditing((was) => !was)}
          className={`${PRIMARY_ACTION} text-[var(--cf-text-muted)]`}
        >
          <Pencil size={10} />
          {editing ? t("huReview.doneEditing") : t("huReview.edit")}
        </button>
      </div>
    </Collapsible>
  );
}

/** A DEV or QA heading over the cards that belong to it. */
function TaskGroup({ kind, label, children }: { kind: "dev" | "qa"; label: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <p className="flex items-center gap-1.5 px-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        <KindChip kind={kind} />
        {label}
      </p>
      {children}
    </section>
  );
}

function TasksTab({ width, seam }: { width: string; seam: React.ReactNode }) {
  const t = useT();
  const item = useWorkItemReviewStore((s) => s.item);
  const proposals = useWorkItemReviewStore((s) => s.proposedTasks);
  const producedDev = useWorkItemReviewStore((s) => s.producedByStage.tasks);
  const producedQa = useWorkItemReviewStore((s) => s.producedByStage.tasksqa);
  const running = useWorkItemReviewStore((s) => Boolean(stagesRunning(s).tasks || stagesRunning(s).tasksqa));
  const open = useWorkItemReviewStore((s) => s.status === "open");
  if (!item) return null;

  const children = item.children;
  // The board's own tasks, split the same way the generated ones are: the `[QA]` marker is the
  // convention this screen puts on, so it is also how it reads them back.
  const existingQa = children.filter((child) => /^\s*\[qa\]/i.test(child.title));
  const existingDev = children.filter((child) => !/^\s*\[qa\]/i.test(child.title));
  const dev = proposals.filter((task) => task.kind === "dev");
  const qa = proposals.filter((task) => task.kind === "qa");

  const body = () => {
    if (running) return <Thinking />;
    // Something ran and the two runs between them produced nothing — which is an answer about the
    // breakdown, and different from a pane nobody has asked anything of yet.
    const ran = producedDev !== undefined || producedQa !== undefined;
    if (proposals.length === 0 && ran && (producedDev ?? 0) + (producedQa ?? 0) === 0) {
      return <NothingToPropose>{t("huReview.nothingTasks")}</NothingToPropose>;
    }
    if (proposals.length === 0) return <PaneEmpty icon={ClipboardCheck}>{t("huReview.tasksAiHint")}</PaneEmpty>;
    return (
      <div className="space-y-3">
        {dev.length > 0 && (
          <TaskGroup kind="dev" label={t("huReview.generatedDevTasks")}>
            {dev.map((proposal, at) => (
              <TaskCard key={proposal.id} proposal={proposal} at={at} />
            ))}
          </TaskGroup>
        )}
        {qa.length > 0 && (
          <TaskGroup kind="qa" label={t("huReview.generatedQaTasks")}>
            {qa.map((proposal, at) => (
              <TaskCard key={proposal.id} proposal={proposal} at={at} />
            ))}
          </TaskGroup>
        )}
      </div>
    );
  };

  return (
    <>
      <Pane icon={ClipboardCheck} label={t("huReview.existingTasks")} count={children.length} width={width} footer={null}>
        {children.length === 0 ? (
          <PaneEmpty icon={ClipboardCheck}>{t("huReview.noTasks")}</PaneEmpty>
        ) : (
          <div className="space-y-3">
            {existingDev.length > 0 && (
              <TaskGroup kind="dev" label={t("huReview.existingDevTasks")}>
                {existingDev.map((child, at) => (
                  <ChildTaskRow key={child.id} child={child} at={at} />
                ))}
              </TaskGroup>
            )}
            {existingQa.length > 0 && (
              <TaskGroup kind="qa" label={t("huReview.existingQaTasks")}>
                {existingQa.map((child, at) => (
                  <ChildTaskRow key={child.id} child={child} at={at} />
                ))}
              </TaskGroup>
            )}
          </div>
        )}
      </Pane>
      {seam}
      <ProposalPane
        // Both, in the order they run: the stamp shown is the QA one when QA ran, and the DEV one
        // otherwise, which is what `Provenance` picks from a list.
        stages={["tasks", "tasksqa"]}
        count={proposals.length}
        action={
          <>
            {open && proposals.length > 0 && (
              <>
                <button type="button" onClick={() => store().sendAllTasksToDraft()} className={PRIMARY_ACTION}>
                  <Send size={10} />
                  {t("huReview.sendAllToDraft")}
                </button>
                <button
                  type="button"
                  onClick={() => store().clearTaskProposals()}
                  title={t("huReview.clearPanel")}
                  aria-label={t("huReview.clearPanel")}
                  className={`${ICON_ACTION} hover:text-[var(--cf-danger)]`}
                >
                  <Eraser size={12} />
                </button>
              </>
            )}
            {open && <RunTasksMenu />}
          </>
        }
      >
        {body()}
      </ProposalPane>
    </>
  );
}

// ---------- tab 5: the draft ----------

/**
 * One part of the draft, with the two decisions it carries.
 *
 * Discard and Publish sit together at the bottom because they are the same question answered two
 * ways, and separating them is how a screen ends up with a Publish button and no way back.
 */
function DraftPane({
  icon,
  label,
  part,
  count,
  confirm,
  note,
  width,
  children,
}: {
  icon: typeof ScanSearch;
  label: string;
  part: PublishPart;
  count: number;
  confirm: string;
  /** What emptying this pane costs, said once next to the bin. See `PaneNote`. */
  note?: string;
  /** Omitted on the last pane, which takes whatever the two before it leave. */
  width?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  const staged = useWorkItemReviewStore((s) => (part === "tasks" ? (s.draft.tasks?.length ?? 0) > 0 : s.draft[part] !== null));
  const done = useWorkItemReviewStore((s) => s.published[part]);
  const busy = useWorkItemReviewStore((s) => s.publishing === part);
  const open = useWorkItemReviewStore((s) => s.status === "open");

  return (
    <Pane
      icon={icon}
      label={label}
      count={count}
      width={width}
      action={
        staged &&
        open && (
          <>
            {note && <PaneNote note={note} />}
            <button
              type="button"
              onClick={() => store().discardDraft(part)}
              title={t("huReview.discardPartHint")}
              className={`${ICON_ACTION} hover:text-[var(--cf-danger)]`}
              aria-label={t("huReview.discardPart")}
            >
              <Trash2 size={12} />
            </button>
          </>
        )
      }
      footer={
        <div className="flex w-full items-center gap-2">
          {done && (
            <span className="flex min-w-0 items-center gap-1 text-[10.5px] text-[var(--cf-success)]">
              <Check size={11} className="shrink-0" />
              <span className="min-w-0 truncate">
                {t("huReview.publishedAt")
                  .replace("{at}", new Date(done.at).toLocaleTimeString())
                  .replace("{n}", String(done.count))}
              </span>
            </span>
          )}
          <button
            type="button"
            disabled={!staged || busy || !open}
            onClick={() => {
              void confirmAction(confirm).then((ok) => {
                if (ok) void store().publish(part);
              });
            }}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11.5px] font-medium text-white transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <ThinkingOrb size="sm" /> : <UploadCloud size={11} />}
            {t(`huReview.publish_${part}` as "huReview.publish_description")}
          </button>
        </div>
      }
    >
      {staged ? children : <PaneEmpty icon={icon}>{t("huReview.draftPartEmpty")}</PaneEmpty>}
    </Pane>
  );
}

/**
 * The save button, which is mostly a status light.
 *
 * The session already saves itself — every edit, once the typing stops — so a plain Save would be a
 * button that never has anything to do. What is actually missing is the sentence "your work is on
 * disk", and a user who cannot see it says it to themselves by pressing something. So the same
 * control does both: it reads *Saved* while there is nothing pending, turns into *Save* the moment
 * there is, and writes immediately when pressed instead of waiting out the delay.
 *
 * Disabled while clean rather than hidden: a control that vanishes once it worked leaves the user
 * looking for it, and its wording is the only place the last save time is written down.
 */
function SaveState() {
  const t = useT();
  const dirty = useWorkItemReviewStore((s) => s.dirty);
  const saving = useWorkItemReviewStore((s) => s.saving);
  const savedAt = useWorkItemReviewStore((s) => s.savedAt);

  const label = saving ? t("huReview.saving") : dirty ? t("huReview.save") : t("huReview.saved");
  const hint = dirty || saving || !savedAt
    ? t("huReview.saveHint")
    : `${t("huReview.savedAt").replace("{at}", new Date(savedAt).toLocaleTimeString())} · ${t("huReview.saveHint")}`;

  return (
    <button
      type="button"
      disabled={saving || !dirty}
      onClick={() => void store().saveNow()}
      title={hint}
      className={`flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11.5px] font-medium transition-colors ${
        dirty && !saving
          ? "border-[color-mix(in_oklab,var(--cf-accent)_45%,var(--cf-border))] text-[var(--cf-accent)] hover:border-[var(--cf-accent)]"
          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] disabled:cursor-default"
      }`}
    >
      {saving ? <ThinkingOrb size="sm" /> : dirty ? <Save size={12} /> : <Check size={12} />}
      {label}
    </button>
  );
}

/**
 * The note that rides next to a draft pane's bin.
 *
 * The two lists are published in opposite ways and the bin looks identical in both: the criteria
 * are one field that gets rewritten whole — seeded with the ones the work item already had, so the
 * list holds other people's criteria as well as the new ones — while tasks are created as children
 * and the list only ever holds what does not exist yet. So the same gesture deletes on the board in
 * one pane and merely cancels in the other, which is not something a bin icon can say on its own.
 *
 * One per pane, in the header, rather than one per row: what it warns about is a property of the
 * list, not of the criterion you happen to be hovering, and fifteen copies of the same triangle
 * down a column are read as decoration by the second one. Next to the bin because that is the
 * gesture it qualifies.
 */
function PaneNote({ note }: { note: string }) {
  return (
    <span
      role="img"
      title={note}
      aria-label={note}
      className="flex h-6 w-6 shrink-0 cursor-help items-center justify-center text-[var(--cf-warning)]"
    >
      <TriangleAlert size={12} />
    </span>
  );
}

/**
 * The story's own estimate, read at a glance and changed in place.
 *
 * In the header rather than in the story tab because that is where it is *missed* — "sin estimar"
 * sitting next to the title is the thing somebody notices mid-refinement, and making them leave
 * for the board and come back is how a story stays unestimated for a sprint.
 *
 * Confirmed with a tick, abandoned with a cross, and neither is decoration: this writes to a work
 * item other people are looking at, so a field that saved on blur would publish every number the
 * user typed on the way to the one they meant. Enter and Escape do the same two things, because a
 * one-field form should not need the mouse.
 */
function EffortChip({ item, editable }: { item: BoardWorkItem; editable: boolean }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const label = effortLabel(item) || t("huReview.effortUnset");

  if (draft === null) {
    return (
      <button
        type="button"
        disabled={!editable}
        onClick={() => setDraft(item.effort ? String(item.effort) : "")}
        title={editable ? t("huReview.effortEdit") : undefined}
        className="inline-flex items-center gap-1 rounded border border-transparent px-1 py-px transition-colors hover:border-[var(--cf-field-border)] hover:text-[var(--cf-text)] disabled:cursor-default disabled:hover:border-transparent disabled:hover:text-inherit"
      >
        <Gauge size={11} />
        {label}
      </button>
    );
  }

  const commit = () => {
    void store().setEffort(Number(draft) || 0);
    setDraft(null);
  };

  return (
    <span className="inline-flex items-center gap-1 rounded border border-[var(--cf-accent)] px-1 py-px">
      <Gauge size={11} className="shrink-0" />
      <input
        autoFocus
        type="number"
        min={0}
        step={0.5}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setDraft(null);
        }}
        aria-label={t("huReview.effortEdit")}
        className="w-12 border-0 bg-transparent p-0 text-right font-mono text-[11px] tabular-nums text-[var(--cf-text)] outline-none"
      />
      <button
        type="button"
        onClick={commit}
        title={t("huReview.effortConfirm")}
        aria-label={t("huReview.effortConfirm")}
        className="flex h-4 w-4 items-center justify-center rounded hover:text-[var(--cf-success)]"
      >
        <Check size={11} />
      </button>
      <button
        type="button"
        onClick={() => setDraft(null)}
        title={t("huReview.effortCancel")}
        aria-label={t("huReview.effortCancel")}
        className="flex h-4 w-4 items-center justify-center rounded hover:text-[var(--cf-danger)]"
      >
        <X size={11} />
      </button>
    </span>
  );
}

/**
 * What the board plans a task with: how long, how urgent, and what kind of work it is.
 *
 * On the draft row rather than on the proposal card, because the draft is the last thing anyone
 * looks at before the task exists — an estimate corrected on a proposal that was then sent to the
 * draft is an edit in the wrong place, and this is the one place that is always the truth.
 *
 * The kind is shown, not edited. It comes from which run produced the task, it is already written
 * into the title as `[DEV]`/`[QA]`, and it is what decides the two fields the board files the task
 * under — a dropdown here would be a third spelling of the same fact, free to disagree with the
 * other two.
 */
function PlanningRow({
  priority,
  hours,
  kind,
  readOnly,
  onPriority,
  onHours,
}: {
  priority: number;
  hours: number;
  kind: "dev" | "qa";
  readOnly: boolean;
  onPriority: (value: number) => void;
  onHours: (value: number) => void;
}) {
  const t = useT();

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--cf-border)] pt-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
      {/* Value and unit as one word. They used to be an input and a separate `<span>` with a gap
          between them, and since the input was a fixed width with its digits right-aligned, the
          `h` floated a variable distance from the number it belongs to — "2,5    h" reads as two
          things. The whole chip is the target now, and the border only appears when it is worth
          pointing at. */}
      <PlanField
        icon={Clock}
        label={t("huReview.estimate")}
        hint={t("huReview.estimateHint")}
        value={hours}
        unit={t("huReview.hoursShort")}
        step={0.5}
        readOnly={readOnly}
        onChange={(v) => onHours(Math.max(0, v))}
      />
      <PlanField
        icon={Gauge}
        label={t("stories.fieldPriority")}
        hint={t("huReview.priorityHint")}
        value={priority}
        prefix="P"
        step={1}
        readOnly={readOnly}
        onChange={(v) => onPriority(Math.min(4, Math.max(0, Math.round(v))))}
      />

      <span
        title={t("huReview.activityHint")}
        className="ml-auto shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 py-px font-mono text-[10px]"
      >
        {kind === "qa" ? "Testing · QA" : "Development · DEV"}
      </span>
    </div>
  );
}

/**
 * One planning number, as a chip that reads as a single value.
 *
 * The input is sized to its digits rather than to a column, so nothing it carries — the `P` in
 * front, the `h` behind — drifts away from the number as the value changes. `0` shows as an
 * em dash: zero is not a number anybody typed, it is the field being unset, and rendering it as
 * `0` invites publishing it as one.
 */
function PlanField({
  icon: Icon,
  label,
  hint,
  value,
  unit,
  prefix,
  step,
  readOnly,
  onChange,
}: {
  icon: typeof Clock;
  label: string;
  hint: string;
  value: number;
  unit?: string;
  prefix?: string;
  step: number;
  readOnly: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label
      title={hint}
      className="inline-flex items-center gap-1 rounded border border-transparent px-1 py-0.5 font-mono text-[11px] tabular-nums text-[var(--cf-text)] transition-colors hover:border-[var(--cf-field-border)] focus-within:border-[var(--cf-accent)]"
    >
      <Icon size={10} className="shrink-0 text-[var(--cf-text-muted)]" />
      {prefix && <span className="text-[var(--cf-text-muted)]">{prefix}</span>}
      <input
        type="number"
        min={0}
        step={step}
        readOnly={readOnly}
        value={value > 0 ? value : ""}
        placeholder="—"
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        aria-label={label}
        // `field-sizing` grows the box with its content where it is supported, and the width is the
        // floor everywhere else — either way the unit stays against the digits.
        className="w-[2.25rem] [field-sizing:content] min-w-[1.5rem] max-w-[3.5rem] border-0 bg-transparent p-0 text-right outline-none placeholder:text-[var(--cf-text-muted)]"
      />
      {unit && <span className="text-[var(--cf-text-muted)]">{unit}</span>}
    </label>
  );
}

/** The narrowest either draft column may be dragged to, and the widest. */
const DRAFT_MIN = 260;
const DRAFT_MAX = 720;

/**
 * One staged criterion: a title you can read at a glance, and the text under it when you want it.
 *
 * Collapsed by default once it has a title, because the pane's job at publish time is "are these
 * the six criteria I meant?" — six open Gherkin blocks is a wall you scroll rather than a list you
 * check. Untitled ones stay open: a collapsed row with nothing but `#3` on it says nothing, and
 * the first thing to do with such a criterion is give it a name.
 */
function DraftCriterion({
  at,
  value,
  open,
  onChange,
  onRemove,
}: {
  at: number;
  value: string;
  open: boolean;
  onChange: (value: string) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { title, body } = splitCriterion(value);
  const [expanded, setExpanded] = useState(!title.trim());

  return (
    <article
      style={riseDelay(at)}
      className={`group rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] ${CARD_MOTION}`}
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1">
        <button
          type="button"
          onClick={() => setExpanded((was) => !was)}
          aria-expanded={expanded}
          title={t(expanded ? "huReview.collapseCriterion" : "huReview.expandCriterion")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <ChevronRight size={12} className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
        </button>
        <span className="shrink-0 text-[10px] font-semibold tabular-nums text-[var(--cf-text-muted)]">
          #{at + 1}
        </span>
        {/* The title is the row when collapsed, so it is editable in place rather than behind the
            chevron — renaming six criteria should not mean opening and closing six cards. */}
        <input
          value={title}
          readOnly={!open}
          onChange={(e) => onChange(joinCriterion(e.target.value, body))}
          placeholder={t("huReview.criterionTitlePlaceholder")}
          aria-label={t("huReview.criterionTitle")}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 text-[11.5px] font-medium text-[var(--cf-text)] outline-none placeholder:font-normal placeholder:italic placeholder:text-[var(--cf-text-muted)] hover:border-[var(--cf-field-border)] focus:border-[var(--cf-accent)] read-only:hover:border-transparent"
        />
        {open && (
          <button
            type="button"
            onClick={onRemove}
            title={t("stories.removeCriterion")}
            aria-label={t("stories.removeCriterion")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {expanded && (
        <textarea
          value={body}
          readOnly={!open}
          rows={Math.max(3, body.split("\n").length)}
          onChange={(e) => onChange(joinCriterion(title, e.target.value))}
          className="cf-fade-in w-full resize-y bg-transparent px-2.5 py-2 font-mono text-[11.5px] leading-relaxed outline-none read-only:cursor-default"
        />
      )}
    </article>
  );
}

/**
 * One staged task, folded down to a line.
 *
 * Same treatment as `DraftCriterion`, and for a sharper reason: a generated task carries a
 * "¿Qué? / ¿Cómo? / ¿Para qué?" body that runs to twenty lines, so five of them made the column a
 * document to scroll rather than a list to check. Folded, the row answers the questions you ask
 * when reviewing a plan — what is it, how long, how important, and whose work it is — and the body
 * is one click away for the one you want to read.
 *
 * The numbers are shown in the header and edited in the footer rather than duplicated as inputs:
 * two live copies of the same value in one card is a race the user has to arbitrate.
 */
function DraftTaskCard({
  at,
  task,
  open,
  onChange,
  onRemove,
}: {
  at: number;
  task: DraftTask;
  open: boolean;
  onChange: (patch: Partial<DraftTask>) => void;
  onRemove: () => void;
}) {
  const t = useT();
  // A task with no title yet is one the user just added and is about to fill in — it opens on its
  // own rather than making them find the chevron first. Same rule as a blank criterion.
  const [expanded, setExpanded] = useState(!task.title.trim());

  return (
    <article
      style={riseDelay(at)}
      className={`group rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] ${CARD_MOTION}`}
    >
      <div className="flex items-center gap-1.5 border-b border-[var(--cf-border)] px-2.5 py-1">
        <button
          type="button"
          onClick={() => setExpanded((was) => !was)}
          aria-expanded={expanded}
          title={t(expanded ? "huReview.collapseTask" : "huReview.expandTask")}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          <ChevronRight size={12} className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`} />
        </button>
        <KindChip kind={task.kind} />
        {/* Editable in place, like the criterion's: renaming five tasks should not mean opening
            and closing five cards. */}
        <input
          value={task.title}
          readOnly={!open}
          onChange={(e) => onChange({ title: e.target.value })}
          placeholder={t("huReview.taskTitlePlaceholder")}
          aria-label={t("stories.fieldTitle")}
          className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-0.5 font-mono text-[11.5px] font-medium text-[var(--cf-text)] outline-none placeholder:font-sans placeholder:font-normal placeholder:italic placeholder:text-[var(--cf-text-muted)] hover:border-[var(--cf-field-border)] focus:border-[var(--cf-accent)] read-only:hover:border-transparent"
        />
        {/* Read-only here on purpose — see the note on the component. Unset values say nothing
            rather than showing a zero, which is the same rule `PlanField` follows. */}
        <span className="flex shrink-0 items-center gap-1.5 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          {task.estimateHours > 0 && (
            <span title={t("huReview.estimate")}>
              {task.estimateHours}
              {t("huReview.hoursShort")}
            </span>
          )}
          {task.priority > 0 && <span title={t("stories.fieldPriority")}>P{task.priority}</span>}
          <span
            title={t("huReview.activityHint")}
            className="rounded-full border border-[var(--cf-border)] px-1.5 py-px font-mono"
          >
            {task.kind === "qa" ? "QA" : "DEV"}
          </span>
        </span>
        {open && (
          <button
            type="button"
            onClick={onRemove}
            title={t("huReview.unstage")}
            aria-label={t("huReview.unstage")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus:opacity-100 group-hover:opacity-100"
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
      {expanded && (
        <div className="cf-fade-in px-2.5 pb-2 pt-1">
          <textarea
            value={task.detail}
            readOnly={!open}
            rows={Math.max(3, task.detail.split("\n").length)}
            onChange={(e) => onChange({ detail: e.target.value })}
            className="w-full resize-y bg-transparent text-[11px] leading-snug text-[var(--cf-text-muted)] outline-none read-only:cursor-default"
          />
          <PlanningRow
            priority={task.priority}
            hours={task.estimateHours}
            kind={task.kind}
            readOnly={!open}
            onPriority={(priority) => onChange({ priority })}
            onHours={(estimateHours) => onChange({ estimateHours })}
          />
        </div>
      )}
    </article>
  );
}

/**
 * "Add a task", asked as one question instead of two.
 *
 * The kind decides the Azure activity and the shape of the body, and for QA the body has two
 * conventions — a numbered list of cases, or Gherkin scenarios — so a strict reading would be
 * "dev or qa?" followed by "list or gherkin?". Three items in one menu answers both in a single
 * click, and nobody has to back out of the first question to change their mind about it.
 *
 * Every choice lands a filled-in skeleton rather than a blank card. A blank task is a card that
 * says nothing about what belongs in it; a template is the same prompt the generated ones follow,
 * so a hand-written task and a proposed one read alike on the board.
 */
function AddTaskButton() {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const add = (kind: "dev" | "qa", flavour: "plain" | "gherkin") => {
    setMenu(null);
    store().addDraftTask(kind, flavour);
  };

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({ x: box.left, y: box.bottom + 4 });
        }}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--cf-border)] py-1.5 text-[11.5px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        <Plus size={12} />
        {t("huReview.addTask")}
      </button>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t("huReview.addTaskDev"), icon: Wrench, onClick: () => add("dev", "plain") },
            { label: t("huReview.addTaskQaList"), icon: FlaskConical, onClick: () => add("qa", "plain") },
            { label: t("huReview.addTaskQaGherkin"), icon: FlaskConical, onClick: () => add("qa", "gherkin") },
          ]}
        />
      )}
    </>
  );
}

/* Widths through CSS variables rather than through the class string, because Tailwind compiles
   the classes it can see in the source — a `lg:w-[${n}px]` built at runtime names a class that
   was never generated, and the pane silently keeps whatever width it had. The variables are set
   as an inline style on the row that holds the panes; see `--cf-hu-source-w` beside them. */
const DRAFT_DESC_WIDTH = "w-full shrink-0 lg:w-[var(--cf-hu-draft-desc-w)]";
const DRAFT_CRIT_WIDTH = "w-full shrink-0 lg:w-[var(--cf-hu-draft-crit-w)]";

function DraftTab() {
  const t = useT();
  const item = useWorkItemReviewStore((s) => s.item);
  const draft = useWorkItemReviewStore((s) => s.draft);
  const open = useWorkItemReviewStore((s) => s.status === "open");
  const descWidth = useLayoutStore((s) => s.sizes.huReviewDraftDescWidth);
  const criteriaWidth = useLayoutStore((s) => s.sizes.huReviewDraftCriteriaWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  if (!item) return null;

  const isBug = kindOf(item.work_item_type) === "bug";
  const criteria = draft.criteria ?? [];
  const tasks = draft.tasks ?? [];

  /* Two seams for three panes: the first two carry a width and the tasks pane takes what is left.
     Storing a third number would mean three that have to keep adding up to the window, and a
     window resize would have to decide which of them gives. Hidden below `lg`, where the panes
     stack and there is no horizontal seam to drag. */
  const seam = (key: "huReviewDraftDescWidth" | "huReviewDraftCriteriaWidth", value: number) => (
    <span className="contents max-lg:hidden">
      <ResizeHandle
        axis="x"
        value={value}
        min={DRAFT_MIN}
        max={DRAFT_MAX}
        onChange={(next) => setSize(key, next)}
        onCommit={(next) => commitSize(key, next)}
      />
    </span>
  );

  return (
    <>
      <DraftPane
        icon={FileText}
        label={isBug ? t("huReview.fieldRepro") : t("stories.fieldDescription")}
        part="description"
        count={draft.description === null ? 0 : 1}
        width={DRAFT_DESC_WIDTH}
        confirm={t("huReview.confirmDescription")}
      >
        <div className="h-full min-h-0">
          <MarkdownEditor
            value={draft.description ?? ""}
            readOnly={!open}
            onChange={(value) => store().setDraftDescription(value)}
            placeholder={t("huReview.noDescription")}
            ariaLabel={t("stories.fieldDescription")}
            historyKey={`${item.id}:draft`}
          />
        </div>
      </DraftPane>

      {seam("huReviewDraftDescWidth", descWidth)}

      <DraftPane
        icon={ListChecks}
        label={t("stories.fieldCriteria")}
        part="criteria"
        count={criteria.length}
        width={DRAFT_CRIT_WIDTH}
        note={t("huReview.binNoteCriteria")}
        confirm={t("huReview.confirmCriteria").replace("{n}", String(criteria.filter((c) => c.trim()).length))}
      >
        <div className="space-y-1.5">
          {criteria.map((criterion, at) => (
            <DraftCriterion
              key={at}
              at={at}
              value={criterion}
              open={open}
              onChange={(next) => store().setDraftCriterion(at, next)}
              onRemove={() => store().removeDraftCriterion(at)}
            />
          ))}
          {open && (
            <button
              type="button"
              onClick={() => store().addDraftCriterion()}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-[var(--cf-border)] py-1.5 text-[11.5px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
            >
              <Plus size={12} />
              {t("stories.addCriterion")}
            </button>
          )}
        </div>
      </DraftPane>

      {seam("huReviewDraftCriteriaWidth", criteriaWidth)}

      <DraftPane
        icon={ClipboardCheck}
        label={t("huReview.stepTasks")}
        part="tasks"
        count={tasks.length}
        note={t("huReview.binNoteTasks")}
        confirm={t("huReview.confirmTasks").replace("{n}", String(tasks.length))}
      >
        <div className="space-y-1.5">
          {tasks.map((task, at) => (
            <DraftTaskCard
              key={at}
              at={at}
              task={task}
              open={open}
              onChange={(patch) => store().setDraftTask(at, patch)}
              onRemove={() => store().removeDraftTask(at)}
            />
          ))}
          {open && <AddTaskButton />}
        </div>
      </DraftPane>
    </>
  );
}

// ---------- the tab strip ----------

const TAB_ICON: Record<ReviewTab, typeof ScanSearch> = {
  story: FileText,
  description: FileText,
  criteria: ListChecks,
  tasks: ClipboardCheck,
  draft: UploadCloud,
};

function TabBar() {
  const t = useT();
  const tab = useWorkItemReviewStore((s) => s.tab);
  const draft = useWorkItemReviewStore((s) => s.draft);
  const published = useWorkItemReviewStore((s) => s.published);
  const criteria = useWorkItemReviewStore((s) => s.criteria);
  const item = useWorkItemReviewStore((s) => s.item);
  const proposedDescription = useWorkItemReviewStore((s) => s.proposedDescription);
  const proposedCriteria = useWorkItemReviewStore((s) => s.proposedCriteria);
  const proposedTasks = useWorkItemReviewStore((s) => s.proposedTasks);
  const running = useWorkItemReviewStore(stagesRunning);

  const draftEmpty = draftIsEmpty(draft);
  // What each tab is holding, so the strip carries the counts and nobody has to open a tab to find
  // out whether there is anything in it.
  const counts: Record<ReviewTab, number> = {
    story: criteria.length + (item?.children.length ?? 0),
    description: proposedDescription ? 1 : 0,
    criteria: proposedCriteria.length,
    tasks: proposedTasks.length,
    draft:
      (draft.description === null ? 0 : 1) + (draft.criteria?.length ?? 0) + (draft.tasks?.length ?? 0),
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
      {REVIEW_TABS.map((at, index) => {
        const Icon = TAB_ICON[at];
        const active = tab === at;
        // The draft is not a place you can go before anything was sent there: an empty tab with a
        // dead Publish button reads as broken rather than as not-yet. Except when you are already
        // standing in it — discarding the last part empties the draft, and greying out the tab the
        // user is looking at would strand them on a tab the strip says does not exist.
        const disabled = at === "draft" && draftEmpty && tab !== "draft";
        const stage = STAGE_OF_TAB[at];
        const busy = Boolean(
          (stage && running[stage]) || (at === "tasks" && (running.tasks || running.tasksqa)),
        );
        const done = at === "draft" && Object.keys(published).length > 0;
        return (
          <div key={at} className="flex shrink-0 items-center gap-0.5">
            {index > 0 && <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />}
            <button
              type="button"
              disabled={disabled}
              onClick={() => store().setTab(at)}
              aria-current={active ? "page" : undefined}
              className={`relative flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                active
                  ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.04]"
              }`}
            >
              <span className={`tabular-nums text-[11px] ${active ? "opacity-70" : "opacity-50"}`}>{index + 1}</span>
              {busy ? (
                <ThinkingOrb size="sm" />
              ) : done ? (
                <Check size={13} className="text-[var(--cf-success)]" />
              ) : (
                <Icon size={13} />
              )}
              {t(`huReview.tab_${at}` as "huReview.tab_story")}
              {counts[at] > 0 && (
                <span
                  className={`rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${
                    active ? "bg-[var(--cf-accent)] text-white" : "bg-[var(--cf-border)] text-[var(--cf-text-muted)]"
                  }`}
                >
                  {counts[at]}
                </span>
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------- the history ----------

/** What a saved session says about how it ended, at a glance. */
function StatusChip({ status }: { status: string }) {
  const t = useT();
  if (status === "published") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--cf-success)_45%,transparent)] bg-[color-mix(in_oklab,var(--cf-success)_10%,transparent)] px-1.5 py-px text-[10px] font-medium text-[var(--cf-success)]">
        <UploadCloud size={9} />
        {t("huReview.statusPublished")}
      </span>
    );
  }
  if (status === "closed") {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[var(--cf-border)] px-1.5 py-px text-[10px] font-medium text-[var(--cf-text-muted)]">
        <Lock size={9} />
        {t("huReview.statusClosed")}
      </span>
    );
  }
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-[color-mix(in_oklab,var(--cf-accent)_45%,transparent)] px-1.5 py-px text-[10px] font-medium text-[var(--cf-accent)]">
      {t("huReview.statusOpen")}
    </span>
  );
}

/** The status a saved row ended in, read out of its payload without trusting its shape. */
function statusOf(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    const status = (parsed as { status?: unknown })?.status;
    return typeof status === "string" ? status : "open";
  } catch {
    return "open";
  }
}

/**
 * What the board calls the reviewed item, when the saved session recorded it.
 *
 * Read out of the payload rather than off the row: the history table stores a numeric id, which is
 * the whole address on Azure and a number nobody recognises on Jira. Empty for an Azure row and for
 * any row written before sessions carried a key, and the caller falls back to `#id` for both.
 */
function keyOf(payload: string): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    const key = (parsed as { item?: { key?: unknown } })?.item?.key;
    return typeof key === "string" ? key : "";
  } catch {
    return "";
  }
}

/**
 * Every review this workspace has saved.
 *
 * A dialog rather than the dropdown it used to be. The list is the workspace's record of what has
 * been refined and how it ended — a popover 26rem wide that closes when the pointer strays is a
 * place you glance at, not one you read, and half of what is worth knowing (status, when, which
 * model) did not fit in it.
 */
function HistoryModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const history = useWorkItemReviewStore((s) => s.history);
  const openId = useWorkItemReviewStore((s) => s.sessionId);
  // Subscribed once for the whole list rather than per row: a row is a `<div>` inside a `.map`, not
  // a component, so a hook per row isn't available — and this map changes rarely enough that one
  // subscription re-rendering the modal costs nothing.
  const runs = useWorkItemReviewStore((s) => s.runsBySession);

  return (
    <ApiModal
      icon={History}
      title={t("huReview.history")}
      subtitle={t("huReview.historyHint")}
      width="max-w-2xl"
      height="h-[70vh]"
      onClose={onClose}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {history.length === 0 ? (
          <p className="px-2 py-8 text-center text-[12px] text-[var(--cf-text-muted)]">{t("huReview.historyEmpty")}</p>
        ) : (
          <div className="space-y-1">
            {history.map((row, at) => (
              <div
                key={row.id}
                style={riseDelay(at)}
                className={`cf-rise group flex items-center gap-1 rounded-lg border ${
                  row.id === openId
                    ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                    : "border-[var(--cf-border)] hover:border-[color-mix(in_oklab,var(--cf-accent)_40%,var(--cf-border))]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => {
                    store().openFromHistory(row);
                    onClose();
                  }}
                  className="min-w-0 flex-1 px-2.5 py-2 text-left"
                >
                  <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--cf-text)]">
                    <span className="shrink-0 font-mono text-[10.5px] text-[var(--cf-text-muted)]">
                      {/* The board's own label when the saved session carries one — a Jira row's
                          numeric id is real but nobody recognises it. */}
                      {keyOf(row.payload) || `#${row.work_item_id}`}
                    </span>
                    <span className="min-w-0 truncate font-medium">{row.title}</span>
                    {/* Live beats persisted, the same way a running batch outranks its saved state
                        in `StoryBatchList`. A session set aside mid-generation is still a draft on
                        disk — but "still working" is the more useful thing to say about it, and the
                        status comes back on its own the moment the run lands. */}
                    {isSessionRunning(runs, row.id) ? (
                      <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-[var(--cf-accent)]">
                        <ThinkingOrb size="sm" />
                        {t("huReview.statusWorking")}
                      </span>
                    ) : (
                      <StatusChip status={statusOf(row.payload)} />
                    )}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                    <span>{new Date(row.updated_at).toLocaleString()}</span>
                    {row.work_item_type && (
                      <>
                        <span aria-hidden>·</span>
                        <span>{row.work_item_type}</span>
                      </>
                    )}
                    {row.model && (
                      <>
                        <span aria-hidden>·</span>
                        <span className="min-w-0 truncate font-mono">{row.model}</span>
                      </>
                    )}
                  </p>
                </button>
                {/* Always visible while it runs, unlike the delete button that appears on hover:
                    this is the only way to call off a generation whose screen the user has already
                    left, and a control you have to go looking for is not one you find in a hurry. */}
                {isSessionRunning(runs, row.id) && (
                  <button
                    type="button"
                    onClick={() => void store().stopSession(row.id)}
                    title={t("huReview.stopRun")}
                    aria-label={t("huReview.stopRun")}
                    className={`shrink-0 ${ICON_ACTION} hover:text-[var(--cf-danger)]`}
                  >
                    <Square size={11} className="fill-current" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void confirmAction(t("huReview.historyDeleteConfirm")).then((ok) => {
                      if (ok) void store().removeFromHistory(row.id);
                    });
                  }}
                  title={t("huReview.historyDelete")}
                  aria-label={t("huReview.historyDelete")}
                  className={`mr-1.5 shrink-0 ${ICON_ACTION} opacity-0 transition-opacity hover:text-[var(--cf-danger)] focus:opacity-100 group-hover:opacity-100`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </ApiModal>
  );
}

// ---------- the run settings ----------

/**
 * What the review is read against — none, some, or all of the workspace's repositories.
 *
 * Zero is a first-class answer and is labelled as one. A workspace is a project, and a story is
 * routinely written before the code that satisfies it; the picker that *required* a repository made
 * the screen unusable at exactly the moment refinement happens.
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
          <div className="cf-fade-in absolute right-0 top-full z-20 mt-1 max-h-72 w-72 overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]">
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

// ---------- the screen ----------

/**
 * Reviewing a work item that is already written on the board.
 *
 * The opposite direction to the rest of this workspace: instead of deriving a backlog from
 * documentation, it takes one item that exists and asks what it is missing.
 *
 * Five tabs, each owning its own subject. The story as it stands is a record. The description, the
 * criteria and the tasks each hold the current value on the left and what a model proposes on the
 * right, and each runs on its own — a session that only rewrites the description never asks for
 * the other two. The draft is where decisions collect, and the only place anything leaves for
 * Azure DevOps.
 *
 * A session ends in one of two ways, and both are recorded: closed, or published. Either way it
 * goes read-only and stays in the history with everything it held, which is what makes "what did
 * we decide about #4821 last sprint" a question with an answer.
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
  const status = useWorkItemReviewStore((s) => s.status);
  const running = useWorkItemReviewStore(stagesRunning);
  const openedFrom = useWorkItemReviewStore((s) => s.openedFrom);
  const publishing = useWorkItemReviewStore((s) => s.publishing);
  const draft = useWorkItemReviewStore((s) => s.draft);
  const tab = useWorkItemReviewStore((s) => s.tab);
  const sourceWidth = useLayoutStore((s) => s.sizes.huReviewSourceWidth);
  // Read here as well as in `DraftTab`: the panes are its children but the custom properties have
  // to be declared on the row that lays them out, which is this one.
  const draftDescWidth = useLayoutStore((s) => s.sizes.huReviewDraftDescWidth);
  const draftCriteriaWidth = useLayoutStore((s) => s.sizes.huReviewDraftCriteriaWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);

  const [orgs, setOrgs] = useState<string[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyCount = useWorkItemReviewStore((s) => s.history.length);
  // Guards the auto-pick: the organisation must be chosen for the user only while they have not
  // chosen one, and only once — a second pass would overwrite what they picked.
  const seeded = useRef(false);
  useEffect(() => {
    void store().loadHistory();
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
  const open = status === "open";
  const draftReady = !draftIsEmpty(draft);

  const closeReview = () => {
    void confirmAction(t("huReview.closeReviewConfirm")).then((ok) => {
      if (ok) void store().close();
    });
  };

  const publishEverything = () => {
    void confirmAction(t("huReview.publishAllConfirm")).then((ok) => {
      if (ok) void store().publishAll();
    });
  };

  // The draggable seam of the two-pane tabs. Handed to each of them rather than drawn here,
  // because it belongs *between* their two panes and the tab is what renders those. Hidden below
  // `lg`, where the panes stack and there is no horizontal seam to drag.
  const seam = (
    <span className="contents max-lg:hidden">
      <ResizeHandle
        axis="x"
        value={sourceWidth}
        min={SOURCE_MIN}
        max={SOURCE_MAX}
        onChange={(value) => setSize("huReviewSourceWidth", value)}
        onCommit={(value) => commitSize("huReviewSourceWidth", value)}
      />
    </span>
  );

  return (
    // `flex-1`, not `h-full`: this is one child of the stories view's column, under the tab strip.
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
          <ScanSearch
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
          // Armed only by something to look up. With the box cleared on a successful load, this is
          // also what stops a second press re-fetching the item already on screen.
          disabled={loading || !input.trim()}
          title={t("huReview.loadHint")}
          onClick={() => void store().load()}
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1.5 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? t("huReview.loading") : t("huReview.load")}
        </button>
        {/* Pushed to the far edge, away from the lookup it is not part of: the organisation, the
            box and Load are one action read left to right, and the history is a different one —
            somewhere to go rather than something to fill in. `ml-auto` rather than a spacer so it
            still sits beside Load once the row wraps on a narrow window. */}
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          title={t("huReview.historyHint")}
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          <History size={12} className="shrink-0" />
          {t("huReview.history")}
          {historyCount > 0 && (
            <span className="shrink-0 rounded-full bg-[var(--cf-accent-soft)] px-1.5 text-[10px] font-semibold tabular-nums text-[var(--cf-accent)]">
              {historyCount}
            </span>
          )}
        </button>
      </div>

      {openedFrom && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-accent)]">
          <History size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words" title={t("huReview.snapshotHint")}>
            {t("huReview.snapshot").replace("{at}", new Date(openedFrom.at).toLocaleString())}
          </span>
        </p>
      )}

      {item && !open && (
        <p className="flex shrink-0 items-start gap-1.5 border-b border-[var(--cf-border)] bg-black/[0.03] px-3 py-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)] dark:bg-white/[0.04]">
          <Lock size={11} className="mt-[2px] shrink-0" />
          <span className="min-w-0 break-words">
            {status === "published" ? t("huReview.closedPublishedHint") : t("huReview.closedHint")}
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
          {/* 2 — what is loaded. */}
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
              <h2 className="break-words px-1 text-[15px] font-semibold leading-tight text-[var(--cf-text)]">
                {title}
              </h2>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 px-1 text-[11px] text-[var(--cf-text-muted)]">
                {/* The id is what gets pasted into a branch name, a commit message or a chat —
                    often enough that reading it off the screen and retyping it was the friction.
                    A button rather than selectable text: the `#` is decoration, not part of the
                    identifier, and a double-click selection takes it along. */}
                <button
                  type="button"
                  onClick={() => copy(String(item.id), t("huReview.copied"))}
                  title={t("huReview.copyId")}
                  aria-label={t("huReview.copyId")}
                  className="group/id inline-flex items-center gap-1 rounded font-mono transition-colors hover:text-[var(--cf-accent)]"
                >
                  #{item.id}
                  <Copy size={9} className="opacity-0 transition-opacity group-hover/id:opacity-100" />
                </button>
                <span>{item.work_item_type}</span>
                {/* Only when the item actually carries one. A session reopened from an old history
                    row has no state to show, and an empty capsule is a chip that says nothing while
                    looking like it says something. */}
                {item.state.trim() && (
                  <span className={`rounded-full border px-1.5 py-px text-[10px] font-medium ${stateTone(item.state)}`}>
                    {item.state}
                  </span>
                )}
                <span aria-hidden>·</span>
                <EffortChip item={item} editable={open} />
                {item.team_project && (
                  <>
                    <span aria-hidden>·</span>
                    <span className="min-w-0 truncate">{item.team_project}</span>
                  </>
                )}
                {!open && <StatusChip status={status} />}
              </div>
            </div>
            {/* What the runs read against, on the item's own row rather than on a band of its own:
                these are settings for the runs, not a step. */}
            <div className="mt-[2px] flex shrink-0 flex-wrap items-center justify-end gap-1.5">
              {open && <RepoPicker />}
              {open && <ContextToggle />}
              {open && <SaveState />}
              <button
                type="button"
                onClick={() => void openExternalUrl(item.url).catch((e: unknown) => pushErrorToast(String(e)))}
                title={t("huReview.openInAzureHint")}
                aria-label={t("huReview.openInAzure")}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <ExternalLink size={13} />
              </button>
              {/* Ends the session without publishing. Not a discard: everything it holds stays in
                  the history, which is the whole point — "we looked at this and decided to leave
                  it" is a result worth being able to read back. The padlock rather than a cross,
                  because that is what it does — the cross beside it is the one that only clears the
                  screen, and two crosses meaning different things is how a session gets ended by
                  somebody who meant to put it down. */}
              {open && (
                <button
                  type="button"
                  onClick={closeReview}
                  title={t("huReview.closeReviewHint")}
                  className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 text-[11.5px] font-medium text-[var(--cf-text)] transition-colors hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
                >
                  <Lock size={12} />
                  {t("huReview.closeReview")}
                </button>
              )}
              {/* Off the screen, not out of the record: the session keeps its status and everything
                  staged in it, and the history is where it is picked back up. No confirmation —
                  there is nothing to lose, which is exactly what separates it from the padlock. */}
              <button
                type="button"
                onClick={() => void store().dismiss()}
                title={t("huReview.setAsideHint")}
                aria-label={t("huReview.setAside")}
                className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <X size={13} />
              </button>
            </div>
          </div>

          {/* 3 — the tabs, and whatever belongs to the one on screen. */}
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1.5">
            <TabBar />
            {/* No stop button here on purpose. A run is stopped from the pane that started it, where
                the button sits next to the text it is producing — one that stopped every stage at
                once, from a strip that says nothing about which are running, could only be read as
                "stop something". */}
            {/* Publishes everything staged and ends the session, which is why it lives on the tab
                strip rather than inside one of the three draft panes: it is about the review, not
                about any one part of it. */}
            {!anyRunning && tab === "draft" && open && (
              <button
                type="button"
                disabled={!draftReady || Boolean(publishing)}
                onClick={publishEverything}
                title={t("huReview.publishAllHint")}
                className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-2.5 py-1 text-[11.5px] font-medium text-white transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {publishing ? <ThinkingOrb size="sm" /> : <UploadCloud size={11} />}
                {t("huReview.publishAll")}
              </button>
            )}
          </div>

          {/* 4 — the panes. Keyed on the tab so nothing local (an open card, an editor) survives a
              switch into a pane it does not belong to. */}
          <div
            // `lg:divide-x` only where there is no handle: the two-pane tabs draw their seam with
            // the drag handle, and a divider plus a handle is two lines where the layout has one
            // edge. Below `lg` everything stacks and `divide-y` draws the horizontal seams.
            className={`cf-fade-in flex min-h-0 flex-1 flex-col divide-y divide-[var(--cf-border)] overflow-hidden lg:flex-row lg:divide-y-0 ${
              tab === "draft" ? "lg:divide-x" : ""
            }`}
            style={
              {
                "--cf-hu-source-w": `${sourceWidth}px`,
                "--cf-hu-draft-desc-w": `${draftDescWidth}px`,
                "--cf-hu-draft-crit-w": `${draftCriteriaWidth}px`,
              } as React.CSSProperties
            }
          >
            {tab === "story" && <StoryTab key="story" />}
            {tab === "description" && <DescriptionTab key="description" width={SOURCE_WIDTH} seam={seam} />}
            {tab === "criteria" && <CriteriaTab key="criteria" width={SOURCE_WIDTH} seam={seam} />}
            {tab === "tasks" && <TasksTab key="tasks" width={SOURCE_WIDTH} seam={seam} />}
            {tab === "draft" && <DraftTab key="draft" />}
          </div>
        </>
      )}

      {historyOpen && <HistoryModal onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}
