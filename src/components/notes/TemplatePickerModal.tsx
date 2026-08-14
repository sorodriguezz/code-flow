import { useEffect, useMemo, useState } from "react";
import { LayoutTemplate, Pencil, Trash2, X } from "lucide-react";
import { TagPill } from "./notesChrome";
import { Markdown } from "../common/Markdown";
import { EditTemplateModal } from "./EditTemplateModal";
import { fillTemplate, titleFromTemplate } from "../../lib/notes/templates";
import { iconOf } from "../../lib/notes/templateIcons";
import type { NoteTemplate } from "../../types/notes";
import { useNotesStore } from "../../state/notesStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * Pick a template to start a note from.
 *
 * One list: the six that ship with the app and whatever the user has added since, in whatever
 * order `notesStore` holds them. They read the same because they *are* the same kind of row — see
 * `notesStore.setWorkspace`'s one-time seed — so this no longer has anything special to say about
 * "built-in": every template here can be used, edited or deleted the same way.
 *
 * A preview pane beside the list, because a template's *name* is not enough to choose by and
 * opening three notes to find out is worse than one panel.
 */
export function TemplatePickerModal({ onClose }: { onClose: () => void }) {
  const templates = useNotesStore((s) => s.templates);
  const createNote = useNotesStore((s) => s.createNote);
  const deleteTemplate = useNotesStore((s) => s.deleteTemplate);
  const t = useT();

  const [selectedId, setSelectedId] = useState(templates[0]?.id ?? "");
  /** The template an edit dialog is open on, or `null`. A second piece of state rather than a
   *  mode flag on the picker itself, so the list and preview stay mounted underneath it. */
  const [editing, setEditing] = useState<NoteTemplate | null>(null);
  // Re-derived every render rather than trusted from `selectedId` alone: a delete leaves the id
  // pointing at a row that is gone, and falling back to the new first template is what should
  // happen next, not an empty pane.
  const selected = templates.find((template) => template.id === selectedId) ?? templates[0] ?? null;

  // Rendered with its placeholders filled, so the preview shows today's date rather than
  // `{{date}}` — which is what the note will actually say.
  const preview = useMemo(
    () => (selected ? fillTemplate(selected.content, selected.name) : ""),
    [selected],
  );

  const use = async (template: NoteTemplate) => {
    const at = new Date();
    // Built and passed whole rather than letting `createNote` fill it: the title comes from the
    // template's own first heading (see `titleFromTemplate`), which the store has no business
    // knowing about.
    await createNote(null, {
      ...template,
      name: titleFromTemplate(template, at),
      content: fillTemplate(template.content, template.name, at),
    });
    onClose();
  };

  // Escape closes, like every other dialog in the app. On `window` rather than the panel, because
  // focus may legitimately be inside a field, a suggestion list, or nothing at all.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="cf-fade-in flex h-[520px] max-h-[calc(100vh-2rem)] w-[760px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <LayoutTemplate size={14} className="text-[var(--cf-accent)]" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">
            {t("notes.templates")}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("notes.close")}
            className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-56 shrink-0 overflow-y-auto border-r border-[var(--cf-border)] p-1.5">
            {templates.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                active={template.id === selectedId}
                onSelect={() => setSelectedId(template.id)}
              />
            ))}
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="shrink-0 border-b border-[var(--cf-border)] px-4 py-2.5">
                  <h3 className="truncate text-[13px] font-semibold text-[var(--cf-text)]">
                    {selected.name}
                  </h3>
                  {selected.description && (
                    <p className="mt-0.5 text-[11.5px] text-[var(--cf-text-muted)]">
                      {selected.description}
                    </p>
                  )}
                  {selected.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {selected.tags.map((tag) => (
                        <TagPill key={tag} tag={tag} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <Markdown source={preview} className="cf-markdown-preview text-[12px]" />
                </div>
              </>
            ) : (
              <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--cf-text-muted)]">
                {t("notes.noTemplates")}
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
          {selected && (
            <>
              <button
                type="button"
                onClick={() => setEditing(selected)}
                className="mr-1 flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
              >
                <Pencil size={12} />
                {t("notes.editTemplate")}
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmAction(
                    t("notes.deleteTemplateConfirm", { name: selected.name }),
                    true,
                    t("notes.delete"),
                  ).then((ok) => {
                    if (ok) void deleteTemplate(selected.id);
                  });
                }}
                className="mr-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-danger)] transition-colors hover:bg-[var(--cf-danger)]/10"
              >
                <Trash2 size={12} />
                {t("notes.delete")}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
          >
            {t("notes.cancel")}
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={() => selected && void use(selected)}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {t("notes.useTemplate")}
          </button>
        </div>
      </div>

      {editing && <EditTemplateModal template={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function TemplateRow({
  template,
  active,
  onSelect,
}: {
  template: NoteTemplate;
  active: boolean;
  onSelect: () => void;
}) {
  const Icon = iconOf(template.icon);
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[12px] transition-colors ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
      }`}
    >
      <Icon size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{template.name}</span>
    </button>
  );
}
