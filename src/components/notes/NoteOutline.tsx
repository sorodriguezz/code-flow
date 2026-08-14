import { memo } from "react";
import { ListTree } from "lucide-react";
import type { Heading } from "../../lib/notes/outline";
import { useT } from "../../state/languageStore";

/**
 * The note's headings, as a rail you can click to move around a long document.
 *
 * Indented by level, and the indentation is the whole design: an outline that doesn't show the
 * shape of the document is a list of links. Levels are indented *relative to the shallowest
 * heading present*, so a note whose sections are all `##` (which is most notes, because the `#` is
 * the title) doesn't start every row one step in for no reason.
 */
export const NoteOutline = memo(function NoteOutline({
  headings,
  activeLine,
  onSelect,
}: {
  headings: Heading[];
  /** The line the caret is on, so the section being edited is marked. */
  activeLine: number;
  /** The index is what the preview scroll aims at — see `outlineOf`'s note on staying aligned. */
  onSelect: (heading: Heading, index: number) => void;
}) {
  const t = useT();

  if (headings.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <ListTree size={20} className="text-[var(--cf-text-muted)]" />
        <p className="text-[11px] text-[var(--cf-text-muted)]">{t("notes.outlineEmpty")}</p>
      </div>
    );
  }

  const shallowest = Math.min(...headings.map((heading) => heading.level));

  // The heading the caret is inside: the last one at or above the caret's line. Computed here
  // rather than passed in because it is a property of *these* headings and that line, and two
  // places deriving it is two places to get the boundary wrong.
  let current = -1;
  for (let at = 0; at < headings.length; at++) {
    if (headings[at].line <= activeLine) current = at;
    else break;
  }

  return (
    <nav className="h-full overflow-y-auto p-2" aria-label={t("notes.outline")}>
      <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        <ListTree size={11} />
        {t("notes.outline")}
      </div>
      {headings.map((heading, index) => (
        <button
          key={`${heading.line}-${index}`}
          type="button"
          onClick={() => onSelect(heading, index)}
          style={{ paddingLeft: 6 + (heading.level - shallowest) * 10 }}
          className={`block w-full truncate rounded py-[3px] pr-1.5 text-left text-[11.5px] transition-colors ${
            index === current
              ? "bg-[var(--cf-accent-soft)] font-medium text-[var(--cf-accent)]"
              : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.05]"
          }`}
          title={heading.text}
        >
          {heading.text}
        </button>
      ))}
    </nav>
  );
});
