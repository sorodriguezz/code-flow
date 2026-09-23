import { useMemo, useState } from "react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { useCsvStore } from "../../state/csvStore";
import { useT } from "../../state/languageStore";
import { CSV_SEPARATORS, csvSeparatorFor, separatorById } from "../../lib/csvDialect";

/**
 * Which separator this one file is read with, in the editor's toolbar — only for a delimited file,
 * and only while its columns are being coloured.
 *
 * It exists for the file detection reads wrong, or the `.csv` a forced setting does not fit, and it
 * is the only place the rarer separators (`:`, `^`, `~`) can be chosen from at all. The pick lasts
 * the session; see `csvStore.fileSeparators`.
 */
export function CsvSeparatorPicker({
  path,
  file,
  text,
  language,
}: {
  /** The tab's path, for its extension. */
  path: string;
  /** The model's path, which the pick is filed under. */
  file: string;
  /** The file as it was opened — what the default was detected from. */
  text: string;
  /** The language the editor is showing, which names the separator in force. */
  language: string;
}) {
  const t = useT();
  const separator = useCsvStore((s) => s.separator);
  const override = useCsvStore((s) => s.fileSeparators[file]);
  const setFileSeparator = useCsvStore((s) => s.setFileSeparator);
  const [at, setAt] = useState<DOMRect | null>(null);

  /** What this file gets with no pick of its own — the setting, or what detection found. */
  const fallback = useMemo(
    () => csvSeparatorFor(path, text, { rainbow: true, separator, override: null }),
    [path, text, separator],
  );
  const current = CSV_SEPARATORS.find((entry) => entry.language === language);
  if (!current || !fallback) return null;

  const glyph = (mark: string, active: boolean) => (
    <span
      className={`flex h-4 w-4 items-center justify-center rounded font-mono text-[11px] leading-none ${
        active ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"
      }`}
    >
      {mark}
    </span>
  );

  const items: MenuItem[] = [
    {
      label: t("csv.pickerDefault", { name: t(separatorById(fallback).labelKey) }),
      leading: glyph("•", !override),
      onClick: () => setFileSeparator(file, null),
    },
    ...CSV_SEPARATORS.map((entry, index) => ({
      label: t(entry.labelKey),
      leading: glyph(entry.glyph, override === entry.id),
      separated: index === 0,
      onClick: () => setFileSeparator(file, entry.id),
    })),
  ];

  const title = t("csv.pickerTitle", { name: t(current.labelKey) });

  return (
    <>
      <button
        type="button"
        onClick={(event) => setAt(event.currentTarget.getBoundingClientRect())}
        title={title}
        aria-label={title}
        className={`flex h-5 min-w-5 items-center justify-center rounded-md px-1 font-mono text-[11px] leading-none ${
          at || override
            ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
            : "text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
        }`}
      >
        {current.glyph}
      </button>
      {at && (
        <ContextMenu
          x={at.left}
          y={at.bottom}
          anchor={{ top: at.top, bottom: at.bottom, left: at.left, right: at.right, align: "end" }}
          heading={t("csv.pickerHeading")}
          items={items}
          onClose={() => setAt(null)}
        />
      )}
    </>
  );
}
