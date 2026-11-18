import { useState } from "react";

/**
 * What kind of value a debugger's preview string is, read off the string itself — the backends hand
 * the panel `"text"`, `42`, `null`, `Object`, `class Foo`, `(getter)` and nothing else, so the shape
 * of the text is all there is to colour by.
 */
export type ValueKind = "string" | "number" | "boolean" | "nullish" | "function" | "object" | "accessor" | "other";

export function valueKind(value: string): ValueKind {
  const text = value.trim();
  if (/^(["'`]).*\1$/s.test(text)) return "string";
  if (/^-?(\d[\d_]*(\.\d+)?(e[+-]?\d+)?|0x[\da-f]+|NaN|-?Infinity)n?$/i.test(text)) return "number";
  if (text === "true" || text === "false") return "boolean";
  if (text === "null" || text === "undefined" || text === "None" || text === "nil") return "nullish";
  if (/^(async\s+)?(function|class)\b|^ƒ|=>/.test(text)) return "function";
  if (text === "(getter)" || text === "(setter)" || text === "(getter/setter)") return "accessor";
  if (/^(Object|Array|Map|Set|Promise|Date|RegExp|Error|[A-Z][\w$]*)(\(\d+\))?\b|^[{[]/.test(text)) return "object";
  return "other";
}

const KIND_CLASS: Record<ValueKind, string> = {
  // The app's own tokens, so the colours follow the theme: green text, blue numbers, amber booleans.
  string: "text-[var(--cf-success)]",
  number: "text-[var(--cf-accent)]",
  boolean: "text-[var(--cf-warning)]",
  nullish: "italic text-[var(--cf-text-faint)]",
  function: "italic text-[var(--cf-text-muted)]",
  object: "text-[var(--cf-text-muted)]",
  accessor: "italic text-[var(--cf-text-faint)]",
  other: "text-[var(--cf-text)]",
};

/** A debugger value, coloured by its kind, cut to one line with the whole of it on hover. */
export function DebugValue({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span title={value} className={`truncate font-mono text-[12px] ${KIND_CLASS[valueKind(value)]} ${className}`}>
      {value}
    </span>
  );
}

/** Whether a section of the debug panel is folded, remembered per section on this machine. */
export function useFoldedSection(key: string, initial = false): [boolean, () => void] {
  const storageKey = `cf-debug-fold:${key}`;
  const [folded, setFolded] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored === null ? initial : stored === "1";
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setFolded((current) => {
      const next = !current;
      try {
        localStorage.setItem(storageKey, next ? "1" : "0");
      } catch {
        // A blocked storage only costs the fold its memory.
      }
      return next;
    });
  return [folded, toggle];
}

/** The console's height, in pixels, remembered on this machine. */
export function useStoredNumber(key: string, initial: number): [number, (value: number) => void, (value: number) => void] {
  const storageKey = `cf-debug:${key}`;
  const [value, setValue] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey));
      return Number.isFinite(stored) && stored > 0 ? stored : initial;
    } catch {
      return initial;
    }
  });
  const commit = (next: number) => {
    try {
      localStorage.setItem(storageKey, String(Math.round(next)));
    } catch {
      // As above.
    }
  };
  return [value, setValue, commit];
}
