import { useRef, useState } from "react";
import {
  Bold,
  Code,
  Eye,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  PenLine,
  Quote,
  Redo2,
  Undo2,
} from "lucide-react";
import { chordLabel } from "../../lib/keys";
import { renderMarkdown } from "../../lib/markdown";
import { isMac } from "../../lib/platform";
import { useTextHistory } from "../../lib/useTextHistory";
import { useT } from "../../state/languageStore";

/**
 * A Markdown field that looks like somewhere you write Markdown.
 *
 * The description of a work item is prose with structure — headings, lists, the occasional table —
 * and the bare `<textarea>` it used to live in gave the user no way to tell whether the `##` they
 * typed was going to be a heading or two hash marks. What is missing there is not syntax
 * highlighting; it is the two things an editor gives you: a way to apply the marks without
 * remembering them, and a way to see what they produce.
 *
 * So: a toolbar that wraps the selection, and a Write/Preview pair. Deliberately not a rich-text
 * editor — the value is Markdown, and a WYSIWYG surface that hides the source is how a field
 * round-trips into HTML nobody asked for.
 *
 * `readOnly` drops to the preview alone. A closed review has nothing to type into, and showing a
 * disabled toolbar over an inert textarea would say "you may edit this later", which is not true.
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  readOnly = false,
  ariaLabel,
  historyKey,
}: {
  value: string;
  /** Absent only where `readOnly` is on — a field with no handler and no lock is a field that
   *  silently swallows what the user types. */
  onChange?: (value: string) => void;
  placeholder: string;
  readOnly?: boolean;
  ariaLabel: string;
  /** What this field is editing — an item id, a field name. The undo history starts over when it
   *  changes, because the same editor is reused for the next item without unmounting, and a step
   *  back into the previous item's prose would be data loss wearing an undo's clothes. */
  historyKey?: string | number;
}) {
  const t = useT();
  const area = useRef<HTMLTextAreaElement>(null);
  const [wanted, setPreview] = useState(readOnly);
  // Derived rather than only seeded, because `readOnly` can turn on while the field is open — a
  // review closes and every editor on screen has to become a reader, not merely lose its toolbar.
  const preview = readOnly || wanted;
  const write = (next: string) => onChange?.(next);
  const history = useTextHistory({
    value,
    write,
    field: area,
    enabled: !readOnly,
    resetKey: historyKey,
  });

  /**
   * Wraps or prefixes the selection, then puts the caret back where the user can carry on typing.
   *
   * `before`/`after` wrap (bold, code); `line` prefixes every selected line (lists, quotes). With
   * nothing selected the marks go in around an empty selection, which is what every editor does —
   * you press the button and then type into the marks.
   */
  const apply = (marks: { before?: string; after?: string; line?: string }) => {
    const el = area.current;
    if (!el || readOnly) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);

    let replacement: string;
    if (marks.line) {
      // The whole of the first and last line, so a prefix applied from mid-word still lands in
      // the margin rather than inside the sentence.
      const from = value.lastIndexOf("\n", start - 1) + 1;
      const toIndex = value.indexOf("\n", end);
      const to = toIndex === -1 ? value.length : toIndex;
      const block = value.slice(from, to);
      replacement = block
        .split("\n")
        .map((line, at) => `${marks.line === "1. " ? `${at + 1}. ` : marks.line}${line}`)
        .join("\n");
      const next = `${value.slice(0, from)}${replacement}${value.slice(to)}`;
      // One press, one undo step: recorded whole rather than merged into whatever was being typed.
      history.record({ value: next, start: from, end: from + replacement.length });
      write(next);
      queueMicrotask(() => {
        el.focus();
        el.setSelectionRange(from, from + replacement.length);
      });
      return;
    }

    const before = marks.before ?? "";
    const after = marks.after ?? "";
    replacement = `${before}${selected}${after}`;
    const next = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
    // Inside the marks when there was nothing selected, around the text when there was.
    const caret = start + before.length;
    history.record({ value: next, start: caret, end: caret + selected.length });
    write(next);
    queueMicrotask(() => {
      el.focus();
      el.setSelectionRange(caret, caret + selected.length);
    });
  };

  const TOOLS = [
    { icon: Bold, label: t("md.bold"), run: () => apply({ before: "**", after: "**" }) },
    { icon: Italic, label: t("md.italic"), run: () => apply({ before: "_", after: "_" }) },
    { icon: Heading2, label: t("md.heading"), run: () => apply({ line: "## " }) },
    { icon: List, label: t("md.bullets"), run: () => apply({ line: "- " }) },
    { icon: ListOrdered, label: t("md.numbers"), run: () => apply({ line: "1. " }) },
    { icon: Quote, label: t("md.quote"), run: () => apply({ line: "> " }) },
    { icon: Code, label: t("md.code"), run: () => apply({ before: "`", after: "`" }) },
    { icon: Link2, label: t("md.link"), run: () => apply({ before: "[", after: "](url)" }) },
  ];

  const STEPS = [
    { icon: Undo2, label: t("md.undo"), chord: "Mod+Z", run: history.undo, can: history.canUndo },
    {
      icon: Redo2,
      label: t("md.redo"),
      // Both are bound; the tooltip names the one the platform's own apps teach.
      chord: isMac() ? "Mod+Shift+Z" : "Mod+Y",
      run: history.redo,
      can: history.canRedo,
    },
  ];

  const tool =
    "flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] transition-colors hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.07]";

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-[var(--cf-border)] px-1.5 py-1">
        {!readOnly && (
          <>
            {/* Before the marks, in the order every editor puts them: the two buttons that answer
                "that wasn't what I meant" belong at the start of the toolbar, not buried in it. */}
            {STEPS.map(({ icon: Icon, label, chord, run, can }) => (
              <button
                key={label}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={run}
                disabled={preview || !can}
                title={`${label} · ${chordLabel(chord)}`}
                aria-label={label}
                className={`${tool} disabled:cursor-not-allowed disabled:opacity-30`}
              >
                <Icon size={12} />
              </button>
            ))}
            <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" aria-hidden />
            {TOOLS.map(({ icon: Icon, label, run }) => (
              <button
                key={label}
                type="button"
                // The press must not take focus off the textarea, or the selection the tool is
                // about to wrap is gone before it runs.
                onMouseDown={(e) => e.preventDefault()}
                onClick={run}
                disabled={preview}
                title={label}
                aria-label={label}
                className={`${tool} disabled:cursor-not-allowed disabled:opacity-30`}
              >
                <Icon size={12} />
              </button>
            ))}
            <span className="mx-1 h-4 w-px shrink-0 bg-[var(--cf-border)]" aria-hidden />
          </>
        )}
        <button
          type="button"
          onClick={() => setPreview(false)}
          aria-pressed={!preview}
          disabled={readOnly}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:hidden ${
            preview ? "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]" : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          }`}
        >
          <PenLine size={11} />
          {t("md.write")}
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          aria-pressed={preview}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors ${
            preview ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          }`}
        >
          <Eye size={11} />
          {t("md.preview")}
        </button>
        <span className="ml-auto shrink-0 pr-1 text-[10px] tabular-nums text-[var(--cf-text-muted)]">
          {t("md.chars").replace("{n}", String(value.length))}
        </span>
      </div>

      {preview ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {value.trim() ? (
            <div
              className="cf-markdown-preview text-[12.5px]"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(value) }}
            />
          ) : (
            <p className="text-[11.5px] italic text-[var(--cf-text-muted)]">{placeholder}</p>
          )}
        </div>
      ) : (
        <textarea
          ref={area}
          value={value}
          readOnly={readOnly}
          onChange={(e) => {
            const el = e.currentTarget;
            // `merge`: a keystroke joins the run of typing in progress rather than becoming a step
            // of its own, so undo walks back words instead of letters.
            history.record({ value: el.value, start: el.selectionStart, end: el.selectionEnd }, true);
            write(el.value);
          }}
          onKeyDown={history.onKeyDown}
          placeholder={placeholder}
          aria-label={ariaLabel}
          spellCheck={false}
          // `resize-none` because it already fills the panel: a drag handle here would fight the
          // column's own height rather than give the user more room.
          className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--cf-text)] outline-none placeholder:italic placeholder:text-[var(--cf-text-muted)]"
        />
      )}
    </div>
  );
}
