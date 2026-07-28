import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  DYNAMIC_VARIABLES,
  findUnresolved,
  lookupVariable,
  type VariableContext,
} from "../../lib/api/variables";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { VariableScope } from "../../types/api";

/**
 * A single-line field that marks the `{{variables}}` inside it — accent-tinted when the current
 * scopes define them, danger-tinted when nothing does.
 *
 * Built as a mirrored `<div>` under a real `<input>` rather than a contenteditable: an `<input>`
 * is the only element that gets caret placement, selection, undo, autofill and IME composition
 * right for free, and none of that survives being re-implemented.
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

const SCOPE_LABELS: Record<VariableScope, TranslationKey> = {
  local: "api.scope.local",
  data: "api.scope.data",
  environment: "api.scope.environment",
  collection: "api.scope.collection",
  global: "api.scope.global",
};

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

export interface VariableInputProps {
  value: string;
  onChange: (value: string) => void;
  /** `null` turns the highlighting and the popover off; the field stays an ordinary input. */
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
  const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);

  const segments = segment(value, variableContext);
  const names = variableContext ? variableNames(value) : [];

  /** The mirror doesn't scroll on its own — it is shifted by whatever the input scrolled. */
  const syncScroll = () => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (input && mirror) mirror.style.transform = `translateX(${-input.scrollLeft}px)`;
  };

  // Typing past the right edge scrolls the input without firing `scroll` in every engine, so the
  // offset is re-read after each committed value as well.
  useEffect(syncScroll, [value]);

  useLayoutEffect(() => {
    if (!hovering || names.length === 0) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setAnchor({ left: rect.left, top: rect.bottom + 6, width: rect.width });
  }, [hovering, names.length, value]);

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
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        className={`relative w-full select-text bg-transparent leading-5 text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] disabled:cursor-not-allowed disabled:text-[var(--cf-text-muted)] ${fieldClassName}`}
      />

      {hovering &&
        names.length > 0 &&
        variableContext &&
        anchor &&
        createPortal(
          <div
            style={{ position: "fixed", left: anchor.left, top: anchor.top, minWidth: Math.min(anchor.width, 420) }}
            className="pointer-events-none z-[9998] max-w-[520px] rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2 shadow-[var(--cf-shadow)]"
          >
            {names.map((name) => {
              const found = lookupVariable(name, variableContext);
              const dynamic = found ? undefined : DYNAMIC_VARIABLES.find((item) => item.name === name);
              return (
                <div key={name} className="flex items-baseline gap-2 py-0.5">
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
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
