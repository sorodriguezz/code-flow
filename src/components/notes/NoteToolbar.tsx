import { memo, useMemo } from "react";
import {
  Bold,
  Code,
  Code2,
  Heading1,
  Heading2,
  Heading3,
  Image,
  Italic,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Quote,
  Strikethrough,
  Table,
  type LucideIcon,
} from "lucide-react";
import type { MarkdownTool } from "../../lib/notes/markdownTools";
import type { TranslationKey } from "../../lib/i18n/translations";
import { ICON_BUTTON } from "./notesChrome";
import { chordLabel } from "../../lib/keys";
import { useT } from "../../state/languageStore";

/**
 * The formatting toolbar.
 *
 * The set is chosen, not exhaustive: these are the marks that are genuinely faster to press than
 * to type, plus the three blocks nobody remembers the syntax of (table, fenced code, rule). A
 * button for every construct in CommonMark would be a ribbon, and the two it would add — footnotes,
 * definition lists — are things you look up once and then type.
 *
 * Every entry is a `MarkdownTool`, so this file has no formatting logic at all; it says what the
 * buttons are and `lib/notes/markdownTools` says what they do. That split is what lets the same
 * operations be bound to keyboard chords without a second implementation.
 */

interface Tool {
  icon: LucideIcon;
  labelKey: TranslationKey;
  tool: MarkdownTool;
  /** Shown in the tooltip. Monaco owns the actual binding for the three that have one. */
  chord?: string;
  /** Draws a hairline before this button. */
  separated?: boolean;
}

const TOOLS: Tool[] = [
  { icon: Bold, labelKey: "md.bold", tool: { kind: "wrap", before: "**", after: "**" }, chord: "Mod+B" },
  { icon: Italic, labelKey: "md.italic", tool: { kind: "wrap", before: "_", after: "_" }, chord: "Mod+I" },
  {
    icon: Strikethrough,
    labelKey: "notes.tool.strike",
    tool: { kind: "wrap", before: "~~", after: "~~" },
  },
  { icon: Code, labelKey: "md.code", tool: { kind: "wrap", before: "`", after: "`" } },

  { icon: Heading1, labelKey: "notes.tool.h1", tool: { kind: "line", prefix: "# " }, separated: true },
  { icon: Heading2, labelKey: "notes.tool.h2", tool: { kind: "line", prefix: "## " } },
  { icon: Heading3, labelKey: "notes.tool.h3", tool: { kind: "line", prefix: "### " } },

  { icon: List, labelKey: "md.bullets", tool: { kind: "line", prefix: "- " }, separated: true },
  { icon: ListOrdered, labelKey: "md.numbers", tool: { kind: "ordered" } },
  { icon: ListChecks, labelKey: "notes.tool.task", tool: { kind: "line", prefix: "- [ ] " } },
  { icon: Quote, labelKey: "md.quote", tool: { kind: "line", prefix: "> " } },

  { icon: Link2, labelKey: "md.link", tool: { kind: "link" }, chord: "Mod+K", separated: true },
  { icon: Image, labelKey: "notes.tool.image", tool: { kind: "image" } },
  {
    icon: Table,
    labelKey: "notes.tool.table",
    // Three columns and one body row: the smallest table that still *looks* like a table in the
    // preview, so the user can see what they got before filling it in. `Header 1` is selected on
    // insert, so the first keystroke starts replacing it.
    tool: {
      kind: "block",
      text: "| Header 1 | Header 2 | Header 3 |\n| --- | --- | --- |\n|  |  |  |\n",
      select: "Header 1",
    },
  },
  {
    icon: Code2,
    labelKey: "notes.tool.codeBlock",
    // The language slot is what is selected: an unlabelled fence is the commonest thing people
    // leave behind, and it is the one that costs the highlighting.
    tool: { kind: "block", text: "```lang\n\n```\n", select: "lang" },
  },
  { icon: Minus, labelKey: "notes.tool.rule", tool: { kind: "block", text: "---\n" } },
];

export const NoteToolbar = memo(function NoteToolbar({
  onApply,
  disabled,
}: {
  onApply: (tool: MarkdownTool) => void;
  /** On in preview mode: the marks have nothing to act on when the source isn't showing. */
  disabled?: boolean;
}) {
  const t = useT();
  // The chord labels are platform-dependent (⌘ vs Ctrl) and the set never changes, so they are
  // rendered once rather than per button per render.
  const labels = useMemo(
    () =>
      TOOLS.map(({ labelKey, chord }) =>
        chord ? `${t(labelKey)} · ${chordLabel(chord)}` : t(labelKey),
      ),
    [t],
  );

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--cf-border)] px-1.5 py-1"
      role="toolbar"
      aria-label={t("notes.formatting")}
    >
      {TOOLS.map(({ icon: Icon, tool, separated }, index) => (
        <span key={labels[index]} className="flex items-center">
          {separated && <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" aria-hidden />}
          <button
            type="button"
            // The press must not take focus off the editor, or the selection the tool is about to
            // wrap is gone before it runs.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onApply(tool)}
            disabled={disabled}
            title={labels[index]}
            aria-label={labels[index]}
            className={ICON_BUTTON}
          >
            <Icon size={13} />
          </button>
        </span>
      ))}
    </div>
  );
});
