import { useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { normalizeTag, tagCounts } from "../../lib/notes/tags";
import { TagPill } from "./notesChrome";
import { useNotesStore } from "../../state/notesStore";
import { useT } from "../../state/languageStore";

/**
 * The open note's tags, and the field that adds one.
 *
 * The field completes against the tags already in the workspace, which is the entire point: an
 * untyped tag vocabulary drifts into `deploy`, `deploys` and `deployment` within a month, and the
 * only thing that stops it is seeing the existing one while you type the new one. Normalisation
 * (`normalizeTag`) closes the case and whitespace gap; the suggestions close the rest.
 */
export function NoteTagBar({
  tags,
  onChange,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
}) {
  const notes = useNotesStore((s) => s.notes);
  const t = useT();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  /**
   * Which suggestion the arrow keys have landed on, or `-1` for "none — take what is typed".
   *
   * `-1` rather than defaulting to the first row, deliberately: pre-highlighting a suggestion means
   * Enter silently substitutes a *different* tag from the one the user finished typing, which is
   * how `deploy` becomes `deployment` without anyone noticing.
   */
  const [highlighted, setHighlighted] = useState(-1);
  const field = useRef<HTMLInputElement>(null);

  const known = useMemo(() => tagCounts(notes).map(({ tag }) => tag), [notes]);
  const normalized = normalizeTag(draft);
  const suggestions = useMemo(() => {
    if (!normalized) return [];
    return known
      .filter((tag) => tag.includes(normalized) && !tags.includes(tag))
      .slice(0, 6);
  }, [known, normalized, tags]);

  /**
   * Adds `raw` as a tag. `keepOpen` is false on the blur path.
   *
   * The refocus is what `keepOpen` guards: adding three tags should be three words and two Enters
   * rather than three round trips through the button, so the Enter path puts focus back. On blur
   * it must not — `close()` unmounts the field in the same tick, and grabbing focus for an element
   * that is about to disappear takes it away from wherever the user actually clicked.
   */
  const commit = (raw: string, keepOpen = true) => {
    const tag = normalizeTag(raw);
    // Silently ignored rather than rejected with a message: an empty tag is a stray Enter, and a
    // duplicate is the user re-adding one that is already visible two inches away.
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setDraft("");
    if (keepOpen) field.current?.focus();
  };

  const close = () => {
    setAdding(false);
    setDraft("");
    setHighlighted(-1);
  };

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.map((tag) => (
        <TagPill
          key={tag}
          tag={tag}
          onRemove={() => onChange(tags.filter((existing) => existing !== tag))}
          removeLabel={t("notes.removeTag", { tag })}
        />
      ))}

      {adding ? (
        <span className="relative">
          <input
            ref={field}
            autoFocus
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              // Typing invalidates the arrow-key position: the list under it has changed.
              setHighlighted(-1);
            }}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="cf-tag-suggestions"
            aria-autocomplete="list"
            aria-activedescendant={
              highlighted >= 0 ? `cf-tag-suggestion-${highlighted}` : undefined
            }
            onBlur={() => {
              // Committed on blur, not discarded: a user who types a tag and clicks back into the
              // editor meant to add it, and losing it would be the kind of quiet failure that
              // teaches people to distrust the field.
              if (normalized) commit(draft, false);
              close();
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && suggestions.length > 0) {
                event.preventDefault();
                setHighlighted((at) => (at + 1) % suggestions.length);
                return;
              }
              if (event.key === "ArrowUp" && suggestions.length > 0) {
                event.preventDefault();
                setHighlighted((at) => (at <= 0 ? suggestions.length - 1 : at - 1));
                return;
              }
              if (event.key === "Tab" && highlighted >= 0) {
                // Tab completes to the highlighted suggestion rather than leaving the field — the
                // one place in this component where swallowing Tab is right, because the user has
                // explicitly arrowed onto a row and Tab is how completion is accepted everywhere.
                event.preventDefault();
                commit(suggestions[highlighted]);
                setHighlighted(-1);
                return;
              }
              if (event.key === "Enter" || event.key === ",") {
                event.preventDefault();
                commit(highlighted >= 0 ? suggestions[highlighted] : draft);
                setHighlighted(-1);
              }
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
              // Backspace on an empty field removes the last tag — the behaviour every chip input
              // has, and the only way to undo a mistyped tag without reaching for the mouse.
              if (event.key === "Backspace" && !draft && tags.length > 0) {
                onChange(tags.slice(0, -1));
              }
            }}
            placeholder={t("notes.addTag")}
            aria-label={t("notes.addTag")}
            spellCheck={false}
            className="w-28 rounded-full border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-[1px] text-[10.5px] leading-[16px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
          />
          {suggestions.length > 0 && (
            <ul
              id="cf-tag-suggestions"
              role="listbox"
              className="absolute left-0 top-[calc(100%+4px)] z-20 min-w-32 overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] py-0.5 shadow-[var(--cf-shadow)]"
            >
              {suggestions.map((tag, index) => (
                <li
                  key={tag}
                  id={`cf-tag-suggestion-${index}`}
                  role="option"
                  aria-selected={index === highlighted}
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    // `onMouseDown`, not `onClick`: the field's `onBlur` fires first on a click and
                    // would close the list before the click ever landed on it.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      commit(tag);
                    }}
                    className={`block w-full px-2 py-1 text-left text-[11px] text-[var(--cf-text)] ${
                      index === highlighted
                        ? "bg-[var(--cf-accent-soft)]"
                        : "hover:bg-[var(--cf-accent-soft)]"
                    }`}
                  >
                    #{tag}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-0.5 rounded-full border border-dashed border-[var(--cf-field-border)] px-1.5 py-[1px] text-[10.5px] leading-[16px] text-[var(--cf-text-muted)] transition-colors hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          <Plus size={9} />
          {t("notes.addTag")}
        </button>
      )}
    </div>
  );
}
