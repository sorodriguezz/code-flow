import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { localAiCancelCompletion, localAiComplete } from "../../lib/tauri/localaiCommands";
import { completionIsUsable, useLocalAiStore } from "../../state/localAiStore";

/**
 * Ghost text in a chat box, from the same local model the editor completes with.
 *
 * Only where the feature is on: [`completionIsUsable`] is the same gate the editor's provider
 * asks on every keystroke — the switch in Settings, a model on disk, an engine to run it, and no
 * battery saving — so turning local completion off turns this off too, with nothing of its own to
 * configure.
 *
 * # Rules, copied from the editor's
 *
 * - **Only at the end of the draft, on a line with something on it.** A chat box is written front
 *   to back; ghost text in the middle of a sentence being corrected is noise.
 * - **Not while deleting**, not while the `@` or `/` menu is open (the caller says so through
 *   `suppressed`), and never for a slash command.
 * - **Typing along a suggestion asks nothing** — the remainder is served from memory, as in the
 *   editor's `reuse`.
 * - **One line at a time.** The Rust side stops at the first newline (`multiline: false`) and
 *   drops an answer that only repeats the line above.
 *
 * # The prompt
 *
 * The models are code models fed fill-in-the-middle, so the draft is the prefix and the suffix is
 * empty. A two-line draft on its own says little, so it goes in as the last turn of a short
 * transcript — where the chat is, and the tail of the assistant's last answer — which is what lets
 * the model pick up a function or file name the conversation has already used.
 *
 * Keys: Tab takes the whole suggestion, Ctrl/Cmd+→ the next word, Esc hides it.
 */

/** Milliseconds of quiet before asking. The editor's `DEBOUNCE_MS`, for the same reason. */
const DEBOUNCE_MS = 300;

/** How long a request may run before the status bar says so — the editor's `THINKING_AFTER_MS`. */
const THINKING_AFTER_MS = 300;

/** Characters of the draft sent: plenty for a message, and a bound for a pasted log. */
const DRAFT_CHARS = 4000;

/** Characters of the last answer sent as context: its end, which is what the reply answers. */
const ANSWER_CHARS = 1500;

/** Below this many characters on the caret's line there is nothing to continue yet. */
const MIN_LINE_CHARS = 3;

/** Whether a draft with the caret at `start`–`end` should be completed at all. Pure, for tests. */
export function ghostWanted(text: string, start: number, end: number): boolean {
  if (start !== end || end !== text.length) return false;
  if (text.trimStart().startsWith("/")) return false;
  const line = text.slice(text.lastIndexOf("\n") + 1);
  return line.trim().length >= MIN_LINE_CHARS;
}

/** What remains of `memo`'s suggestion after typing from `memo.prefix` to `text`, or `null`. */
export function ghostRemainder(memo: { prefix: string; text: string } | null, text: string): string | null {
  if (!memo || !text.startsWith(memo.prefix)) return null;
  const typed = text.slice(memo.prefix.length);
  if (!memo.text.startsWith(typed)) return null;
  const rest = memo.text.slice(typed.length);
  return rest.length > 0 ? rest : null;
}

/** The leading word of a suggestion, with the space before it: what Ctrl/Cmd+→ accepts. */
export function ghostWord(ghost: string): string {
  return /^\s*\S+/.exec(ghost)?.[0] ?? ghost;
}

/** The prefix handed to the model: a short transcript ending in the draft. Pure, for tests. */
export function ghostPrompt(draft: string, context: { place: string; lastAnswer?: string | null }): string {
  const answer = (context.lastAnswer ?? "").trim();
  const tail = answer.length > ANSWER_CHARS ? `…${answer.slice(-ANSWER_CHARS)}` : answer;
  const body = draft.length > DRAFT_CHARS ? draft.slice(-DRAFT_CHARS) : draft;
  const lines = [`<!-- A developer's chat with an AI coding assistant about ${context.place}. -->`, ""];
  if (tail) lines.push(`Assistant: ${tail}`, "");
  lines.push(`User: ${body}`);
  return lines.join("\n");
}

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
}

export function useComposerGhost({
  boxRef,
  text,
  setText,
  context,
  suppressed = false,
}: {
  boxRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  setText: (text: string) => void;
  /** Where the chat is ("the repository «x»") and the last answer, if any. */
  context: { place: string; lastAnswer?: string | null };
  /** A menu that owns Tab and Esc is open. */
  suppressed?: boolean;
}) {
  const [ghost, setGhost] = useState<string | null>(null);
  const memo = useRef<{ prefix: string; text: string } | null>(null);
  const previous = useRef(text);
  const inFlight = useRef<string | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;

  // `completionIsUsable` reads the store; without a load it answers "no" until Settings is opened.
  useEffect(() => {
    void useLocalAiStore.getState().load();
  }, []);

  const cancel = useCallback(() => {
    const id = inFlight.current;
    inFlight.current = null;
    if (id) void localAiCancelCompletion(id).catch(() => {});
  }, []);

  useEffect(() => {
    const deleting = text.length < previous.current.length && previous.current.startsWith(text);
    previous.current = text;
    cancel();

    const box = boxRef.current;
    const at = box ? [box.selectionStart, box.selectionEnd] : [text.length, text.length];
    if (suppressed || deleting || !completionIsUsable() || !ghostWanted(text, at[0], at[1])) {
      setGhost(null);
      return;
    }
    const remembered = ghostRemainder(memo.current, text);
    if (remembered) {
      setGhost(remembered);
      return;
    }
    setGhost(null);

    let live = true;
    const timer = setTimeout(() => {
      const requestId = newRequestId();
      inFlight.current = requestId;
      const slow = setTimeout(() => useLocalAiStore.getState().setThinking(true), THINKING_AFTER_MS);
      localAiComplete({
        request_id: requestId,
        prefix: ghostPrompt(text, contextRef.current),
        suffix: "",
        multiline: false,
        indent: 0,
      })
        .then((answer) => {
          if (!live || inFlight.current !== requestId || !answer) return;
          memo.current = { prefix: text, text: answer };
          setGhost(answer);
        })
        // A keystroke must never raise anything; the settings pane explains a broken engine.
        .catch(() => {})
        .finally(() => {
          clearTimeout(slow);
          useLocalAiStore.getState().setThinking(false);
          if (inFlight.current === requestId) inFlight.current = null;
        });
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text, suppressed, boxRef, cancel]);

  // The caret leaving the end, or the box losing focus, takes the suggestion away.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const check = () => {
      if (box.selectionStart !== box.value.length || box.selectionEnd !== box.value.length) setGhost(null);
    };
    const hide = () => {
      cancel();
      setGhost(null);
    };
    box.addEventListener("keyup", check);
    box.addEventListener("mouseup", check);
    box.addEventListener("blur", hide);
    return () => {
      box.removeEventListener("keyup", check);
      box.removeEventListener("mouseup", check);
      box.removeEventListener("blur", hide);
    };
  }, [boxRef, cancel]);

  useEffect(() => cancel, [cancel]);

  const take = useCallback(
    (piece: string) => {
      const next = text + piece;
      setText(next);
      requestAnimationFrame(() => {
        const box = boxRef.current;
        if (box) box.setSelectionRange(next.length, next.length);
      });
    },
    [text, setText, boxRef],
  );

  /** Call before the box's own key handling; `true` means the key was taken. */
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!ghost || suppressed || e.nativeEvent.isComposing) return false;
      if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        take(ghost);
        return true;
      }
      if (e.key === "ArrowRight" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        take(ghostWord(ghost));
        return true;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
        memo.current = null;
        setGhost(null);
        return true;
      }
      return false;
    },
    [ghost, suppressed, take, cancel],
  );

  return { ghost, onKeyDown };
}

/**
 * Draws `ghost` after `text`, laid out exactly like the textarea it sits behind.
 *
 * Put it in a `relative` wrapper *before* the textarea, whose background is transparent: the ghost
 * shows through, and the caret, selection and clicks stay the textarea's. The metrics are copied
 * from the textarea's computed style rather than restated, so the wrap points match whatever
 * classes each composer gives its box.
 */
export function GhostOverlay({
  boxRef,
  text,
  ghost,
}: {
  boxRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  ghost: string | null;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({});

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !ghost) return;
    const css = getComputedStyle(box);
    const borders = parseFloat(css.borderLeftWidth) + parseFloat(css.borderRightWidth);
    // A scrollbar narrows the textarea's text column; the layer has none, so it pads by as much.
    const scrollbar = Math.max(0, box.offsetWidth - box.clientWidth - borders);
    setStyle({
      font: css.font,
      letterSpacing: css.letterSpacing,
      lineHeight: css.lineHeight,
      paddingTop: css.paddingTop,
      paddingBottom: css.paddingBottom,
      paddingLeft: css.paddingLeft,
      paddingRight: `calc(${css.paddingRight} + ${scrollbar}px)`,
      borderWidth: css.borderWidth,
      borderStyle: "solid",
      borderColor: "transparent",
      tabSize: css.tabSize,
    });
    const layer = layerRef.current;
    if (layer) layer.scrollTop = box.scrollTop;
  }, [boxRef, text, ghost]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const sync = () => {
      if (layerRef.current) layerRef.current.scrollTop = box.scrollTop;
    };
    box.addEventListener("scroll", sync);
    return () => box.removeEventListener("scroll", sync);
  }, [boxRef]);

  if (!ghost) return null;
  return (
    <div
      ref={layerRef}
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words"
      style={style}
    >
      <span className="text-transparent">{text}</span>
      <span className="text-[var(--cf-text-muted)] opacity-70">{ghost}</span>
    </div>
  );
}
