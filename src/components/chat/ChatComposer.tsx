import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ArrowUp, ListPlus, Paperclip, Puzzle, Square, X } from "lucide-react";
import { ChatModelPicker } from "../ai/ChatModelPicker";
import { FlowAssistantPicker } from "./FlowAssistantPicker";
import { EffortPicker } from "./EffortPicker";
import { useTextMenu } from "../common/TextMenu";
import { AttachmentBar } from "./AttachmentBar";
import { QueuedMessages, type ComposerQueue } from "./QueuedMessages";
import { ChatCapabilities } from "./ChatCapabilities";
import { ContextMeter, type ContextReading } from "./ContextMeter";
import { CavemanChip } from "./CavemanChip";
import { McpMenu } from "./McpMenu";
import type { ChatAttachment, SkillPick } from "../../lib/tauri/chatCommands";
import { CommandMenu, appCommandFor, type ChatAppCommand, type CommandSurface } from "./CommandMenu";
import { COLUMN_GUTTER, READING_COLUMN } from "./chatChrome";
import { providerCapabilities, providerDisplayLabel } from "../../lib/aiProviders";
import { useAutosizeTextarea } from "../../lib/useAutosizeTextarea";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { pushErrorToast } from "../../state/toastStore";
import { registerDictationSend } from "../../state/dictationStore";
import { DictationBar, DictationMic, useDictatingHere } from "../dictation/DictationControls";

/** How tall the box may grow before it starts scrolling instead. Roughly twelve lines — past that
 *  the composer is eating the transcript it is supposed to be a footnote to, and the text being
 *  written is long enough that scrolling inside it is normal rather than surprising. */
const MAX_COMPOSER_HEIGHT = 260;

/**
 * The composer.
 *
 * Pinned to the bottom of the reading column rather than to the window, which is the detail that
 * makes this feel like the desktop chat apps and not like a panel: the box is exactly as wide as
 * the text above it, so the eye travels straight down from the last answer to the place the next
 * question goes, with no change of measure in between.
 *
 * # Enter sends
 *
 * Enter sends and Shift+Enter breaks the line, which is the convention every chat client shares and
 * the opposite of what a text editor does. It is worth naming because this app contains both, and
 * the `AgentTaskDetail` composer already made the same choice — if the two ever disagreed, the
 * muscle memory built in one would destroy work in the other. IME composition is excluded: a
 * Japanese or Chinese input method uses Enter to *accept a candidate*, and a composer that read
 * that as "send" would post the first half of every sentence typed in those languages.
 *
 * # Enter while a turn runs queues
 *
 * Given a `queue`, the box stays live for the whole turn and Enter keeps working: what is sent then
 * waits above the box (`QueuedMessages`) and goes out when the answer is done — the store decides
 * which, see `conversationStore.submit`. Stop keeps its place, and a small queue button joins it
 * only while there is something in the box to queue. Without a `queue` a running turn still refuses
 * a second message, which is the old behaviour and the right one for a surface that cannot show
 * what it is holding.
 */
export function ChatComposer({
  provider,
  model,
  effort,
  effortSupported,
  canWriteFiles = false,
  attachments,
  onAttachPath,
  onAttachBytes,
  onRemoveAttachment,
  onPickEngine,
  onPickFlow,
  onNewChatOn,
  onContinueOn,
  account,
  onPickEffort,
  sending,
  cancelling,
  turns,
  draft,
  onDraftChange,
  onSend,
  onStop,
  onRunAppCommand,
  onOpenTerminal,
  context,
  caveman,
  disabled,
  disabledReason,
  surface = "chat",
  skillScope,
  queue,
}: {
  provider: string;
  /** The model this conversation runs on. Its own prop rather than read from the workspace routing:
   *  `chat_send` uses the conversation's row, so a chip sourced from the routing names one engine
   *  while the turn goes to another. */
  model: string;
  /** This conversation's reasoning level, or `""` for the CLI's own configured default. */
  effort: string;
  /** Whether this conversation's engine accepts a level at all — false hides the control rather
   *  than drawing a dial that turns nothing. */
  effortSupported: boolean;
  /** Whether this conversation's turns may write files the user can download — the
   *  file-generation setting, since no chat here is bound to a repository. */
  canWriteFiles?: boolean;
  /** Files already copied into this conversation's folder and staged for the next turn. */
  attachments: ChatAttachment[];
  /** Copies a file the user picked. Absent only where the surface declines files outright (the ask
   *  box), and the paperclip is then not drawn at all. The empty state *does* pass one: the file is
   *  staged and moved into the conversation the first message creates. */
  onAttachPath?: (path: string) => Promise<void>;
  /** Stores bytes with no file behind them, which is what a pasted screenshot is. */
  onAttachBytes?: (name: string, data: Uint8Array) => Promise<void>;
  onRemoveAttachment?: (attachmentId: string) => void;
  /** Re-points the conversation. Absent until there is a conversation to re-point: before that the
   *  chip writes the workspace's chat routing itself, which is what the next question will run on.
   *  `account` is passed only when one was picked. */
  onPickEngine?: (provider: string, model: string, account?: string) => void | Promise<void>;
  /** The empty state's flow pick (`null` back to the model): held by the view and applied to the
   *  conversation the first message creates, the way the effort is. Once there is a conversation
   *  `onPickEngine` re-points that one instead. */
  onPickFlow?: (flowId: string | null) => void;
  /** Where a pick goes that this thread cannot take — a model on a thread a flow has answered (the
   *  backend refuses to move a thread with messages to another provider), a flow on one an engine
   *  has: the engine of a new chat, held on the empty state until its first message. */
  onNewChatOn?: (provider: string, model: string) => void;
  /** A version of a provider this thread is locked out of, picked anyway: where it goes instead —
   *  "continuar en un hilo nuevo" on that engine. */
  onContinueOn?: (provider: string, model: string, account?: string) => void;
  /** The conversation's account — `null` for the system one; absent before there is a conversation. */
  account?: string | null;
  onPickEffort?: (effort: string) => void | Promise<void>;
  sending: boolean;
  cancelling?: boolean;
  /** Turns already in this conversation — the Cline cost hint reads it. */
  turns: number;
  draft: string;
  onDraftChange: (value: string) => void;
  /** `skill` is the one picked from the `/` menu for this message, if any. */
  onSend: (message: string, skill?: SkillPick | null) => void;
  onStop: () => void;
  /** Runs one of the app's own commands. `args` is whatever followed the name, empty for the
   *  commands that take none — see `appCommandFor`. */
  onRunAppCommand: (command: ChatAppCommand, args: string) => void;
  onOpenTerminal?: () => void;
  /** How full this conversation's context is, and the compaction control. Absent where there is
   *  nothing to measure — an empty composer, or the ask box, which is one question and no thread. */
  context?: ContextReading;
  /** The conversation's answer-compression mode, when it is in one. Absent — and drawing nothing —
   *  is the ordinary state; the mode is entered from the `/` menu. */
  caveman?: { level: string; levels: string[]; onPick: (level: string) => void };
  disabled?: boolean;
  disabledReason?: string;
  /** Which composer this is — decides which app commands the `/` menu offers. */
  surface?: CommandSurface;
  /** Whose skills the `/` menu offers. Absent where a surface takes no skill (the ask box). */
  skillScope?: { accountId?: string | null; workspaceId?: string | null; conversationId?: string | null };
  /** This conversation's queue — what was sent while a turn ran. Absent where there is no
   *  conversation to wait behind (the empty state), and then a running turn refuses a second
   *  message as it always did. */
  queue?: ComposerQueue;
}) {
  const t = useT();
  /** The box's own Cut / Copy / Paste, in place of the webview's menu. */
  const textMenu = useTextMenu();
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  // The skill staged for the next message. Dropped when the engine changes: a skill is one CLI's,
  // and carrying it across would tell the next engine to use something it may not have.
  const [skill, setSkill] = useState<SkillPick | null>(null);
  useEffect(() => {
    setSkill(null);
  }, [provider]);
  const caps = providerCapabilities(provider);

  useAutosizeTextarea(boxRef, draft, MAX_COMPOSER_HEIGHT);

  /**
   * `Mod+L` — the chord `chat.placeholder` has been promising in both languages since long before
   * anything implemented it.
   *
   * `uiStore.chatComposerFocus` is a counter rather than a flag, and the counter is why this works:
   * "focus the composer" is an *imperative*, and an imperative modelled as a boolean has to be
   * cleared by whoever obeyed it — which means a second press before the clear lands is swallowed,
   * and a remount replays the stale `true`. A monotonically increasing number has neither problem:
   * every press is a distinct value, and the comparison below is against what this component last
   * saw rather than against a shared reset nobody owns.
   *
   * Seeded from the current value so mounting is not itself a focus. The composer is remounted
   * whenever the view crosses between its empty state and an open conversation, and stealing the
   * caret on that transition would take it away from whatever the user was actually doing.
   */
  const focusTick = useUiStore((s) => s.chatComposerFocus);
  const lastFocusTick = useRef(focusTick);
  useEffect(() => {
    if (focusTick === lastFocusTick.current) return;
    lastFocusTick.current = focusTick;
    const el = boxRef.current;
    if (!el) return;
    el.focus();
    // To the end, not to wherever the caret last was: the chord means "let me type", and landing
    // mid-word in a draft is a small, repeatable annoyance.
    el.setSelectionRange(el.value.length, el.value.length);
  }, [focusTick]);

  const submit = useCallback(() => {
    const trimmed = draft.trim();
    // A running turn stops nothing when there is a queue to put the message in — see the note on
    // the component. Commands pass through too: the view decides which ones wait their turn.
    if (!trimmed || (sending && !queue) || disabled) return;
    // A typed command runs instead of being sent. Until this existed, pressing Enter on `/compact`
    // sent those seven characters to the model — the menu could only be used by clicking a row,
    // which is the one way nobody uses a slash command. See `appCommandFor` for what counts as one;
    // anything that does not is an ordinary message, including a line that merely starts with `/`.
    const command = appCommandFor(trimmed, surface);
    if (command) {
      onDraftChange("");
      onRunAppCommand(command.id, command.args);
      return;
    }
    onSend(trimmed, skill);
    onDraftChange("");
    setSkill(null);
  }, [draft, sending, queue, disabled, onSend, onDraftChange, onRunAppCommand, surface, skill]);

  /** «Dictar»'s stop-and-send runs the submit of the render that already holds the transcript. */
  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => registerDictationSend(boxRef.current, () => submitRef.current()));
  /** While this box records, the bar takes the toolbar's place — the controls are the recording's. */
  const dictating = useDictatingHere(boxRef);

  /**
   * The queue as the strip is handed it, with "edit" finished here: the store takes the message out
   * of the queue (and puts its files back on the tray), and the box — which is this component's —
   * gets the text and the skill.
   *
   * In front of whatever is already in the box, on a line of its own: it was written first, and
   * merging it into the middle of a half-written sentence would be the one way to make it worse.
   */
  const shownQueue = useMemo<ComposerQueue | undefined>(() => {
    if (!queue) return undefined;
    return {
      ...queue,
      onEdit: (id) => {
        const item = queue.onEdit(id);
        if (!item) return null;
        onDraftChange(draft.trim() ? `${item.text}\n${draft}` : item.text);
        if (item.skill) setSkill(item.skill);
        boxRef.current?.focus();
        return item;
      },
    };
  }, [queue, draft, onDraftChange]);

  /** The `/` menu is open while the draft is a single token beginning with a slash. It closes the
   *  moment a space is typed, because by then the user is writing arguments, not choosing. */
  const slash = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1).toLowerCase() : null;
  const menuOpen = slash !== null && !slash.includes(" ");

  /**
   * An image arriving by paste, stored rather than refused.
   *
   * This used to put up a notice explaining that a pasted image has no file on disk and that the
   * user should use the attach button instead — which was true about the CLIs and unhelpful about
   * the app, since the app is perfectly able to write the bytes to a file itself. It now does:
   * the clipboard's bytes are saved into the conversation's own folder and the engine is handed
   * that path, which is the same route the attach button takes.
   *
   * What is still said out loud is the part that remains true: on a provider that cannot *see* an
   * image, the file is stored and named but the model will read it as bytes rather than look at it.
   * The chip says so. Silently swallowing the paste is the one behaviour worth avoiding — an image
   * that vanishes looks like the app lost it, and the next thing the user does is describe the
   * screenshot in words to a model they believe already has it.
   */
  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const image = Array.from(event.clipboardData.items).find((item) => item.type.startsWith("image/"));
    if (!image) return;
    const file = image.getAsFile();
    if (!file) return;
    event.preventDefault();
    if (!onAttachBytes) {
      // The ask box is the only surface that reaches this, and it declines files on purpose. Said
      // out loud rather than swallowed: an image that vanishes on paste reads as the app losing it.
      setImageNotice(t("chat.attachNotHere"));
      return;
    }
    setImageNotice(caps.acceptsImages ? null : t("chat.attachImageBlind"));
    void file.arrayBuffer().then((buffer) => {
      // The clipboard gives no filename, so one is made from the mime type. The extension matters:
      // it is how the backend decides this is an image, and how several engines decide what they
      // are looking at.
      const extension = (file.type.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "") || "png";
      void onAttachBytes(`pegado.${extension}`, new Uint8Array(buffer));
    });
  };

  const attach = async () => {
    if (!onAttachPath) return;
    // No extension filter. The old one offered images only, which was the narrower half of what
    // actually works: every engine here has a file-reading tool, so a log, a CSV or a PDF is the
    // case that works *everywhere*, while an image is the case only some can see.
    const picked = await openDialog({ multiple: true });
    const paths = typeof picked === "string" ? [picked] : Array.isArray(picked) ? picked : [];
    if (paths.length === 0) return;
    setImageNotice(null);
    for (const path of paths) {
      await onAttachPath(path);
    }
    boxRef.current?.focus();
  };

  const stopping = sending && cancelling;

  return (
    <div className="shrink-0 pb-4 pt-1">
      <div className={`${READING_COLUMN} ${COLUMN_GUTTER}`}>
        {menuOpen && (
          <CommandMenu
            query={slash ?? ""}
            provider={provider}
            surface={surface}
            // A conversation stamped with no account runs as the system one, which is not the same
            // question as "automatic" — resolution could land on a default account instead.
            scope={{ ...skillScope, accountId: account === null ? "system" : (account ?? skillScope?.accountId ?? null) }}
            onRunApp={(command) => {
              onDraftChange("");
              // No arguments from a click: the row was picked before anything could be typed after
              // it. `/compact` with a steer is reached by typing it, which `submit` handles.
              onRunAppCommand(command, "");
            }}
            onInsert={(name) => {
              onDraftChange(`${name} `);
              boxRef.current?.focus();
            }}
            onPickSkill={
              skillScope
                ? (picked) => {
                    // A Claude skill that forbids the model from starting it runs only when a
                    // person types it, so it goes into the message as its own slash command.
                    if (!picked.model_invocable && provider === "claude") {
                      onDraftChange(`/${picked.name} `);
                    } else {
                      setSkill({ name: picked.name, source: picked.source, path: picked.path });
                      onDraftChange("");
                    }
                    boxRef.current?.focus();
                  }
                : undefined
            }
            onOpenTerminal={onOpenTerminal}
          />
        )}

        {imageNotice && (
          <div className="cf-fade-in mb-1.5 flex items-start gap-2 rounded-lg border border-[var(--cf-warning)]/40 bg-[color-mix(in_oklab,var(--cf-warning)_10%,transparent)] px-3 py-1.5 text-[12px] leading-relaxed text-[var(--cf-text)]">
            <span className="flex-1">{imageNotice}</span>
            <button
              type="button"
              onClick={() => setImageNotice(null)}
              className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              ×
            </button>
          </div>
        )}

        {shownQueue && <QueuedMessages queue={shownQueue} />}

        <div
          data-tour="chat-composer"
          className="flex flex-col gap-1.5 rounded-2xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2 shadow-[var(--cf-shadow)] focus-within:border-[color-mix(in_oklab,var(--cf-accent)_45%,var(--cf-border))]"
        >
          {/* Above the input, not below it: the chips are context for what is about to be sent, and a
              row that appears under the send button reads as a result rather than as an ingredient. */}
          <AttachmentBar
            files={attachments}
            canSeeImages={caps.acceptsImages}
            onRemove={(id) => onRemoveAttachment?.(id)}
          />
          {skill && <SkillChip name={skill.name} onRemove={() => setSkill(null)} />}
          <textarea
            ref={boxRef}
            data-ai-input="inline"
            value={draft}
            rows={1}
            disabled={disabled}
            onChange={(e) => onDraftChange(e.target.value)}
            onPaste={onPaste}
            onContextMenu={textMenu.onField}
            onKeyDown={(e) => {
              // `isComposing` covers the IME case; `keyCode === 229` is the same condition for the
              // browsers that still report composition that way, and costs one comparison.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              disabled
                ? disabledReason
                : sending && queue
                  ? t("chat.queuePlaceholder")
                  : t("chat.composerPlaceholder")
            }
            className="max-h-[260px] resize-none bg-transparent px-2 py-1 text-[14px] leading-[1.6] outline-none placeholder:text-[var(--cf-text-muted)] disabled:opacity-60"
          />
          {textMenu.menu}

          {dictating ? (
            <div className="flex items-center gap-1.5 px-0.5">
              <DictationBar />
            </div>
          ) : (
          <div className="flex items-center gap-1.5 px-0.5">
            {/* `bound` is what makes this chip tell the truth: the conversation's engine, not the
                workspace's chat routing. Without it the padlock lands on the provider the thread is
                actually running on, because "locked" is computed against the routing. */}
            {/* A box of its own only so the Chat tour has something with a size to point at. */}
            <div data-tour="chat-model" className="flex min-w-0 shrink items-center">
              <ChatModelPicker
                liveModel={null}
                chatActive={turns > 0 && provider !== "flow"}
                // On a flow the chip offers the models to go back to — the routing's, not the thread's.
                bound={onPickEngine && provider !== "flow" ? { provider, model, account } : undefined}
                onPick={
                  provider === "flow" && turns > 0 && onPickEngine
                    ? (next, version, picked) =>
                        onNewChatOn
                          ? onNewChatOn(next, version)
                          : Promise.resolve(onPickEngine(next, version, picked)).catch((error: unknown) => pushErrorToast(String(error)))
                    : onPickEngine
                }
                onLockedPick={onContinueOn}
              />
              {onPickEngine ? (
                <FlowAssistantPicker
                  provider={provider}
                  model={model}
                  locked={turns > 0 && provider !== "flow"}
                  onPick={(next, flow) => onPickEngine(next, flow)}
                  onLocked={onNewChatOn ? (flow) => onNewChatOn("flow", flow) : undefined}
                />
              ) : (
                onPickFlow && (
                  <FlowAssistantPicker provider={provider} model={model} locked={false} onPick={(_, flow) => onPickFlow(flow)} onLeave={() => onPickFlow(null)} />
                )
              )}
            </div>

            {onPickEffort && (
              <EffortPicker
                value={effort}
                supported={effortSupported}
                disabled={disabled}
                onPick={onPickEffort}
              />
            )}

            {/* Beside the reasoning dial because they answer the same shape of question — what is
                this engine going to do with my request — and because the one thing people get
                wrong about this workspace is what a repo-less chat may touch. */}
            <ChatCapabilities
              provider={provider}
              effortSupported={effortSupported}
              canWriteFiles={canWriteFiles}
            />
            {/* The user's own MCP servers, switched per conversation. Only where a conversation can
                be named — the ask box has none — and said to be unavailable, not hidden, on a turn
                that may not write: those load no server at all. */}
            {skillScope && (
              <McpMenu
                provider={provider}
                scope={{
                  ...skillScope,
                  accountId: account === null ? "system" : (account ?? skillScope.accountId ?? null),
                }}
                unavailableReason={canWriteFiles ? undefined : t("chat.mcpReadOnly")}
              />
            )}

            {/* Last of the four, and deliberately the one nearest the send button: it is the only
                control here that describes what the *next* press will cost rather than how it will
                behave. */}
            {context && <ContextMeter reading={context} />}

            {/* Left of the paperclip and right of the meter, which puts the two things that change
                what the *answer* looks like next to each other and keeps the two that act on this
                message — attach, send — together at the end. Renders nothing when the mode is off. */}
            {caveman && (
              <CavemanChip level={caveman.level} levels={caveman.levels} onPick={caveman.onPick} />
            )}

            {/* Absent rather than disabled where the surface takes no files at all — the ask box,
                and nothing else. The same rule the reasoning dial follows: a control that cannot do
                anything is worse than no control, and this one spent a version explaining that you
                had to send a message first, on a composer whose whole job is the message you have
                not sent yet. */}
            {onAttachPath && (
              <button
                type="button"
                onClick={() => void attach()}
                disabled={disabled}
                title={
                  caps.acceptsImages
                    ? t("chat.attach")
                    : t("chat.attachTextOnly", { provider: providerDisplayLabel(provider, t) })
                }
                aria-label={t("chat.attach")}
                className="flex h-[26px] w-[26px] items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:cursor-not-allowed disabled:opacity-30"
              >
                <Paperclip size={15} />
              </button>
            )}

            {sending ? (
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* Only while there is something to queue: an idle box has nothing for it to do,
                    and Enter already does the same. Beside Stop rather than instead of it — both
                    are live for the whole turn, and neither should move under the hand. */}
                {queue && draft.trim() && (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={disabled}
                    title={t("chat.queueAdd")}
                    aria-label={t("chat.queueAdd")}
                    className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
                  >
                    <ListPlus size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onStop}
                  disabled={stopping}
                  className="flex h-[26px] shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] transition-colors hover:text-[var(--cf-danger)] hover:shadow-[inset_0_0_0_1px_var(--cf-danger)] disabled:opacity-50"
                >
                  <Square size={9} className="fill-current" />
                  {stopping ? t("ai.stopping") : t("chat.stop")}
                </button>
              </div>
            ) : (
              <div className="ml-auto flex shrink-0 items-center gap-1.5">
                {/* Beside send, where the desktop chat apps put it: dictating is another way of
                    writing the message that button sends. Absent until dictation is installed. */}
                <DictationMic field={boxRef} />
                <button
                  type="button"
                  onClick={submit}
                  disabled={!draft.trim() || disabled}
                  title={t("chat.send")}
                  aria-label={t("chat.send")}
                  className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] transition-colors hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))] disabled:opacity-40"
                >
                  <ArrowUp size={15} />
                </button>
              </div>
            )}
          </div>
          )}
        </div>

        {/* Nothing under the box. The strip that used to live here listed what the engine could not
            do — no typing, resume-by-last-conversation, no images — and it was permanent chrome for
            facts that matter when you *choose* a provider, not on every glance at a chat you are
            already having.

            The one hazard worth keeping is not lost with it: a Gemini conversation that can pull in
            another chat's context is marked on its own row in the sidebar (`crossTalk` in
            `ConversationSidebar`), which is where two of them are visible side by side and where
            the warning can actually be acted on. */}
      </div>
    </div>
  );
}

/** The skill staged for the next message, above the box like an attachment: it is an ingredient of
 *  what is about to be sent, and it can be taken back until then. */
export function SkillChip({ name, onRemove }: { name: string; onRemove: () => void }) {
  const t = useT();
  return (
    <div className="flex px-1">
      <span
        title={t("chat.skillPicked")}
        className="flex max-w-full items-center gap-1 rounded-md border border-[var(--cf-border)] bg-[var(--cf-press)] py-0.5 pl-1.5 pr-0.5 text-[11.5px] text-[var(--cf-text)]"
      >
        <Puzzle size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 truncate font-mono">{name}</span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("chat.skillRemove")}
          title={t("chat.skillRemove")}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <X size={10} />
        </button>
      </span>
    </div>
  );
}
