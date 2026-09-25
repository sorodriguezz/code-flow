import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import * as monaco from "monaco-editor";
import { Check, Search } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { extensionOf, useLanguageOverrideStore } from "../../state/languageOverrideStore";
import { useT } from "../../state/languageStore";

/** The CSV rainbow's per-separator languages — the separator picker's business, not this list's. */
const INTERNAL_LANGUAGE = /^csv-/;
/** Names for the languages this app registers without one. */
const NAMES: Record<string, string> = { csv: "CSV", tsv: "TSV" };

interface LanguageRow {
  id: string;
  name: string;
}

/**
 * Picks the language a file is shown in, by hand — VS Code's "Select Language Mode", opened from the
 * Editor's status line (the user's ask, 2026-09-25).
 *
 * The list is every language Monaco has registered, searchable by name or id, with "automatic" on top
 * to go back to what the extension says. A pick applies to this file, or — ticked — to every file
 * with its extension, which is VS Code's file association; both are kept in settings
 * (`languageOverrideStore`) and read by `useFileLanguage`, which is what re-highlights the file.
 */
export function LanguagePicker({
  anchor,
  path,
  fileKey,
  onClose,
}: {
  anchor: DOMRect;
  path: string;
  fileKey: string;
  onClose: () => void;
}) {
  const t = useT();
  const extension = extensionOf(path);
  const filePick = useLanguageOverrideStore((s) => s.files[fileKey]);
  const extensionPick = useLanguageOverrideStore((s) => (extension ? s.extensions[extension] : undefined));
  const setFileLanguage = useLanguageOverrideStore((s) => s.setFileLanguage);
  const setExtensionLanguage = useLanguageOverrideStore((s) => s.setExtensionLanguage);
  // Opens on the scope the current language came from: a file following its extension's association
  // is most likely being re-pointed as a group again.
  const [forExtension, setForExtension] = useState(!filePick && Boolean(extensionPick));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const languages = useMemo<LanguageRow[]>(
    () =>
      (monaco.languages.getLanguages() as { id: string; aliases?: string[] }[])
        .filter((language) => !INTERNAL_LANGUAGE.test(language.id))
        .map((language) => ({
          id: language.id,
          name:
            language.id === "plaintext"
              ? t("editor.status.plainText")
              : (NAMES[language.id] ?? language.aliases?.[0] ?? language.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [t],
  );

  /** `null` is "automatic", always the first row and never filtered away. */
  const rows = useMemo<(LanguageRow | null)[]>(() => {
    const needle = query.trim().toLowerCase();
    const matching = needle
      ? languages.filter((row) => row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle))
      : languages;
    return [null, ...matching];
  }, [languages, query]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const pick = (row: LanguageRow | null) => {
    const language = row?.id ?? null;
    if (forExtension && extension) {
      // The association is what is being set; a pick on this one file would outrank it here and
      // make the choice look as if it had not taken.
      void setExtensionLanguage(extension, language);
      if (filePick) void setFileLanguage(fileKey, null);
    } else {
      void setFileLanguage(fileKey, language);
    }
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, rows.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (rows[active] !== undefined) pick(rows[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  /** Which row reads as chosen: the pick in the scope on show, or "automatic" when there is none. */
  const scopedPick = forExtension ? extensionPick : filePick;
  const isCurrent = (row: LanguageRow | null) => (row === null ? !scopedPick : scopedPick === row.id);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("editor.status.languagePicker")}
      style={{
        right: Math.max(8, window.innerWidth - anchor.right),
        bottom: window.innerHeight - anchor.top + 4,
      }}
      className="cf-fade-in fixed z-50 flex w-[280px] flex-col rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-[5px] shadow-[var(--cf-shadow)]"
    >
      <div className="mb-1 flex h-8 items-center gap-2 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2">
        <Search size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("editor.status.languageSearch")}
          className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)]"
        />
      </div>
      <div ref={listRef} role="listbox" className="max-h-[300px] overflow-y-auto">
        {rows.map((row, index) => (
          <button
            key={row?.id ?? "auto"}
            data-index={index}
            role="option"
            aria-selected={index === active}
            onMouseEnter={() => setActive(index)}
            onClick={() => pick(row)}
            className={`flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-[var(--cf-text)] ${
              index === active ? "bg-[var(--cf-hover)]" : ""
            } ${row === null ? "mb-1" : ""}`}
          >
            <span className="flex w-3.5 shrink-0 justify-center">{isCurrent(row) && <Check size={13} />}</span>
            <span className="min-w-0 flex-1 truncate">{row ? row.name : t("editor.status.languageAuto")}</span>
            {row && row.name.toLowerCase() !== row.id && (
              <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text-faint)]">{row.id}</span>
            )}
          </button>
        ))}
        {rows.length === 1 && (
          <p className="px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("editor.status.languageNone")}</p>
        )}
      </div>
      {extension && (
        <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-[var(--cf-border)] px-2 pb-1 pt-2 text-[12px] text-[var(--cf-text-muted)]">
          <Checkbox checked={forExtension} onChange={setForExtension} />
          {t("editor.status.languageForExtension", { ext: extension })}
        </label>
      )}
    </div>,
    document.body,
  );
}
