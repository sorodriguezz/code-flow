import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { eventToChord, type Chord } from "./keys";

/** A point the field can be put back to: the text, and where the caret sat once it was there. */
export interface TextSnapshot {
  value: string;
  start: number;
  end: number;
}

/** Consecutive keystrokes closer together than this undo as one step. Long enough that ordinary
 *  typing collapses into words, short enough that a pause reads as "I finished that thought". */
const BURST_MS = 600;

/** Steps a field remembers. Deep enough to walk back a session's worth of edits, bounded because
 *  every step holds a full copy of the text. */
const DEPTH = 200;

const UNDO: Chord = "Mod+Z";
/** Both spellings: `Mod+Y` is what Windows taught everyone, `Mod+Shift+Z` what macOS did. */
const REDO: Chord[] = ["Mod+Y", "Mod+Shift+Z"];

/**
 * Whether `next` continues the run of typing that produced `prev` — one character added or removed
 * exactly where the previous edit left the caret. A click elsewhere, a selection, or a paste all
 * fail this, which is what makes them their own undo step.
 */
function continues(prev: TextSnapshot, next: TextSnapshot): boolean {
  if (prev.start !== prev.end || next.start !== next.end) return false;
  const grew = next.value.length - prev.value.length;
  if (grew === 1) return next.start === prev.start + 1;
  if (grew === -1) return next.start === prev.start - 1;
  return false;
}

/** A run of typing ends at whitespace, so undo steps back a word at a time rather than a paragraph. */
function endsRun(prev: TextSnapshot, next: TextSnapshot): boolean {
  if (next.value.length !== prev.value.length + 1) return false;
  return /\s/.test(next.value[next.start - 1] ?? "");
}

/**
 * Undo and redo for an `<input>` or `<textarea>` whose value lives in React state.
 *
 * The browser gives a field its own undo stack for free, but only while it is the one changing the
 * text. A controlled field whose value is written back from a store — and whose toolbar rewrites
 * the selection wholesale — desyncs that stack the first time anything but a keystroke touches it:
 * Ctrl+Z then either does nothing or restores a version the field never showed. So the field keeps
 * its own history, and swallows the chords rather than letting the native stack answer them.
 *
 * The field reports every edit it makes through `record`; `undo`/`redo` hand the text back through
 * `write` and put the caret where it was. `resetKey` is the identity of what is being edited: when
 * the same field is pointed at another item's text, the history starts over, because a step that
 * restored the previous item's prose into this one would be a data loss dressed up as an undo.
 */
export function useTextHistory({
  value,
  write,
  field,
  enabled,
  resetKey,
  externalWrites = "step",
}: {
  value: string;
  write: (value: string) => void;
  field: RefObject<HTMLInputElement | HTMLTextAreaElement | null>;
  /** Off for a read-only field: nothing to undo, and the write would be refused anyway. */
  enabled: boolean;
  resetKey?: string | number;
  /**
   * What a write the field didn't make means.
   *
   * `"step"` records it, so an overwrite the user never typed can still be undone — what a draft
   * something else writes into needs. `"restart"` throws the history away instead: for a field that
   * is re-pointed at the next item without ever unmounting — the next tab's URL, the next row's
   * header — a write it didn't make *is* the next item arriving, and a step across that boundary
   * would put one request's URL into another. It draws the same line `resetKey` does, without an
   * identity having to be threaded down to every caller to name it.
   *
   * Deliberately not conditioned on focus. A blurred field is the common way the next item lands,
   * but not the only one: switch tabs from the keyboard and the caret never leaves, and the step
   * that buys is exactly the one worth not having.
   */
  externalWrites?: "step" | "restart";
}) {
  const state = useRef({
    past: [] as TextSnapshot[],
    future: [] as TextSnapshot[],
    /** Mirrors the `value` prop — what the field is showing right now. */
    now: { value, start: value.length, end: value.length } as TextSnapshot,
    /** When the current run of typing was last extended; `0` closes it. */
    at: 0,
  });
  // Only so the buttons can grey out — the history itself is a ref, because a keystroke that merely
  // extends the current step must not cost a render.
  const [steps, setSteps] = useState({ undo: 0, redo: 0 });
  const latest = useRef(value);
  latest.current = value;

  const publish = () => {
    const s = state.current;
    setSteps((was) =>
      was.undo === s.past.length && was.redo === s.future.length
        ? was
        : { undo: s.past.length, redo: s.future.length },
    );
  };

  const push = (snapshot: TextSnapshot) => {
    const s = state.current;
    s.past.push(snapshot);
    if (s.past.length > DEPTH) s.past.shift();
  };

  /**
   * Remembers an edit the field just made. `merge` marks it as typing, the one kind of edit that
   * joins the run in progress instead of starting a step of its own — a toolbar button that wraps a
   * selection is one press and should be one undo.
   */
  const record = (next: TextSnapshot, merge = false) => {
    if (!enabled) return;
    const s = state.current;
    if (next.value === s.now.value) {
      // The caret moved without the text changing. Worth keeping — the next step should restore the
      // caret to where the user actually is — but it is not a step.
      s.now = next;
      return;
    }
    const when = Date.now();
    if (!(merge && s.at > 0 && when - s.at <= BURST_MS && continues(s.now, next))) push(s.now);
    // Any edit is a new branch: what was undone away is gone the moment something is typed over it.
    s.future = [];
    s.at = merge && !endsRun(s.now, next) ? when : 0;
    s.now = next;
    publish();
  };

  const step = (back: boolean) => {
    const s = state.current;
    const from = back ? s.past : s.future;
    const next = from.pop();
    if (!next) return;
    (back ? s.future : s.past).push(s.now);
    s.now = next;
    s.at = 0;
    write(next.value);
    // After React has put the restored text in the DOM — otherwise the range is set on the old text
    // and the browser clamps it.
    queueMicrotask(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(next.start, next.end);
    });
    publish();
  };

  // Someone other than the field replaced the text — a proposal sent into the draft, a reload from
  // the store. Kept as a step of its own, so an overwrite the user did not type can be undone; or
  // treated as the next item arriving, and the history dropped. See `externalWrites`.
  useEffect(() => {
    const s = state.current;
    if (value === s.now.value) return;
    if (externalWrites === "restart") s.past = [];
    else push(s.now);
    s.future = [];
    s.now = { value, start: value.length, end: value.length };
    s.at = 0;
    publish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  // Declared after the sync above so that when both fire in the same commit — the field pointed at
  // another item, whose text arrives at the same moment — the reset is what survives.
  useEffect(() => {
    const s = state.current;
    s.past = [];
    s.future = [];
    s.now = { value: latest.current, start: latest.current.length, end: latest.current.length };
    s.at = 0;
    publish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return {
    record,
    undo: () => step(true),
    redo: () => step(false),
    canUndo: steps.undo > 0,
    canRedo: steps.redo > 0,
    /**
     * Bound to the field itself rather than to the window: these chords belong to whatever the user
     * is typing into, and the app has no business undoing a field the caret is not in.
     */
    onKeyDown: (e: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (!enabled) return;
      const chord = eventToChord(e.nativeEvent);
      if (!chord) return;
      if (chord !== UNDO && !REDO.includes(chord)) return;
      // Swallowed even with nothing to step to, or the browser answers with its own stale stack.
      e.preventDefault();
      step(chord === UNDO);
    },
  };
}
