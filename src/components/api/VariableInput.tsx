import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { Check, Pencil, X } from "lucide-react";
import {
  DYNAMIC_VARIABLES,
  findUnresolved,
  listVariables,
  lookupVariable,
  type VariableContext,
} from "../../lib/api/variables";
import { useApiStore } from "../../state/apiStore";
import { useTextHistory } from "../../lib/useTextHistory";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { VariableScope } from "../../types/api";

/**
 * A single-line field that marks the `{{variables}}` inside it — accent-tinted when the current
 * scopes define them, danger-tinted when nothing does — completes them as you type, and lets you
 * change what one is worth without leaving the request.
 *
 * Built as a mirrored `<div>` under a real `<input>` rather than a contenteditable: an `<input>`
 * is the only element that gets caret placement, selection, autofill and IME composition right for
 * free, and none of that survives being re-implemented.
 *
 * Undo is the one thing it does *not* get for free. The engine keeps that stack against the DOM
 * node and against the edits it made itself, and this field is written to from the outside
 * constantly — a completion accepted from the menu, a pasted cURL parsed into a whole request, the
 * same component handed the next tab's URL — so ⌘Z/Ctrl+Z answered from that stack restores text
 * the field never showed, when it answers at all. `useTextHistory` keeps the history where the
 * value lives and swallows the chords.
 *
 * The mirror draws **only backgrounds** — the token text in it is transparent, and the visible
 * glyphs are the input's own. The obvious arrangement is the other way round (colour the mirror's
 * text, make the input transparent), and it was: the cost is that selecting text then highlights
 * glyphs that aren't there, so a drag-select looks like it erased the field and ⌘C copies from
 * something invisible. Tinting behind real text keeps native selection, and reads as well.
 */

/** Capturing so `split` keeps the tokens; non-global because `split`/`test` don't want `lastIndex`. */
const TOKEN_SPLIT = /(\{\{[^{}]*\}\})/;
const TOKEN_SCAN = /\{\{([^{}]*)\}\}/g;

/** Enough rows to be worth scrolling, few enough to stay a menu rather than a catalogue. */
const MAX_SUGGESTIONS = 40;

/** How long a hovered variable's card outlives the pointer leaving the token — enough to cross the
 *  gap down into the card without it closing on the way. */
const CARD_GRACE_MS = 160;

const SCOPE_LABELS: Record<VariableScope, TranslationKey> = {
  local: "api.scope.local",
  data: "api.scope.data",
  environment: "api.scope.environment",
  collection: "api.scope.collection",
  global: "api.scope.global",
};

/** Scopes owned by a running script or the runner's data file — there's no stored row behind them
 * to edit, and whatever you typed would be overwritten on the next run. */
const READ_ONLY_SCOPES: VariableScope[] = ["local", "data"];

type SegmentKind = "text" | "resolved" | "unresolved";

interface Segment {
  text: string;
  kind: SegmentKind;
  /** Where the part starts in the value — a token's identity, for hovering and anchoring. */
  start: number;
  /** The variable a token names; absent on plain text. */
  name?: string;
}

/** Tints painted *behind* the real glyphs. Mixed into the surface rather than used at full
 *  strength so the text on top stays readable in both themes. */
const SEGMENT_BACKGROUNDS: Record<SegmentKind, string | undefined> = {
  text: undefined,
  resolved: "color-mix(in oklab, var(--cf-accent) 22%, transparent)",
  unresolved: "color-mix(in oklab, var(--cf-danger) 24%, transparent)",
};

/**
 * Splits `value` into plain runs and variable tokens.
 *
 * "Unresolved" comes from `findUnresolved`, which runs the real resolution rather than a shallow
 * scan — so `{{baseUrl}}` whose *value* references a missing `{{host}}` is flagged too, and
 * `{{$guid}}` is not flagged at all.
 */
function segment(value: string, ctx: VariableContext | null): Segment[] {
  if (!ctx || !value.includes("{{")) return [{ text: value, kind: "text", start: 0 }];
  const unresolved = new Set(findUnresolved(value, ctx));
  const parts: Segment[] = [];
  let start = 0;
  for (const part of value.split(TOKEN_SPLIT)) {
    const at = start;
    start += part.length;
    if (part === "") continue;
    const name = part.startsWith("{{") && part.endsWith("}}") ? part.slice(2, -2).trim() : "";
    parts.push(
      name === ""
        ? { text: part, kind: "text", start: at }
        : { text: part, kind: unresolved.has(name) ? "unresolved" : "resolved", start: at, name },
    );
  }
  return parts;
}

/** A whole `{{token}}` and the variable it names. */
interface TokenRef {
  start: number;
  name: string;
}

/** The complete token the caret sits inside — strictly inside, so a caret parked just after `}}`
 *  belongs to the text that follows rather than to the variable. */
function tokenAround(value: string, caret: number | null): TokenRef | null {
  if (caret === null) return null;
  for (const match of value.matchAll(TOKEN_SCAN)) {
    const start = match.index ?? 0;
    if (caret <= start || caret >= start + match[0].length) continue;
    const name = match[1].trim();
    return name === "" ? null : { start, name };
  }
  return null;
}

/** A `{{` the caret is sitting inside that hasn't been closed yet — what the completion menu
 * completes, and the span it replaces on accept. */
interface OpenToken {
  start: number;
  end: number;
  query: string;
}

/**
 * Finds the token being typed at `caret`, or `null` when the caret isn't inside one.
 *
 * A token counts as "being typed" while no `}}` sits between its `{{` and the caret. The rest of
 * the token after the caret — its closing braces, and the end of its name when the caret is in the
 * middle of one — is swallowed into `end`, so re-editing `{{ba|}}` or `{{DO|MINIO}}` replaces the
 * whole token. It used to swallow only braces that sat right at the caret: accepting a completion in
 * the middle of a name left its tail dangling after the new token, `{{$randomInt}}MINIO}}` (user
 * report). The tail only counts while it could be the rest of a name — no braces, no whitespace —
 * so an unclosed `{{ba|` never reaches forward into the text after it.
 */
function openTokenAt(value: string, caret: number | null): OpenToken | null {
  if (caret === null) return null;
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start === -1) return null;
  const inner = before.slice(start + 2);
  if (inner.includes("}") || inner.includes("{")) return null;
  const after = value.slice(caret);
  const close = after.indexOf("}}");
  const end = close !== -1 && !/[{}\s]/.test(after.slice(0, close)) ? caret + close + 2 : caret;
  return { start, end, query: inner.trim() };
}

interface Suggestion {
  name: string;
  /** Current value, or the example output for a dynamic variable. */
  detail: string;
  badge: string;
  /** A stored variable, so the menu offers to change its current value right there. */
  editable: boolean;
}

export interface VariableInputProps {
  value: string;
  onChange: (value: string) => void;
  /** `null` turns the highlighting, the completion menu and the popover off; the field stays an
   * ordinary input. */
  variableContext?: VariableContext | null;
  placeholder?: string;
  disabled?: boolean;
  /** Wrapper classes — border, background, width. */
  className?: string;
  /**
   * Typography and padding, applied byte-for-byte to both the input and its mirror. Any
   * difference between the two shows up as the caret drifting away from the glyphs, so callers
   * pass one string rather than styling the input directly.
   */
  fieldClassName?: string;
  ariaLabel?: string;
  onPaste?: (e: ClipboardEvent<HTMLInputElement>) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export function VariableInput({
  value,
  onChange,
  variableContext = null,
  placeholder,
  disabled = false,
  className = "",
  fieldClassName = "px-2 py-1.5 text-[12px]",
  ariaLabel,
  onPaste,
  onKeyDown,
}: VariableInputProps) {
  const t = useT();
  const wrapRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);

  const [caret, setCaret] = useState<number | null>(null);
  /** Escape closes the menu for the token being typed; typing anything reopens it. */
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Where to put the caret once React has committed an accepted completion. */
  const pendingCaret = useRef<number | null>(null);
  /** Whether the caret got where it is by typing. Only typing opens the completion menu; a click or
   *  an arrow key that lands inside a `{{token}}` shows that variable's card instead. */
  const [typing, setTyping] = useState(false);
  /** Escape closes the card a click opened, until the caret moves somewhere else. */
  const [cardDismissedAt, setCardDismissedAt] = useState<number | null>(null);

  /** The token under the pointer. Hovering the field shows nothing; hovering a variable shows that
   *  one variable and no other (user's call). Let go after a short grace, so the pointer can travel
   *  from the token down into its card. */
  const [hovered, setHovered] = useState<TokenRef | null>(null);
  const releaseTimer = useRef<number | undefined>(undefined);

  const [editing, setEditing] = useState<string | null>(null);
  /** The token the edit was opened from, so the card stays hung under it while it is edited. */
  const [editingStart, setEditingStart] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // `"restart"` rather than a `resetKey`: this component is re-pointed at the next tab's URL, or
  // the next row's header, without ever unmounting — and it is used in enough places that naming
  // that identity would mean threading a key through every table, panel and auth field to reach it.
  // Every write it doesn't make itself is that boundary, so there is nothing left to name.
  const history = useTextHistory({
    value,
    write: onChange,
    field: inputRef,
    enabled: !disabled,
    externalWrites: "restart",
  });

  const segments = segment(value, variableContext);

  const token = disabled ? null : openTokenAt(value, caret);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!variableContext || !token) return [];
    const query = token.query.toLowerCase();
    const defined: Suggestion[] = listVariables(variableContext).map((variable) => ({
      name: variable.name,
      detail: variable.value,
      badge: t(SCOPE_LABELS[variable.scope]),
      editable: !READ_ONLY_SCOPES.includes(variable.scope),
    }));
    const dynamic: Suggestion[] = DYNAMIC_VARIABLES.map((item) => ({
      name: item.name,
      detail: item.example,
      badge: t("api.env.dynamicVariables"),
      editable: false,
    }));
    // Anything containing the query is a match, but what *starts* with it comes first — typing
    // "id" should offer `id` before `$randomUUID`.
    return [...defined, ...dynamic]
      .filter((item) => item.name.toLowerCase().includes(query))
      .sort((a, b) => {
        const rank = (name: string) => (name.toLowerCase().startsWith(query) ? 0 : 1);
        return rank(a.name) - rank(b.name);
      })
      .slice(0, MAX_SUGGESTIONS);
  }, [variableContext, token?.query, t]); // eslint-disable-line react-hooks/exhaustive-deps

  // An edit in progress wins over the menu: the pencil on a suggestion hands that variable to the
  // card's editor, and the menu would otherwise cover it.
  const menuOpen = editing === null && typing && !dismissed && token !== null && suggestions.length > 0;
  // The variable the caret was *placed* in — by a click or an arrow key, never by typing.
  const caretToken = !typing && variableContext && caret !== cardDismissedAt ? tokenAround(value, caret) : null;
  // One variable at a time: the one being edited, else the one under the pointer, else the one the
  // caret was put in.
  const subject: { start: number | null; name: string } | null =
    editing !== null ? { start: editingStart, name: editing } : (hovered ?? caretToken);
  const cardOpen = !menuOpen && subject !== null && variableContext !== null;

  const startEditing = (name: string, current: string, start: number | null) => {
    setDraft(current);
    setEditingStart(start);
    setEditing(name);
  };

  /** The token whose glyphs sit under `x` — read off the mirror, whose spans lie exactly under the
   *  input's own text (scroll included, since the mirror is translated with it). */
  const tokenUnder = (x: number): TokenRef | null => {
    const spans = mirrorRef.current?.querySelectorAll<HTMLElement>("[data-token-name]");
    for (const span of Array.from(spans ?? [])) {
      const rect = span.getBoundingClientRect();
      if (x >= rect.left && x <= rect.right) {
        return { start: Number(span.dataset.tokenStart), name: span.dataset.tokenName ?? "" };
      }
    }
    return null;
  };
  const holdCard = () => window.clearTimeout(releaseTimer.current);
  const releaseCard = () => {
    window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => setHovered(null), CARD_GRACE_MS);
  };
  useEffect(() => () => window.clearTimeout(releaseTimer.current), []);

  /** The mirror doesn't scroll on its own — it is shifted by whatever the input scrolled. */
  const syncScroll = () => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (input && mirror) mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
  };

  // Typing past the right edge scrolls the input without firing `scroll` in every engine, so the
  // offset is re-read after each committed value as well.
  useEffect(syncScroll, [value]);

  // A fresh token means a fresh menu: the previous Escape shouldn't keep it shut, and the
  // highlight belongs on the best match rather than wherever it was left.
  useEffect(() => {
    setActiveIndex(0);
  }, [token?.query]);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const at = pendingCaret.current;
    pendingCaret.current = null;
    const input = inputRef.current;
    if (!input) return;
    input.setSelectionRange(at, at);
    setCaret(at);
  }, [value]);

  useLayoutEffect(() => {
    if (!menuOpen && !cardOpen) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    let left = rect.left;
    // The card hangs from its own token, not from the field's corner — it is about that variable.
    if (!menuOpen && subject?.start != null) {
      const span = mirrorRef.current?.querySelector<HTMLElement>(`[data-token-start="${subject.start}"]`);
      const tokenRect = span?.getBoundingClientRect();
      if (tokenRect) left = Math.min(Math.max(tokenRect.left, rect.left), rect.right - 24);
    }
    setAnchor({ left, top: rect.bottom, width: rect.width });
  }, [menuOpen, cardOpen, subject?.start, subject?.name, suggestions.length, value]);

  const accept = (name: string) => {
    if (!token) return;
    const next = `${value.slice(0, token.start)}{{${name}}}${value.slice(token.end)}`;
    const caretAfter = token.start + name.length + 4;
    // Not merged into the run of typing that opened the menu: one accepted completion is one press,
    // so it is one undo — back to the half-typed `{{ba`, not back past it.
    history.record({ value: next, start: caretAfter, end: caretAfter });
    pendingCaret.current = caretAfter;
    onChange(next);
  };

  const syncCaret = () => setCaret(inputRef.current?.selectionStart ?? null);

  /** The caret was placed rather than typed there: a variable it lands in shows its card, and the
   *  completion menu waits for the next keystroke. */
  const placeCaret = () => {
    setTyping(false);
    syncCaret();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // First, and ahead of the menu: ⌘Z belongs to the text no matter what is on screen over it.
    // The history swallows the chords it owns, which is what `defaultPrevented` reports back.
    history.onKeyDown(e);
    if (e.defaultPrevented) return;

    if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(e.key)) setTyping(false);

    // The card a click opened closes on Escape, ahead of whatever Escape means to the caller.
    if (e.key === "Escape" && !menuOpen && editing === null && caretToken) {
      e.preventDefault();
      setCardDismissedAt(caret);
      return;
    }

    if (menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((i) => (i + delta + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        accept(suggestions[activeIndex]?.name ?? suggestions[0].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    // The caller's handler runs only on keys the menu didn't claim — Enter must send the request
    // when no completion is on screen, and must not when one is.
    onKeyDown?.(e);
  };

  /** Writes a variable's *current* value — the same field the environment editor and scripts
   * write, and what Postman's inline editor changes. An unresolved name is created in the active
   * environment, or in Globals when none is selected, since that's the only scope guaranteed to
   * exist. */
  const saveValue = async (name: string) => {
    if (!variableContext) return;
    const found = lookupVariable(name, variableContext);
    if (found && READ_ONLY_SCOPES.includes(found.scope)) return;
    // Nothing changed: close without a write (which would also re-enable the row).
    if (found && found.value === draft) {
      setEditing(null);
      return;
    }
    const store = useApiStore.getState();
    const scope: VariableScope = found?.scope ?? (store.activeEnvironmentId ? "environment" : "global");
    setSaving(true);
    try {
      await store.setVariable(scope, name, draft, variableContext.collectionId ?? null);
      setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  /** The card for one variable: its value — itself the way into editing it — its scope, or the editor. */
  const renderCard = (name: string, start: number | null) => {
    if (!variableContext) return null;
    const found = lookupVariable(name, variableContext);
    const dynamic = found ? undefined : DYNAMIC_VARIABLES.find((item) => item.name === name);
    // A generated value has no stored row, and a script/runner one is rewritten on every
    // run — neither is something to hand-edit.
    const editable = !dynamic && !(found && READ_ONLY_SCOPES.includes(found.scope));

    if (editing === name) {
      return (
        <div key={name} className="flex items-center gap-1.5 py-0.5">
          <span className="shrink-0 font-mono text-[11px] text-[var(--cf-accent)]">{name}</span>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            // Leaving the field keeps what was typed, as in the variables quick look — an
            // edit opened from the menu has no hover to close it otherwise.
            onBlur={() => void saveValue(name)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void saveValue(name);
              else if (e.key === "Escape") setEditing(null);
            }}
            aria-label={t("api.env.currentValue")}
            spellCheck={false}
            autoCapitalize="off"
            className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none"
          />
          {/* `mousedown` swallowed on both: a press would blur the field first, and the blur
              saves — so ✗ would have saved what it was meant to throw away. */}
          <button
            type="button"
            disabled={saving}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void saveValue(name)}
            title={t("common.save")}
            className="shrink-0 text-[var(--cf-success)] disabled:opacity-40"
          >
            <Check size={12} />
          </button>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setEditing(null)}
            title={t("common.cancel")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={12} />
          </button>
        </div>
      );
    }

    const shown = found ? found.value : dynamic ? dynamic.example : t("api.env.unresolved");
    const valueStyle = { color: found || dynamic ? "var(--cf-text)" : "var(--cf-danger)" };
    return (
      <div key={name} className="flex items-baseline gap-2 py-0.5">
        <span className="shrink-0 font-mono text-[11px] text-[var(--cf-accent)]">{name}</span>
        {/* The value is itself the way in — a click, not a hunt for the pencil, which used to
            appear only while hovering its row. */}
        {editable ? (
          <button
            type="button"
            onClick={() => startEditing(name, found?.value ?? "", start)}
            title={found ? t("api.env.editValue") : t("api.env.defineValue")}
            className="min-w-0 flex-1 cursor-text truncate rounded px-0.5 text-left font-mono text-[11px] hover:bg-[var(--cf-hover)]"
            style={valueStyle}
          >
            {shown}
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]" style={valueStyle}>
            {shown}
          </span>
        )}
        {(found || dynamic) && (
          <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
            {found ? t(SCOPE_LABELS[found.scope]) : t("api.env.dynamicVariables")}
          </span>
        )}
        {editable && (
          <button
            type="button"
            onClick={() => startEditing(name, found?.value ?? "", start)}
            title={found ? t("api.env.editValue") : t("api.env.defineValue")}
            aria-label={found ? t("api.env.editValue") : t("api.env.defineValue")}
            className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
          >
            <Pencil size={11} />
          </button>
        )}
      </div>
    );
  };

  return (
    <div
      ref={wrapRef}
      // Only a variable's own glyphs open its card — the rest of the field is for typing.
      onPointerMove={(e) => {
        if (!variableContext) return;
        const under = tokenUnder(e.clientX);
        if (under) {
          holdCard();
          setHovered((previous) =>
            previous?.start === under.start && previous.name === under.name ? previous : under,
          );
        } else if (hovered) {
          releaseCard();
        }
      }}
      onPointerLeave={() => {
        if (hovered) releaseCard();
      }}
      className={`relative min-w-0 ${className}`}
    >
      <div
        ref={mirrorRef}
        aria-hidden
        className={`pointer-events-none absolute inset-0 select-none overflow-hidden whitespace-pre leading-5 ${fieldClassName}`}
      >
        {segments.map((part, index) => (
          <span
            key={index}
            // What the pointer is measured against (`tokenUnder`) and the card hangs from.
            data-token-name={part.name}
            data-token-start={part.name !== undefined ? part.start : undefined}
            // The glyphs here are decoration for the input's real ones sitting exactly on top;
            // painting them too would double every stroke and show as a blur.
            style={{
              color: "transparent",
              background: disabled ? undefined : SEGMENT_BACKGROUNDS[part.kind],
              borderRadius: SEGMENT_BACKGROUNDS[part.kind] ? "3px" : undefined,
            }}
          >
            {part.text}
          </span>
        ))}
      </div>

      <input
        ref={inputRef}
        type="text"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        role={menuOpen ? "combobox" : undefined}
        aria-expanded={menuOpen || undefined}
        aria-autocomplete={menuOpen ? "list" : undefined}
        onChange={(e) => {
          setDismissed(false);
          setTyping(true);
          setCardDismissedAt(null);
          const next = e.target.value;
          const start = e.target.selectionStart ?? next.length;
          // `merge`: consecutive keystrokes collapse into one step, so ⌘Z takes back a word rather
          // than a character. A paste or a replaced selection fails that test on its own.
          history.record({ value: next, start, end: e.target.selectionEnd ?? start }, true);
          onChange(next);
          setCaret(e.target.selectionStart);
        }}
        onSelect={syncCaret}
        onClick={placeCaret}
        onFocus={placeCaret}
        onBlur={() => setCaret(null)}
        onScroll={syncScroll}
        onPaste={onPaste}
        onKeyDown={handleKeyDown}
        className={`relative w-full select-text bg-transparent leading-5 text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] disabled:cursor-not-allowed disabled:text-[var(--cf-text-muted)] ${fieldClassName}`}
      />

      {menuOpen &&
        anchor &&
        createPortal(
          <div
            style={{ position: "fixed", left: anchor.left, top: anchor.top + 4, minWidth: Math.min(anchor.width, 460) }}
            // `mousedown` is what blurs the input, and a blur clears the caret and closes this
            // menu before the click ever lands — so the press is swallowed and the click handled.
            onMouseDown={(e) => e.preventDefault()}
            className="z-[9999] max-h-[240px] max-w-[560px] overflow-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-[var(--cf-shadow)]"
          >
            {suggestions.map((item, index) => (
              <div
                key={`${item.badge}:${item.name}`}
                onPointerEnter={() => setActiveIndex(index)}
                className={`flex w-full items-center rounded ${index === activeIndex ? "bg-[var(--cf-accent-soft)]" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => accept(item.name)}
                  className="flex min-w-0 flex-1 items-baseline gap-2 px-1.5 py-1 text-left"
                >
                  <span className="shrink-0 font-mono text-[11px] text-[var(--cf-accent)]">{item.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                    {item.detail}
                  </span>
                  <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                    {item.badge}
                  </span>
                </button>
                {/* The fast way to a new value: straight from the list, without inserting anything or
                    going to the environment. Only the current value changes — see `saveValue`. */}
                {item.editable && (
                  <button
                    type="button"
                    onClick={() => startEditing(item.name, item.detail, null)}
                    title={t("api.env.editValue")}
                    aria-label={`${t("api.env.editValue")} — ${item.name}`}
                    className="mr-1 shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-accent)]"
                  >
                    <Pencil size={11} />
                  </button>
                )}
              </div>
            ))}
            <p className="px-1.5 pb-0.5 pt-1 text-[10.5px] text-[var(--cf-text-muted)]">{t("api.env.suggestHint")}</p>
          </div>,
          document.body,
        )}

      {cardOpen &&
        variableContext &&
        subject &&
        anchor &&
        createPortal(
          <div
            style={{ position: "fixed", left: anchor.left, top: anchor.top + 4, minWidth: 240 }}
            onPointerEnter={holdCard}
            onPointerLeave={releaseCard}
            // A card a click opened lives on the field's caret: a press anywhere in it would blur the
            // field and take the card away before the click landed. The editor's own input is the
            // one thing that must take the focus.
            onMouseDown={(e) => {
              if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
            }}
            className="z-[9998] max-w-[520px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2 shadow-[var(--cf-shadow)]"
          >
            {renderCard(subject.name, subject.start)}
          </div>,
          document.body,
        )}
    </div>
  );
}
