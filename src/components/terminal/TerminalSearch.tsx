import { useEffect, useRef, useState } from "react";
import type { SearchAddon, ISearchOptions } from "@xterm/addon-search";
import { ArrowDown, ArrowUp, CaseSensitive, Regex, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";

/**
 * Match colours for the search addon, which draws them as xterm decorations and only takes
 * `#RRGGBB` — no alpha, no CSS variables — hence one pair per ground rather than the theme tokens.
 */
function decorations(dark: boolean): NonNullable<ISearchOptions["decorations"]> {
  return dark
    ? {
        matchBackground: "#5a4a12",
        activeMatchBackground: "#b7791f",
        matchOverviewRuler: "#d4a72c",
        activeMatchColorOverviewRuler: "#f59e0b",
      }
    : {
        matchBackground: "#fbe7a1",
        activeMatchBackground: "#f5b54a",
        matchOverviewRuler: "#d4a72c",
        activeMatchColorOverviewRuler: "#f59e0b",
      };
}

/**
 * Find in a terminal's scrollback: ⌘F on macOS, Ctrl+F elsewhere, opened from `TerminalPane`.
 *
 * Incremental as you type — the match under the cursor moves with each letter rather than jumping
 * to the next one — with Enter / Shift+Enter for next and previous, and Escape back to the shell.
 */
export function TerminalSearch({
  addon,
  dark,
  focusToken,
  onClose,
}: {
  addon: SearchAddon;
  dark: boolean;
  /** Bumped every time ⌘F is pressed again while the box is open, to take the focus back. */
  focusToken: number;
  onClose: () => void;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [term, setTerm] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<{ index: number; count: number } | null>(null);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  useEffect(() => {
    const subscription = addon.onDidChangeResults(({ resultIndex, resultCount }) =>
      setResults({ index: resultIndex, count: resultCount }),
    );
    return () => subscription.dispose();
  }, [addon]);

  const options = (incremental: boolean): ISearchOptions => ({
    caseSensitive,
    regex,
    incremental,
    decorations: decorations(dark),
  });

  /** Runs one search; a regex still being typed (`(` alone) is marked rather than thrown. */
  const find = (direction: "next" | "previous", incremental = false) => {
    if (!term) {
      addon.clearDecorations();
      setResults(null);
      return;
    }
    try {
      if (direction === "next") addon.findNext(term, options(incremental));
      else addon.findPrevious(term, options(incremental));
      setInvalid(false);
    } catch {
      setInvalid(true);
      setResults(null);
    }
  };

  // As the term or a toggle changes: from where the match already is, not onward from it.
  useEffect(() => {
    find("next", true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, caseSensitive, regex, dark]);

  useEffect(() => () => addon.clearDecorations(), [addon]);

  const toggle = (on: boolean) =>
    `${iconButtonClass({ size: "xs" })} ${on ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : ""}`;

  const counter = !term
    ? ""
    : invalid
      ? "—"
      : results && results.count > 0
        ? `${results.index + 1}/${results.count}`
        : t("terminal.findNone");

  return (
    <div
      className="absolute right-3 top-3 z-20 flex items-center gap-0.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] py-0.5 pl-2 pr-0.5 shadow-[var(--cf-shadow)]"
      // Keys typed here are the box's, never the shell's.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <input
        ref={inputRef}
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            find(event.shiftKey ? "previous" : "next");
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        placeholder={t("terminal.find")}
        aria-label={t("terminal.find")}
        aria-invalid={invalid}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        className={`h-6 w-40 bg-transparent font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] ${
          invalid ? "text-[var(--cf-danger)]" : ""
        }`}
      />
      <span className="min-w-[44px] shrink-0 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">{counter}</span>
      <Tooltip side="bottom" label={t("terminal.findCase")}>
        <button
          type="button"
          onClick={() => setCaseSensitive((on) => !on)}
          aria-pressed={caseSensitive}
          aria-label={t("terminal.findCase")}
          className={toggle(caseSensitive)}
        >
          <CaseSensitive size={14} />
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t("terminal.findRegex")}>
        <button
          type="button"
          onClick={() => setRegex((on) => !on)}
          aria-pressed={regex}
          aria-label={t("terminal.findRegex")}
          className={toggle(regex)}
        >
          <Regex size={13} />
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t("terminal.findPrevious")}>
        <button
          type="button"
          onClick={() => find("previous")}
          disabled={!term}
          aria-label={t("terminal.findPrevious")}
          className={iconButtonClass({ size: "xs" })}
        >
          <ArrowUp size={13} />
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t("terminal.findNext")}>
        <button
          type="button"
          onClick={() => find("next")}
          disabled={!term}
          aria-label={t("terminal.findNext")}
          className={iconButtonClass({ size: "xs" })}
        >
          <ArrowDown size={13} />
        </button>
      </Tooltip>
      <Tooltip side="bottom" label={t("common.close")}>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className={iconButtonClass({ size: "xs" })}>
          <X size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
