import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, FileText, GitBranch, ImageIcon, Pencil, Puzzle, RefreshCw, Square, type LucideIcon } from "lucide-react";
import { splitAttachmentNote } from "../../lib/attachmentNote";
import { renderMarkdown } from "../../lib/markdown";
import { parseClaudeError } from "../../lib/claudeError";
import { modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { useT } from "../../state/languageStore";
import type { AiRunLine } from "../../state/aiRunStore";
import { AiErrorBanner } from "../ai/AiErrorBanner";
import { AiRunLog, RunFileChips } from "../ai/AiRunLog";
import { AiSparkles } from "../common/AiGlyph";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { thinkingFinishMs } from "../../lib/thinkingDesigns";
import { useThinkingDesignStore } from "../../state/thinkingDesignStore";
import { LazyTrace } from "./LazyTrace";
import { CostChip, formatResponseTime, parseStamp, useCopy, useLocale } from "./chatChrome";
import { fenceLabelOf, highlightCodeBlocks, languageOf } from "../../lib/codeHighlight";
import { bodyForBlock, fileNameForBlock } from "../../lib/codeFileName";
import { OutputBar } from "./OutputBar";
import type { ChatOutput } from "../../lib/tauri/chatCommands";
import { writeFileBytes } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { findTheme } from "../../lib/codeThemes";
import { useThemeStore } from "../../state/themeStore";

/**
 * What a bubble needs to know about a turn.
 *
 * Structural rather than an import of `chatStore.ChatMessage`, and that is the point of the lift:
 * three transcripts render the same turn today — the AI panel's repo chat, the agent console's task
 * thread and the chat workspace — and they are fed by three different stores holding three
 * different row shapes. Naming the *fields* instead of one store's interface lets all three pass
 * what they already have without a conversion layer, and keeps this component from depending on any
 * of them. `chatStore.ChatMessage` is structurally assignable to it, which is why the two existing
 * call sites needed no change beyond the import.
 */
export interface ChatBubbleMessage {
  role: "user" | "assistant";
  content: string;
  /** Response time in milliseconds — assistant turns only, and only under `stamp="full"`. */
  responseTimeMs?: number;
  /** When this turn happened, RFC 3339. */
  createdAt?: string;
  /** Which engine produced this answer — pinned per message rather than read from the current
   *  setting, so a conversation that switched models mid-way still says what each turn ran on. */
  provider?: string;
  model?: string;
  engineVersion?: string;
  /** What the engine printed while producing this answer. */
  trace?: AiRunLine[];
  /** The model's reasoning behind this answer, when the engine streamed it. Folded with the trace
   *  into the turn's "Thought for …" line, never shown as part of the answer. */
  thinking?: string;
  /** A reopened turn whose trace was not read with the transcript: its disclosure fetches it by this
   *  id when opened. Ignored when `trace` is already here. */
  traceId?: string;
  /** This turn failed; `content` is the raw engine error, still carrying the quota marker so the
   *  banner can re-derive the billing link when a past conversation is reopened. */
  isError?: boolean;
  isCancelled?: boolean;
  /** On a question: the skill it was sent with, picked in the composer. Told to the engine, never
   *  part of `content` — this is the one place the transcript says it was used. */
  skill?: string;
  /** On a question: the files sent with it, while the turn is live. A stored question names them in
   *  a note at the end of its text instead, which the bubble reads back (`lib/attachmentNote`). */
  attachments?: { name: string; path: string; isImage: boolean }[];
}

/** The turn-level actions the chat workspace hangs off a bubble. All three are "fresh session,
 *  replay the prefix" underneath, which is why each arrives with the number of turns it will
 *  re-send rather than as a bare callback — see `CostChip`. */
export interface ChatBubbleActions {
  onRegenerate?: () => void;
  onEdit?: () => void;
  onBranch?: () => void;
  /** How many turns a regenerate/branch/edit from here would replay. */
  replayTurns?: number;
  /** Switch the conversation to a model the CLI itself named when it rejected the configured one.
   *  Lives here rather than on the error banner because the banner is shared with two screens that
   *  have no conversation to re-point — see `AiErrorBanner`, which renders the ids as plain text
   *  when nothing can apply them. */
  onPickModel?: (model: string) => void;
}

/**
 * How wide and how loud the bubble is.
 *
 * `panel` is the 12px, 85%-width bubble the AI panel and the agent console have always drawn, kept
 * byte-for-byte so this lift is a refactor and not a redesign of two shipped screens.
 *
 * `reading` is the chat workspace's: larger type, far more line height, and — the real difference —
 * **the assistant's turn has no bubble at all**. A reply that fills the column is a document, and
 * wrapping a document in a tinted rounded rectangle is what makes a chat feel like a support widget
 * instead of a page. Only the user's own turns keep a container, because those are the ones the eye
 * needs to find when scrolling back, and they are short.
 */
export type ChatBubbleVariant = "panel" | "reading";

/** How much the stamp under a turn says. `full` is the AI panel's (duration, engine, model, CLI
 *  version, time); `compact` is the agent console's (engine, model, time) — the difference is
 *  preserved deliberately, because the agent console shows the same facts in its own header and a
 *  second copy under every turn was noise there. */
export type ChatStampDetail = "full" | "compact";

/**
 * One turn in a transcript.
 *
 * Memoised on its props, which is enough because **no store here mutates a message**: a turn is
 * appended whole and its object is never touched again. So an unchanged identity really does mean
 * unchanged content, and the bubble whose content did change still re-renders on the very same
 * commit. Without this, every keystroke in the composer below re-rendered the whole transcript,
 * markdown subtrees and all.
 *
 * **A streaming turn must therefore replace the message object on every chunk, never mutate
 * `content` in place** — a mutating streamer looks frozen on screen and the bug is invisible in
 * review, because the data is correct and only the render is stale. `conversationStore` owes this
 * component that guarantee; `streamText` is the escape hatch that lets it stream without paying a
 * new message object per token, since a string prop compares by value.
 */
export const ChatMessageBubble = memo(function ChatMessageBubble({
  message,
  variant = "panel",
  stamp = "full",
  streamText,
  actions,
  outputs,
  emptyText,
}: {
  message: ChatBubbleMessage;
  variant?: ChatBubbleVariant;
  stamp?: ChatStampDetail;
  /** Text arriving token by token for a turn that has not landed yet. Rendered *instead of*
   *  `message.content`, and deliberately as plain text rather than markdown: half a fenced code
   *  block is not valid markdown, and re-parsing it sixty times a second produces a paragraph that
   *  flickers between prose and a code block as the fence opens. The finished turn re-renders as
   *  markdown once, when it is whole. */
  streamText?: string;
  actions?: ChatBubbleActions;
  /**
   * Files this turn wrote, and the conversation to save them out of.
   *
   * One object rather than two props because it is all-or-nothing — there is nothing to do with
   * either half alone — and because the caller has to memoise it anyway: this component compares
   * its props by reference, so a fresh object per render would re-render every bubble in the
   * transcript on every token of the one in flight.
   *
   * Absent everywhere but the chat workspace. The AI panel's repo chat and the agent console show
   * the same turns and have no working directory behind them.
   */
  outputs?: { conversationId: string; files: ChatOutput[] };
  /** What an answer with no text says instead of the generic "done" — the caller knows which
   *  command it answered (`/compact`), this bubble does not. */
  emptyText?: string;
}) {
  const t = useT();
  const [copied, copy] = useCopy();
  const reading = variant === "reading";

  // The recorded process behind this answer — "Thought for 15 s · 5 steps", over the answer and
  // beside the avatar, the way the run card it was a moment ago sat there. Drawn for every kind of
  // assistant turn, the failed and the stopped ones included, where "what was it doing when it
  // died?" is the whole question.
  const trace = message.trace;
  const thinking = message.role === "assistant" ? message.thinking : undefined;
  const traceLog =
    (trace && trace.length > 0) || thinking?.trim() ? (
      <AiRunLog
        lines={trace ?? []}
        running={false}
        durationMs={message.responseTimeMs}
        thinking={thinking}
        density={variant}
      />
    ) : message.traceId ? (
      // Reopened: the trace stayed on disk, and is read the first time somebody opens it.
      <LazyTrace traceId={message.traceId} durationMs={message.responseTimeMs} density={variant} />
    ) : null;

  const streaming = streamText !== undefined;
  // A question's files: carried by a live turn, read back out of the note a stored one ends with —
  // shown as chips over the words rather than as a paragraph of absolute paths under them.
  const noted = useMemo(
    () => (message.role === "user" ? splitAttachmentNote(message.content) : null),
    [message.role, message.content],
  );
  const sentFiles = message.role === "user" ? (message.attachments ?? noted?.files ?? []) : [];
  const copyText = noted?.text ?? message.content;
  const body = streaming ? streamText : copyText;

  // An answer with no text at all is what a CLI command replies with when it just *does* something —
  // Claude's `/clear` and `/compact` answer with an empty result. Said as done rather than drawn as a
  // blank bubble.
  const emptyReply =
    message.role === "assistant" && !message.isError && !message.isCancelled && !streaming && !body.trim();
  const html = useMemo(
    () =>
      message.role === "assistant" && !message.isError && !streaming
        ? renderMarkdown(emptyReply ? `*${emptyText ?? t("chat.emptyReply")}*` : body)
        : null,
    [message.role, message.isError, streaming, body, emptyReply, emptyText, t],
  );
  /**
   * What `dangerouslySetInnerHTML` is handed — one object for as long as the HTML is the same.
   *
   * **React 19 rewrites `innerHTML` whenever this is a different object**, whatever `__html` holds.
   * It diffs host props by identity and sends a changed one straight to `setProp`, which assigns
   * `innerHTML`; React 18 compared the two strings, React 19 does not. The inline
   * `{{ __html: html }}` this used to be is a new object on every render, so every re-render of the
   * bubble put the sanitised HTML back — and with it threw away everything `useCodeBlockActions`
   * draws on top after the fact: the colours and the bar of every code block. And a bubble
   * re-renders a lot without its text changing. Sending a question flips `actions` on every earlier
   * turn (nothing can be regenerated while a turn runs), and flips it back when the answer lands;
   * the transcript is re-read from disk when a turn ends, which hands every turn a new message
   * object; the copy button's "copied" and the trace disclosure are state of the bubble itself. The
   * effects that draw were keyed on the HTML string, which had not changed, so nothing drew them
   * again — the whole transcript went grey the moment a question was sent, the new answer lost its
   * colours and bars a moment after landing, and only a remount (another chat and back) brought
   * them back.
   *
   * Memoised on the string, the object changes exactly when the markup does, and that is exactly
   * when the effects in `useCodeBlockActions` run again: they are keyed on this same object.
   */
  const markup = useMemo(() => (html === null ? null : { __html: html }), [html]);
  // Parsed at render, not stored: a reopened conversation gets the same billing link and retry
  // advice as the moment it failed, from the raw text kept in the transcript.
  const parsedError = useMemo(
    () => (message.isError ? parseClaudeError(message.content) : null),
    [message.isError, message.content],
  );

  const bodyRef = useCodeBlockActions(markup, {
    copy: t("chat.copyCode"),
    copyShort: t("chat.copyCodeShort"),
    copied: t("chat.copied"),
    copyFailed: t("chat.copyFailed"),
    save: t("chat.saveCode"),
    fileStem: t("chat.codeFileStem"),
  });

  const stampRow = <ChatStamp message={message} detail={stamp} />;
  const isUser = message.role === "user";

  // An answer still being written: the bare words and a caret. It is drawn inside the run card's
  // column (`AiRunLog`'s children), beside the mark that is writing it, so it carries no avatar of
  // its own; it re-renders as markdown once, when it is whole.
  if (streaming) {
    return (
      <div
        className={`min-w-0 select-text wrap-anywhere text-[var(--cf-text)] ${
          reading ? "text-[15px] leading-[1.75]" : "text-[12px] leading-relaxed"
        }`}
      >
        <span className="whitespace-pre-wrap">
          {body}
          <span aria-hidden="true" className="cf-caret" />
        </span>
      </div>
    );
  }

  /**
   * An assistant turn: the avatar in the gutter and everything the turn said in the column beside
   * it — the two columns the run card used while it ran, so the answer lands where it was written.
   * The column is nudged down when it opens on the answer itself, to sit the first line level with
   * the avatar's middle; the "Thought for…" line is nudged the same way.
   */
  const assistantTurn = (content: ReactNode) => (
    <div className={`group grid grid-cols-[auto_minmax(0,1fr)] ${reading ? "gap-x-3" : "gap-x-2.5"}`}>
      <AssistantAvatar reading={reading} landedAt={message.createdAt} />
      <div className={`min-w-0 space-y-1.5 ${reading ? "pt-[5px]" : "pt-[2px]"}`}>
        {traceLog}
        {content}
      </div>
    </div>
  );

  if (parsedError) {
    return assistantTurn(
      <>
        {/* The provider is taken from the turn, not from the current routing: a conversation
            reopened after the route changed must still be told which engine actually failed, or
            the remedy names the wrong CLI's install command. */}
        <AiErrorBanner
          error={parsedError}
          compact
          provider={message.provider ?? undefined}
          onPickModel={actions?.onPickModel}
        />
        {stampRow}
      </>,
    );
  }

  if (message.isCancelled) {
    return assistantTurn(
      <>
        {/* `w-fit`: a dashed box stretched across the column would read as an error banner rather
            than a footnote. */}
        <div className="flex w-fit items-center gap-1.5 rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-1 text-[11px] text-[var(--cf-text-muted)]">
          <Square size={9} className="fill-current" />
          {t("ai.runStopped")}
        </div>
        {stampRow}
      </>,
    );
  }

  // The user's own turn is the one bubble left: neutral rather than accent-washed, sized to its
  // words, its tight corner on its own side. The reply has no bubble at all — a reply that fills
  // the column is a document, and a tinted rectangle round a document is what makes a chat feel
  // like a support widget instead of a page.
  const userShell = reading
    ? "ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-[18px] rounded-br-md px-4 py-2.5 text-[14px] leading-[1.7]"
    : "ml-auto w-fit max-w-[88%] whitespace-pre-wrap rounded-[14px] rounded-br-[5px] px-3 py-1.5 text-[12px] leading-relaxed";

  /*
    One row under the turn: what it cost, and what you can do about it.

    The row takes the side its turn is on, and the stamp takes the *outer* edge of it: left of the
    controls under an assistant's answer, right of them under a user's bubble. A transcript is read
    as two columns, and metadata that always starts at the left margin detaches from the short
    right-aligned bubble it belongs to and reads as if it were the reply's.

    The stamp is the only part drawn at rest; the controls appear when the turn is hovered (or
    focused, so the keyboard can reach what the mouse uncovers), on whichever side faces the middle
    of the column, so they grow into empty space instead of pushing the stamp.
  */
  const controls = (
    <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 hover:opacity-100">
      <BubbleAction icon={copied ? Check : Copy} label={t("chat.copyMessage")} onClick={() => copy(copyText)} done={copied} />
      {actions?.onRegenerate && (
        <BubbleAction
          icon={RefreshCw}
          label={t("chat.regenerate")}
          onClick={actions.onRegenerate}
          cost={actions.replayTurns}
          costTitle={t("chat.replayCost", { n: actions.replayTurns ?? 0 })}
        />
      )}
      {actions?.onEdit && (
        <BubbleAction
          icon={Pencil}
          label={t("chat.editMessage")}
          onClick={actions.onEdit}
          cost={actions.replayTurns}
          costTitle={t("chat.replayCost", { n: actions.replayTurns ?? 0 })}
        />
      )}
      {actions?.onBranch && (
        <BubbleAction
          icon={GitBranch}
          label={t("chat.branchHere")}
          onClick={actions.onBranch}
          cost={actions.replayTurns}
          costTitle={t("chat.replayCost", { n: actions.replayTurns ?? 0 })}
        />
      )}
    </div>
  );

  // The panel's turns have no controls row; a copy button rides the corner on hover instead.
  const panelCopy = !reading && (
    <button
      type="button"
      onClick={() => copy(copyText)}
      title={t("chat.copyMessage")}
      className={`absolute -top-2 flex h-5 w-5 items-center justify-center rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] opacity-0 shadow-sm group-hover:opacity-100 ${
        isUser ? "-left-2" : "-right-2"
      }`}
    >
      {copied ? <Check size={11} className="text-[var(--cf-success)]" /> : <Copy size={11} className="text-[var(--cf-text-muted)]" />}
    </button>
  );

  if (isUser) {
    return (
      <div className="group space-y-1">
        <div
          // Selectable as a bubble: a user's own turn renders as a bare string, and would otherwise
          // be the one kind of message you couldn't quote back. `wrap-anywhere`: a pasted log or
          // stack trace is mostly paths with no space to break at.
          className={`relative min-w-0 select-text wrap-anywhere bg-[color-mix(in_oklab,var(--cf-text)_6%,var(--cf-surface))] text-[var(--cf-text)] shadow-[inset_0_0_0_1px_var(--cf-border)] ${userShell}`}
        >
          {message.skill && (
            <span className="mb-1 flex items-center gap-1 font-mono text-[11px] text-[var(--cf-text-muted)]">
              <Puzzle size={11} className="shrink-0" />
              {message.skill}
            </span>
          )}
          {sentFiles.length > 0 && (
            <span className="mb-1 flex flex-wrap gap-1 whitespace-normal">
              {sentFiles.map((file) => (
                <span
                  key={file.path}
                  title={file.path}
                  className="flex min-w-0 max-w-full items-center gap-1 rounded border border-[var(--cf-border)] bg-[var(--cf-surface)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--cf-text-muted)]"
                >
                  {file.isImage ? <ImageIcon size={11} className="shrink-0" /> : <FileText size={11} className="shrink-0" />}
                  <span className="truncate">{file.name}</span>
                </span>
              ))}
            </span>
          )}
          {body}
          {panelCopy}
        </div>
        {reading ? (
          <div className="flex items-center justify-end gap-1.5 pt-0.5">
            {controls}
            {stampRow}
          </div>
        ) : (
          stampRow
        )}
      </div>
    );
  }

  return assistantTurn(
    <>
      <div
        className={`relative min-w-0 select-text wrap-anywhere text-[var(--cf-text)] ${
          reading ? "text-[15px] leading-[1.75]" : "text-[12px] leading-relaxed"
        }`}
      >
        {markup !== null ? (
          <div
            ref={bodyRef}
            // The reading variant takes `cf-markdown-preview` on its own — the app's document
            // style, 13.5px at 1.65 — where the panel adds `cf-markdown-chat` to squeeze it to
            // 12px. That is the whole typographic difference between a page and a sidebar.
            className={`cf-markdown-preview ${reading ? "" : "cf-markdown-chat"}`}
            // The memoised object, never an inline `{{ __html }}` — see `markup`.
            dangerouslySetInnerHTML={markup}
          />
        ) : (
          body
        )}
        {panelCopy}
      </div>
      {/* The files the turn read or changed — its sources — then the files it wrote. Both are part
          of what this turn said; the row after them is what you *do* about it. */}
      {trace && trace.length > 0 && <RunFileChips lines={trace} density={variant} />}
      {outputs && outputs.files.length > 0 && (
        <div className="pt-0.5">
          <OutputBar conversationId={outputs.conversationId} files={outputs.files} label={false} />
        </div>
      )}
      {reading ? (
        <div className="flex items-center gap-1.5">
          {stampRow}
          {controls}
        </div>
      ) : (
        stampRow
      )}
    </>,
  );
});

/** How recently a turn must have landed for its avatar to arrive by way of the thinking mark. */
const SETTLE_WINDOW_MS = 4000;

/**
 * The assistant's mark beside its turn.
 *
 * A turn that has only just landed first shows the thinking mark resolving — the run card that sat
 * in this gutter a moment ago, finishing — and then the avatar springs in in its place. How long
 * that takes is the design's own finish (`thinkingFinishMs`: a brief resolve for most, a little
 * show for the ones built around it). A turn read back from history is simply the avatar:
 * replaying that for every old message would be a flourish pretending something had just happened.
 */
function AssistantAvatar({ reading, landedAt }: { reading: boolean; landedAt?: string }) {
  const [settling, setSettling] = useState(() => {
    const when = parseStamp(landedAt);
    const age = when ? Date.now() - when.getTime() : -1;
    return age >= 0 && age < SETTLE_WINDOW_MS;
  });
  const [arrived] = useState(settling);
  const design = useThinkingDesignStore((s) => s.design);
  useEffect(() => {
    if (!settling) return;
    const timer = setTimeout(() => setSettling(false), thinkingFinishMs(design));
    return () => clearTimeout(timer);
  }, [settling, design]);
  const box = reading ? "h-8 w-8" : "h-[22px] w-[22px]";
  return (
    <span className={`flex ${box} shrink-0 items-center justify-center`}>
      {settling ? (
        <ThinkingOrb size={reading ? "card" : "md"} activity={{ done: true }} />
      ) : (
        <span
          className={`flex ${box} items-center justify-center rounded-full bg-[var(--cf-surface-raised)] shadow-[inset_0_0_0_1px_var(--cf-border)] ${
            arrived ? "cf-avatar-in" : ""
          }`}
        >
          <AiSparkles size={reading ? 15 : 11} />
        </span>
      )}
    </span>
  );
}

/** One control on the hover row under a reading-variant turn. */
function BubbleAction({
  icon: Icon,
  label,
  onClick,
  done,
  cost,
  costTitle,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  done?: boolean;
  cost?: number;
  costTitle?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
    >
      <Icon size={12} className={done ? "text-[var(--cf-success)]" : undefined} />
      {cost !== undefined && cost > 0 && costTitle && <CostChip turns={cost} title={costTitle} />}
    </button>
  );
}


/** The words on a code block's bar, translated by the caller. */
interface CodeBlockLabels {
  /** The copy button's tooltip — "Copiar el código". */
  copy: string;
  /** Its visible word — "Copiar". */
  copyShort: string;
  /** What that word becomes for a moment after it worked — "Copiado". */
  copied: string;
  copyFailed: string;
  save: string;
  /** The generic stem a saved block falls back to — "snippet", "fragmento". */
  fileStem: string;
}

/**
 * Lucide's `copy`, `check` and `download` (lucide-react 1.25), as data: these buttons are built
 * outside React (see `useCodeBlockActions`), so they cannot render the components — but they draw
 * the same glyphs every other copy and save control in the app draws. The Unicode marks they
 * replaced (⧉, ↓) came out in whatever font the platform happened to have for them.
 */
type IconShape = readonly [tag: string, attributes: Readonly<Record<string, string>>];
const COPY_ICON: readonly IconShape[] = [
  ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
  ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }],
];
const CHECK_ICON: readonly IconShape[] = [["path", { d: "M20 6 9 17l-5-5" }]];
const DOWNLOAD_ICON: readonly IconShape[] = [
  ["path", { d: "M12 15V3" }],
  ["path", { d: "M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" }],
  ["path", { d: "m7 10 5 5 5-5" }],
];

function icon(shapes: readonly IconShape[]): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  const frame: Record<string, string> = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  };
  for (const [name, value] of Object.entries(frame)) svg.setAttribute(name, value);
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.append(shape);
  }
  return svg;
}

/** One button on a code block's bar: an icon, and a word when `text` is given. */
function barButton(shapes: readonly IconShape[], title: string, text?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cf-chat-code-btn";
  button.title = title;
  button.setAttribute("aria-label", title);
  button.append(icon(shapes));
  if (text) {
    const word = document.createElement("span");
    word.className = "cf-chat-code-btn-text";
    word.textContent = text;
    button.append(word);
  }
  return button;
}

/**
 * Frames every code block in a rendered answer: a bar over it that names the language and carries
 * Copy and Save, always on screen.
 *
 * Done to the DOM after the fact rather than in the markdown pipeline, and that is a deliberate
 * trade rather than laziness. `renderMarkdown` runs `marked` and then DOMPurify, and the sanitiser
 * is the whole reason that function exists — a model's answer is untrusted text. Injecting a
 * `<button onclick=...>` into the HTML string means either weakening the DOMPurify config to let
 * event attributes through (no) or teaching it a bespoke allowance for one element (a hole in the
 * one defence this path has, opened for a convenience). Appending a real DOM node with a real React
 * -free listener afterwards touches none of that: the sanitiser still sees, and still cleans, every
 * byte that came from the model.
 *
 * # Why a bar, and why in both variants
 *
 * This used to be a pair of 22px glyph buttons in the block's corner that appeared only under the
 * pointer, and only in the reading variant. Invisible at rest is invisible in practice: nothing on
 * screen said a block could be copied, a screenshot never showed the control, and the report that
 * retired it was simply that the code "has no copy". A bar costs one short line above the block and
 * no width, which is also why the panel variant — whose 12px sidebar blocks were too narrow to give
 * a corner to — can have one too: its bar keeps the icons and drops the word.
 *
 * # Why it draws again, and when
 *
 * Everything here — the bars and, in the effect before them, the colours — is drawn on markup React
 * owns, and lasts exactly as long as React leaves that markup alone. React replaces it wholesale
 * whenever `dangerouslySetInnerHTML` is handed a different object, so both effects are keyed on
 * that same object (`markup` in the bubble, memoised on the HTML): every write React makes is
 * followed by a pass that draws on the new markup. A theme switch re-runs the colours, a language
 * switch the bars — the cleanup unwraps every frame first, so a block never gets a second bar.
 *
 * Layout effects rather than passive ones. A layout effect's cleanup runs inside the commit that
 * wrote the new markup, ahead of any `MutationObserver` callback (a microtask), so the observer
 * below is disconnected before it hears of that write. A passive cleanup is only that early for a
 * synchronous render; after any other, a pass bound to the old markup would decorate the new one
 * and then be undone by the pass that replaces it. It also puts the bars — and, once Monaco is in,
 * the colours (see `loadedMonaco` in `lib/codeHighlight`) — in the same frame as the markup they
 * belong to, whatever priority the render ran at.
 *
 * That observer is the second line: a redraw whenever the host's children are replaced by anything
 * the keys do not see. Nothing does today — the memo is what guarantees it — but the failure it
 * guards against was silent and total (every block in the transcript went grey while an answer was
 * being written, and nothing brought it back short of a remount), and the idiomatic spelling of the
 * prop, an inline `{{ __html: html }}`, is precisely the one that brings it back. With the observer
 * such a rewrite costs a redraw, not the colours.
 */
function useCodeBlockActions(markup: { __html: string } | null, labels: CodeBlockLabels) {
  const { copy: copyLabel, copyShort, copied, copyFailed, save: saveLabel, fileStem } = labels;
  const ref = useRef<HTMLDivElement>(null);

  // The active code scheme, so a block in an answer is coloured exactly like the same code in the
  // editor. Read from the two halves rather than a derived object, because a selector returning a
  // fresh object would re-run this effect on every unrelated store write.
  const mode = useThemeStore((s) => s.resolved);
  const themeId = useThemeStore((s) => (s.resolved === "dark" ? s.darkThemeId : s.lightThemeId));

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || markup === null) return;
    // Clearing the done-marker is what makes a theme switch recolour blocks that are already on
    // screen. It is safe to run over spans this already produced: `textContent` still reads back
    // the original source, so the second pass tokenizes the same text and replaces the children.
    for (const code of Array.from(host.querySelectorAll("pre > code[data-cf-hl]"))) {
      code.removeAttribute("data-cf-hl");
    }
    const theme = findTheme(themeId, mode);
    // Fire-and-forget: Monaco is a 4.4 MB chunk, loaded on the first code block of the session, and
    // the text is already on screen and readable while it arrives. No cancellation to do — the
    // function walks whatever nodes are still there when it resolves, and an unmounted bubble's
    // query simply comes back empty. Idempotent through the same marker, which is what lets the
    // observer call it again: a block already coloured is skipped, not tokenized twice.
    const paint = () => void highlightCodeBlocks(host, theme).catch(() => {});
    paint();
    return onMarkupReplaced(host, paint);
  }, [markup, themeId, mode]);

  useLayoutEffect(() => {
    const host = ref.current;
    if (!host || markup === null) return;
    const frames: HTMLElement[] = [];
    const timers: number[] = [];
    /** The blocks this run has put a bar on, so a pass the observer starts skips them rather than
     *  rebuilding their bars — the only thing it is there for is a `<pre>` nobody has framed. */
    const framed = new WeakSet<Element>();

    const frameBlocks = () => {
      for (const pre of Array.from(host.querySelectorAll("pre"))) {
        if (framed.has(pre)) continue;
        framed.add(pre);
        frameBlock(pre);
      }
    };

    const frameBlock = (pre: HTMLPreElement) => {
      /*
       * The bar goes in a frame around the `<pre>`, never inside the `<pre>` itself.
       *
       * The `<pre>` is the horizontal scroll container (`.cf-markdown-preview pre` is
       * `overflow-x: auto`), so anything inside it scrolls away with a long line, and anything
       * inside it is *text* of it: selected along with the code by a drag, and read back by
       * `pre.textContent` — which is how copying a block once put a stray `⧉` on the clipboard.
       * The frame is the rounded, tinted box on screen; the `<pre>` in it is flat (`index.css`).
       *
       * Defensive about a frame already being there: the cleanup below unwraps every frame before
       * this runs again, but a second frame nested in the first would draw a box inside a box.
       */
      let frame = pre.parentElement;
      if (frame?.classList.contains("cf-chat-code")) {
        frame.querySelector(":scope > .cf-chat-code-bar")?.remove();
      } else {
        frame = document.createElement("div");
        frame.className = "cf-chat-code";
        pre.replaceWith(frame);
        frame.append(pre);
      }
      frames.push(frame);

      /**
       * The block's source, read from the `<code>` and **not** from the `<pre>`, which is the one
       * that would carry anything ever put inside it. The `<code>` holds the code and nothing else,
       * and still reads back the original source after highlighting, which replaces its children
       * with spans but changes no text.
       */
      const className = pre.querySelector("code")?.className ?? "";
      const language = languageOf(className);
      // `bodyForBlock` is what strips the naming line the system prompt asks the model for, and
      // only in the formats where that line is not valid syntax — see `lib/codeFileName`. Both
      // buttons read through it, so copying and saving can never produce two different files.
      const sourceOf = () =>
        bodyForBlock(language, (pre.querySelector("code") ?? pre).textContent ?? "");

      const bar = document.createElement("div");
      bar.className = "cf-chat-code-bar";
      // The label as the model wrote it. A bare fence gets an empty one, which still pushes the
      // buttons to the right — the bar is the same shape whether or not the block is named.
      const name = document.createElement("span");
      name.className = "cf-chat-code-lang";
      name.textContent = fenceLabelOf(className) ?? "";

      const copy = barButton(COPY_ICON, copyLabel, copyShort);
      /** Swaps the button between its resting face and "Copiado". */
      const showCopied = (done: boolean) => {
        copy.toggleAttribute("data-done", done);
        copy.replaceChildren(done ? icon(CHECK_ICON) : icon(COPY_ICON));
        const word = document.createElement("span");
        word.className = "cf-chat-code-btn-text";
        word.textContent = done ? copied : copyShort;
        copy.append(word);
      };
      copy.addEventListener("click", () => {
        // "Copiado" only once the clipboard said yes. The button this replaced flipped to ✓ before
        // the write had even been attempted, so a refused write looked exactly like a good one.
        navigator.clipboard.writeText(sourceOf()).then(
          () => {
            showCopied(true);
            timers.push(window.setTimeout(() => showCopied(false), 1500));
          },
          () => pushErrorToast(copyFailed),
        );
      });

      const save = barButton(DOWNLOAD_ICON, saveLabel);
      save.addEventListener("click", () => {
        const source = sourceOf();
        // Named from the raw text, saved from the stripped one: the naming line is the only place
        // the name exists, so reading it back out of a body it has already been removed from would
        // lose it exactly when it is most wanted.
        const raw = (pre.querySelector("code") ?? pre).textContent ?? "";
        const suggested = fileNameForBlock(language, raw, fileStem);
        // The extension the name ended up with, offered as the dialog's filter so the platform
        // does not append a second one. A `Dockerfile` has none and gets no filter rather than a
        // filter for the empty string.
        const dot = suggested.lastIndexOf(".");
        const extension = dot > 0 ? suggested.slice(dot + 1) : null;
        void (async () => {
          try {
            const path = await saveDialog({
              defaultPath: suggested,
              filters: extension
                ? [{ name: extension.toUpperCase(), extensions: [extension] }]
                : undefined,
            });
            if (!path) return;
            await writeFileBytes(path, new TextEncoder().encode(source));
          } catch (e) {
            // A refused directory, a full disk, a name the platform rejects. Saying so beats a
            // button that looks like it worked and left nothing behind.
            pushErrorToast(String(e));
          }
        })();
      });

      bar.append(name, save, copy);
      frame.prepend(bar);
    };

    frameBlocks();
    const stopWatching = onMarkupReplaced(host, frameBlocks);
    return () => {
      stopWatching();
      timers.forEach((timer) => window.clearTimeout(timer));
      // Unwrapped, bar and all, so the next run starts from the markup React put there. `replaceWith`
      // on a node React has already discarded has no parent and does nothing, which is the common
      // case: a new `markup` rewrites this subtree wholesale.
      frames.forEach((frame) => {
        frame.querySelector(":scope > .cf-chat-code-bar")?.remove();
        const pre = frame.querySelector(":scope > pre");
        if (pre) frame.replaceWith(pre);
      });
    };
  }, [markup, copyLabel, copyShort, copied, copyFailed, saveLabel, fileStem]);
  return ref;
}

/**
 * Calls `redraw` whenever the host's own children are replaced, and returns the way to stop.
 *
 * `childList` on the host and nothing deeper, which is all the question needs: React writing new
 * markup replaces the host's children, so it is always a change at this level, wherever in the
 * answer the code blocks sit. The colours a pass paints live a level down, inside each `<code>`,
 * and are never heard. The frame wrapped around a top-level `<pre>` *is* a change here, so every
 * pass that frames something is followed by one more — which finds every block already done and
 * changes nothing, so it settles after a single round rather than feeding itself.
 */
function onMarkupReplaced(host: HTMLElement, redraw: () => void): () => void {
  const observer = new MutationObserver(redraw);
  observer.observe(host, { childList: true });
  // `disconnect` also drops records already queued and not yet delivered, which is what makes
  // calling this from a layout effect's cleanup mean "never for markup this pass did not draw".
  return () => observer.disconnect();
}

/**
 * One muted 10px line under a turn: when it happened and, for an answer, what produced it.
 *
 * Deliberately a single row rather than a chip or a header. The process log sitting right above it
 * is already a box, and this is reference information you go looking for ("which model wrote
 * this?"), not something the transcript should be announcing. Only the time is shown; the day is
 * carried by the divider between days, and the full date is on hover.
 */
function ChatStamp({ message, detail }: { message: ChatBubbleMessage; detail: ChatStampDetail }) {
  const t = useT();
  const locale = useLocale();
  const when = parseStamp(message.createdAt);

  const parts: string[] = [];
  if (message.role === "assistant") {
    // A turn with a trace or reasoning already says how long it took, in its "Thought for…" line.
    const saysDuration = (message.trace?.length ?? 0) > 0 || !!message.thinking?.trim() || !!message.traceId;
    if (detail === "full" && message.responseTimeMs !== undefined && !saysDuration) {
      parts.push(`⏱ ${formatResponseTime(message.responseTimeMs)}`);
    }
    if (message.provider) parts.push(providerDisplayLabel(message.provider, t));
    // An empty provider still yields the raw model id, which is the honest answer for a turn
    // recorded before the provider was tracked.
    if (message.model) parts.push(modelDisplayLabel(message.provider ?? "", message.model, t));
    if (detail === "full" && message.engineVersion) parts.push(`v${message.engineVersion}`);
  }
  if (when) parts.push(when.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
  if (parts.length === 0) return null;

  return (
    <div
      title={when?.toLocaleString(locale)}
      className={`px-0.5 text-[10.5px] leading-tight text-[var(--cf-text-muted)] ${
        message.role === "user" ? "text-right" : ""
      }`}
    >
      {parts.join(" · ")}
    </div>
  );
}

/** The date to announce before `message`, or `null` when it falls on the same day as the one before
 *  it. Carrying the day here keeps every per-message stamp down to a bare time. Exported because
 *  all three transcripts draw the same divider. */
export function dayDivider(
  message: ChatBubbleMessage,
  previous: ChatBubbleMessage | undefined,
  locale: string,
): string | null {
  const when = parseStamp(message.createdAt);
  if (!when) return null;
  const before = parseStamp(previous?.createdAt);
  if (before && before.toDateString() === when.toDateString()) return null;
  return when.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}
