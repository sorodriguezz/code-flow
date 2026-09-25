import { memo, useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Check, Copy, GitBranch, Pencil, RefreshCw, Square, type LucideIcon } from "lucide-react";
import { renderMarkdown } from "../../lib/markdown";
import { parseClaudeError } from "../../lib/claudeError";
import { modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { useT } from "../../state/languageStore";
import type { AiRunLine } from "../../state/aiRunStore";
import { AiErrorBanner } from "../ai/AiErrorBanner";
import { AiRunLog } from "../ai/AiRunLog";
import { CostChip, formatResponseTime, parseStamp, useCopy, useLocale } from "./chatChrome";
import { highlightCodeBlocks, languageOf } from "../../lib/codeHighlight";
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
  /** This turn failed; `content` is the raw engine error, still carrying the quota marker so the
   *  banner can re-derive the billing link when a past conversation is reopened. */
  isError?: boolean;
  isCancelled?: boolean;
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
}) {
  const t = useT();
  const [copied, copy] = useCopy();
  const [traceOpen, setTraceOpen] = useState(false);
  const reading = variant === "reading";

  // The recorded process behind this answer. Rendered under every kind of assistant turn —
  // including the failed and the stopped ones, where "what was it doing when it died?" is the
  // whole question.
  const trace = message.trace;
  const traceLog = trace && trace.length > 0 && (
    <div className={`${reading ? "pt-1.5" : "mr-auto max-w-[95%] pt-1"}`}>
      <AiRunLog
        lines={trace}
        running={false}
        label={t("ai.traceSteps", { n: trace.length })}
        expanded={traceOpen}
        onToggle={() => setTraceOpen((v) => !v)}
      />
    </div>
  );

  const streaming = streamText !== undefined;
  const body = streaming ? streamText : message.content;

  const html = useMemo(
    () => (message.role === "assistant" && !message.isError && !streaming ? renderMarkdown(body) : null),
    [message.role, message.isError, streaming, body],
  );
  // Parsed at render, not stored: a reopened conversation gets the same billing link and retry
  // advice as the moment it failed, from the raw text kept in the transcript.
  const parsedError = useMemo(
    () => (message.isError ? parseClaudeError(message.content) : null),
    [message.isError, message.content],
  );

  const bodyRef = useCodeBlockActions(
    html,
    reading,
    t("chat.copyCode"),
    t("chat.saveCode"),
    t("chat.codeFileStem"),
  );

  const stampRow = <ChatStamp message={message} detail={stamp} />;

  if (parsedError) {
    return (
      <div className={reading ? "space-y-1" : "mr-auto max-w-[95%] space-y-1"}>
        {/* The provider is taken from the turn, not from the current routing: a conversation
            reopened after the route changed must still be told which engine actually failed, or
            the remedy names the wrong CLI's install command. */}
        <AiErrorBanner
          error={parsedError}
          compact
          provider={message.provider ?? undefined}
          onPickModel={actions?.onPickModel}
        />
        {traceLog}
        {stampRow}
      </div>
    );
  }

  if (message.isCancelled) {
    return (
      <div className={reading ? "space-y-1" : "mr-auto max-w-[85%] space-y-1"}>
        {/* `w-fit` only in the reading column, where the wrapper is the full 740px and a dashed box
            stretched across all of it would read as an error banner rather than a footnote. The
            panel keeps the box it has always drawn. */}
        <div
          className={`flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--cf-border)] px-2.5 py-1 text-[11px] text-[var(--cf-text-muted)] ${
            reading ? "w-fit" : ""
          }`}
        >
          <Square size={9} className="fill-current" />
          {t("ai.runStopped")}
        </div>
        {traceLog}
        {stampRow}
      </div>
    );
  }

  const isUser = message.role === "user";

  // The two variants differ only in this class string, kept side by side so the difference is one thing
  // to read rather than a branch to trace through the component.
  const shell = reading
    ? isUser
      ? "ml-auto max-w-[85%] whitespace-pre-wrap rounded-2xl border border-[color-mix(in_oklab,var(--cf-accent)_26%,transparent)] bg-[color-mix(in_oklab,var(--cf-accent)_11%,var(--cf-surface))] px-4 py-2.5 text-[14px] leading-[1.7] text-[var(--cf-text)]"
      : "w-full text-[15px] leading-[1.75] text-[var(--cf-text)]"
    : isUser
      ? "ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg border border-[color-mix(in_oklab,var(--cf-accent)_30%,transparent)] bg-[color-mix(in_oklab,var(--cf-accent)_14%,var(--cf-surface))] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)]"
      : "mr-auto max-w-[85%] rounded-lg bg-[color-mix(in_oklab,var(--cf-accent)_6%,var(--cf-surface))] px-2.5 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)]";

  return (
    <div className="space-y-1">
      <div
        // Selectable as a bubble rather than only through the markdown class inside it: a plain
        // (non-markdown) message — a user's own turn, a cancelled run's text — renders as a bare
        // string here and would otherwise be the one kind of message you couldn't quote back.
        className={`group relative select-text ${shell}`}
      >
        {html !== null ? (
          <div
            ref={bodyRef}
            // The reading variant takes `cf-markdown-preview` on its own — the app's document
            // style, 13.5px at 1.65 — where the panel adds `cf-markdown-chat` to squeeze it to
            // 12px. That is the whole typographic difference between a page and a sidebar.
            className={`cf-markdown-preview ${reading ? "" : "cf-markdown-chat"}`}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        ) : streaming ? (
          // A caret while the tokens land, dropped the instant the turn is whole. It is the one
          // honest "it is still going" mark for a transcript that is already showing text — a
          // spinner beside a half-written paragraph says less than the paragraph does.
          <span className="whitespace-pre-wrap">
            {body}
            <span
              aria-hidden="true"
              className="ml-[1px] inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-[var(--cf-accent-fill)] align-baseline"
            />
          </span>
        ) : (
          body
        )}
        {!reading && (
          <button
            type="button"
            onClick={() => copy(message.content)}
            title={t("chat.copyMessage")}
            className={`absolute -top-2 flex h-5 w-5 items-center justify-center rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] opacity-0 shadow-sm group-hover:opacity-100 ${
              isUser ? "-left-2" : "-right-2"
            }`}
          >
            {copied ? (
              <Check size={11} className="text-[var(--cf-success)]" />
            ) : (
              <Copy size={11} className="text-[var(--cf-text-muted)]" />
            )}
          </button>
        )}
      </div>
      {traceLog}
      {/* Under the answer that made them, and above the hover controls: the files are part of what
          this turn said, and the row below is what you *do* about the turn. */}
      {outputs && outputs.files.length > 0 && (
        <div className="pt-1.5">
          <OutputBar conversationId={outputs.conversationId} files={outputs.files} label={false} />
        </div>
      )}
      {/*
        One row under the turn: what it cost, and what you can do about it.
       
        They were two rows — controls, then a stamp beneath them — which is two lines of chrome
        under every paragraph of a reading surface, and the pair drifted apart on screen because
        only one of them was ever visible at rest.
       
        The row takes the side its turn is on, and the stamp takes the *outer* edge of it: left of
        the controls under an assistant's answer, right of them under a user's bubble. A transcript
        is read as two columns, and metadata that always starts at the left margin detaches from
        the short right-aligned bubble it belongs to and reads as if it were the reply's.
       
        Ordering it this way is also what keeps the row still. The stamp is the only part drawn at
        rest; the controls appear on hover on whichever side faces the middle of the column, so
        they grow into empty space instead of pushing the one thing that was already there.
       
        The controls keep the hover reveal — `focus-within` as well, so the keyboard can reach what
        the mouse uncovers — and the stamp does not: it is information, not an action.
      */}
      {reading && !streaming ? (
        <div className={`flex items-center gap-1.5 pt-0.5 ${isUser ? "justify-end" : ""}`}>
          {!isUser && stampRow}
          <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 hover:opacity-100">
          <BubbleAction
            icon={copied ? Check : Copy}
            label={t("chat.copyMessage")}
            onClick={() => copy(message.content)}
            done={copied}
          />
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
          {isUser && stampRow}
        </div>
      ) : (
        // The panel variant and a turn still being written have no controls to sit beside, so the
        // stamp keeps the plain line it always had.
        stampRow
      )}
    </div>
  );
});

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


/**
 * Hangs a copy button off every fenced code block in a rendered answer.
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
 * Keyed on the rendered HTML so a turn that re-renders (a language switch, a theme change) does not
 * accumulate a second button per block. Only the reading variant gets these: the two panel
 * transcripts are 12px sidebars whose code blocks are four columns wide, and this lift is a
 * refactor of those, not a redesign.
 */
function useCodeBlockActions(
  html: string | null,
  enabled: boolean,
  copyLabel: string,
  saveLabel: string,
  /** The generic stem a saved block falls back to — "snippet", "fragmento". */
  fileStem: string,
) {
  const ref = useRef<HTMLDivElement>(null);

  // The active code scheme, so a block in an answer is coloured exactly like the same code in the
  // editor. Read from the two halves rather than a derived object, because a selector returning a
  // fresh object would re-run this effect on every unrelated store write.
  const mode = useThemeStore((s) => s.resolved);
  const themeId = useThemeStore((s) => (s.resolved === "dark" ? s.darkThemeId : s.lightThemeId));

  useEffect(() => {
    const host = ref.current;
    if (!host || html === null) return;
    // Clearing the done-marker is what makes a theme switch recolour blocks that are already on
    // screen. It is safe to run over spans this already produced: `textContent` still reads back
    // the original source, so the second pass tokenizes the same text and replaces the children.
    for (const code of Array.from(host.querySelectorAll("pre > code[data-cf-hl]"))) {
      code.removeAttribute("data-cf-hl");
    }
    // Fire-and-forget: Monaco is a 4.4 MB chunk, loaded on the first code block of the session, and
    // the text is already on screen and readable while it arrives. No cancellation to do — the
    // function walks whatever nodes are still there when it resolves, and an unmounted bubble's
    // query simply comes back empty.
    void highlightCodeBlocks(host, findTheme(themeId, mode)).catch(() => {});
  }, [html, themeId, mode]);

  useEffect(() => {
    const host = ref.current;
    if (!host || !enabled || html === null) return;
    const added: HTMLButtonElement[] = [];
    const wrappers: HTMLElement[] = [];

    /** One of these corner buttons, styled the same and placed by how far in from the right. */
    const corner = (glyph: string, title: string, right: number, onClick: () => void) => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.textContent = glyph;
      button.style.cssText =
        `position:absolute;top:6px;right:${right}px;width:22px;height:22px;border-radius:6px;` +
        "border:1px solid var(--cf-border);background:var(--cf-surface);color:var(--cf-text-muted);" +
        "font-size:11px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s";
      button.addEventListener("click", onClick);
      return button;
    };

    for (const pre of Array.from(host.querySelectorAll("pre"))) {
      /*
       * The buttons hang off a wrapper around the `<pre>`, never off the `<pre>` itself.
       *
       * The `<pre>` is the horizontal scroll container (`.cf-markdown-preview pre` is
       * `overflow-x: auto`), and an absolutely-positioned child of a scrolling box is placed
       * against its **content**, not against the part of it you can see. So `right: 6px` did not
       * mean "six pixels from the right edge of the block", it meant "six pixels past the end of
       * the longest line" — and scrolling a block sideways sent both buttons sliding into the
       * middle of the code, sitting on top of whatever was there. They describe the block, not a
       * position in the text, so they belong to something that does not scroll.
       *
       * Idempotent, because this effect re-runs on a DOM it has already wrapped whenever the
       * labels change with the app's language. A second wrapper would nest inside the first and
       * the buttons would be positioned against a box the width of the code again.
       */
      let frame = pre.parentElement;
      if (!frame?.classList.contains("cf-chat-code")) {
        const box = document.createElement("div");
        box.className = "cf-chat-code";
        pre.replaceWith(box);
        box.append(pre);
        frame = box;
      }
      // Inline, and **not** left to `.cf-chat-code` in the stylesheet. This one declaration is what
      // gives the buttons a containing block; without it they anchor to whatever positioned
      // ancestor they find — the bubble, or further — and every block's pair lands in one pile far
      // from the code it belongs to, invisible in practice. The class still exists, for the padding
      // that keeps the first line out from under them, but that is cosmetic: losing it puts text
      // under a button, while losing this loses the button. A control should not depend on a
      // stylesheet to be reachable, and the code it replaced did exactly this on the `<pre>`.
      frame.style.position = "relative";
      wrappers.push(frame);

      /**
       * The block's source, read from the `<code>` and **not** from the `<pre>`.
       *
       * These buttons are appended *inside* the `<pre>`, so `pre.textContent` is the code plus
       * whatever glyphs are sitting in its corner — which is why copying a block used to put a
       * stray `⧉` on the clipboard, and would now have put one in a saved file too. The `<code>`
       * holds the code and nothing else. It still reads back the original source after
       * highlighting, which replaces its children with spans but changes no text.
       */
      const language = languageOf(pre.querySelector("code")?.className ?? "");
      // `bodyForBlock` is what strips the naming line the system prompt asks the model for, and
      // only in the formats where that line is not valid syntax — see `lib/codeFileName`. Both
      // buttons read through it, so copying and saving can never produce two different files.
      const sourceOf = () =>
        bodyForBlock(language, (pre.querySelector("code") ?? pre).textContent ?? "");

      const copy = corner("⧉", copyLabel, 6, () => {
        void navigator.clipboard.writeText(sourceOf());
        copy.textContent = "✓";
        setTimeout(() => (copy.textContent = "⧉"), 1500);
      });

      const save = corner("↓", saveLabel, 32, () => {
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

      const show = () => {
        copy.style.opacity = "1";
        save.style.opacity = "1";
      };
      const hide = () => {
        copy.style.opacity = "0";
        save.style.opacity = "0";
      };
      // On the frame, not on the `<pre>`: the buttons are now the `<pre>`'s siblings rather than
      // its children, so a pointer moving from the code onto a button *leaves* the `<pre>` — which
      // hid the button out from under the cursor that was reaching for it.
      frame.addEventListener("mouseenter", show);
      frame.addEventListener("mouseleave", hide);
      // Focus reveals them too, and not as a nicety: a button at `opacity:0` is still in the tab
      // order, so without this a keyboard user tabs onto a control they cannot see and has no way
      // to know what pressing space would do. The pointer and the caret get the same affordance.
      for (const button of [copy, save]) {
        button.addEventListener("focus", show);
        button.addEventListener("blur", hide);
      }
      frame.append(copy, save);
      added.push(copy, save);
    }
    return () => {
      added.forEach((button) => button.remove());
      // Unwrapped too, so a bubble that stops offering the buttons stops reserving room for them.
      // `replaceWith` on a node React has already discarded has no parent and does nothing, which
      // is the common case: changing `html` rewrites this subtree wholesale.
      wrappers.forEach((frame) => {
        const pre = frame.firstElementChild;
        if (pre) frame.replaceWith(pre);
      });
    };
  }, [html, enabled, copyLabel, saveLabel, fileStem]);
  return ref;
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
    if (detail === "full" && message.responseTimeMs !== undefined) {
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
