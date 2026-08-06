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
  if (!ctx || !value.includes("{{")) return [{ text: value, kind: "text" }];
  const unresolved = new Set(findUnresolved(value, ctx));
  return value
    .split(TOKEN_SPLIT)
    .filter((part) => part !== "")
    .map((part): Segment => {
      if (!part.startsWith("{{") || !part.endsWith("}}")) return { text: part, kind: "text" };
      const name = part.slice(2, -2).trim();
      if (name === "") return { text: part, kind: "text" };
      return { text: part, kind: unresolved.has(name) ? "unresolved" : "resolved" };
    });
}

/** Distinct variable names in first-appearance order — one popover row each. */
function variableNames(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(TOKEN_SCAN)) {
    const name = match[1].trim();
    if (name !== "" && !names.includes(name)) names.push(name);
  }
  return names;
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
 * A token counts as "being typed" while no `}}` sits between its `{{` and the caret. The closing
 * braces that editors auto-pair, or that a previous accept left behind, are swallowed into `end`
 * so re-editing `{{ba|}}` replaces the whole token instead of nesting a second one inside it.
 */
function openTokenAt(value: string, caret: number | null): OpenToken | null {
  if (caret === null) return null;
  const before = value.slice(0, caret);
  const start = before.lastIndexOf("{{");
  if (start === -1) return null;
  const inner = before.slice(start + 2);
  if (inner.includes("}") || inner.includes("{")) return null;
  const end = value.slice(caret).startsWith("}}") ? caret + 2 : caret;
  return { start, end, query: inner.trim() };
}

interface Suggestion {
  name: string;
  /** Current value, or the example output for a dynamic variable. */
  detail: string;
  badge: string;
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
  const [hovering, setHovering] = useState(false);
  const [popoverHover, setPopoverHover] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);

  const [caret, setCaret] = useState<number | null>(null);
  /** Escape closes the menu for the token being typed; typing anything reopens it. */
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  /** Where to put the caret once React has committed an accepted completion. */
  const pendingCaret = useRef<number | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
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
  const names = variableContext ? variableNames(value) : [];

  const token = disabled ? null : openTokenAt(value, caret);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (!variableContext || !token) return [];
    const query = token.query.toLowerCase();
    const defined: Suggestion[] = listVariables(variableContext).map((variable) => ({
      name: variable.name,
      detail: variable.value,
      badge: t(SCOPE_LABELS[variable.scope]),
    }));
    const dynamic: Suggestion[] = DYNAMIC_VARIABLES.map((item) => ({
      name: item.name,
      detail: item.example,
      badge: t("api.env.dynamicVariables"),
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

  const menuOpen = !dismissed && token !== null && suggestions.length > 0;
  const quickLookOpen = !menuOpen && names.length > 0 && (hovering || popoverHover || editing !== null);

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
    if (!menuOpen && !quickLookOpen) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    // Anchored flush to the field's bottom edge: a gap here is a strip the pointer crosses on its
    // way into the popover, and crossing it would close the very thing being reached for.
    if (rect) setAnchor({ left: rect.left, top: rect.bottom, width: rect.width });
  }, [menuOpen, quickLookOpen, names.length, suggestions.length, value]);

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

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // First, and ahead of the menu: ⌘Z belongs to the text no matter what is on screen over it.
    // The history swallows the chords it owns, which is what `defaultPrevented` reports back.
    history.onKeyDown(e);
    if (e.defaultPrevented) return;

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

  return (
    <div
      ref={wrapRef}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
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
          const next = e.target.value;
          const start = e.target.selectionStart ?? next.length;
          // `merge`: consecutive keystrokes collapse into one step, so ⌘Z takes back a word rather
          // than a character. A paste or a replaced selection fails that test on its own.
          history.record({ value: next, start, end: e.target.selectionEnd ?? start }, true);
          onChange(next);
          setCaret(e.target.selectionStart);
        }}
        onSelect={syncCaret}
        onClick={syncCaret}
        onFocus={syncCaret}
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
              <button
                key={`${item.badge}:${item.name}`}
                type="button"
                onClick={() => accept(item.name)}
                onPointerEnter={() => setActiveIndex(index)}
                className={`flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left ${
                  index === activeIndex ? "bg-[var(--cf-accent-soft)]" : ""
                }`}
              >
                <span className="shrink-0 font-mono text-[11px] text-[var(--cf-accent)]">{item.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                  {item.detail}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                  {item.badge}
                </span>
              </button>
            ))}
            <p className="px-1.5 pb-0.5 pt-1 text-[10px] text-[var(--cf-text-muted)]">{t("api.env.suggestHint")}</p>
          </div>,
          document.body,
        )}

      {quickLookOpen &&
        variableContext &&
        anchor &&
        createPortal(
          <div
            style={{ position: "fixed", left: anchor.left, top: anchor.top, minWidth: Math.min(anchor.width, 420) }}
            onPointerEnter={() => setPopoverHover(true)}
            onPointerLeave={() => {
              setPopoverHover(false);
              if (editing === null) setEditing(null);
            }}
            className="z-[9998] mt-1.5 max-w-[520px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2 shadow-[var(--cf-shadow)]"
          >
            {names.map((name) => {
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
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveValue(name);
                        else if (e.key === "Escape") setEditing(null);
                      }}
                      aria-label={t("api.env.currentValue")}
                      className="min-w-0 flex-1 rounded border border-[var(--cf-accent)] bg-transparent px-1.5 py-0.5 font-mono text-[11px] outline-none"
                    />
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void saveValue(name)}
                      title={t("common.save")}
                      className="shrink-0 text-[var(--cf-success)] disabled:opacity-40"
                    >
                      <Check size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      title={t("common.cancel")}
                      className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                    >
                      <X size={12} />
                    </button>
                  </div>
                );
              }

              return (
                <div key={name} className="group flex items-baseline gap-2 py-0.5">
                  <span className="shrink-0 font-mono text-[11px] text-[var(--cf-accent)]">{name}</span>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-[11px]"
                    style={{ color: found || dynamic ? "var(--cf-text)" : "var(--cf-danger)" }}
                  >
                    {found ? found.value : dynamic ? dynamic.example : t("api.env.unresolved")}
                  </span>
                  {(found || dynamic) && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                      {found ? t(SCOPE_LABELS[found.scope]) : t("api.env.dynamicVariables")}
                    </span>
                  )}
                  {editable && (
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(found?.value ?? "");
                        setEditing(name);
                      }}
                      title={found ? t("api.env.editValue") : t("api.env.defineValue")}
                      className="shrink-0 text-[var(--cf-text-muted)] opacity-0 hover:text-[var(--cf-accent)] group-hover:opacity-100"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
