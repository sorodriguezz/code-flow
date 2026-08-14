import { useEffect, useMemo, useState } from "react";
import { Copy, LayoutTemplate, Trash2, X } from "lucide-react";
import { TagPill } from "./notesChrome";
import { Markdown } from "../common/Markdown";
import { builtInTemplates, fillTemplate, titleFromTemplate } from "../../lib/notes/templates";
import { iconOf } from "../../lib/notes/templateIcons";
import type { NoteTemplate } from "../../types/notes";
import { useNotesStore } from "../../state/notesStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * Pick a template to start a note from.
 *
 * Two sources, shown as one list with a divider: the six that ship with the app (translated, not
 * stored — see `lib/notes/templates`) and whatever the user has saved. A preview pane beside the
 * list, because a template's *name* is not enough to choose by and opening three notes to find out
 * is worse than one panel.
 *
 * A built-in cannot be edited or deleted, and the menu doesn't pretend otherwise: there is no row
 * behind it to change. "Duplicate to my templates" is the way in, and it makes a real one.
 */
export function TemplatePickerModal({ onClose }: { onClose: () => void }) {
  const templates = useNotesStore((s) => s.templates);
  const createNote = useNotesStore((s) => s.createNote);
  const deleteTemplate = useNotesStore((s) => s.deleteTemplate);
  const createTemplate = useNotesStore((s) => s.createTemplate);
  const t = useT();

  const builtIn = useMemo(() => builtInTemplates(), []);
  const all = useMemo(() => [...builtIn, ...templates], [builtIn, templates]);
  const [selectedId, setSelectedId] = useState(all[0]?.id ?? "");
  const selected = all.find((template) => template.id === selectedId) ?? all[0] ?? null;

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

  /** A built-in copied into the user's own, which is the only way to get an editable version of
   *  one — there is no row behind a built-in to change. */
  const duplicate = async (template: NoteTemplate) => {
    await createTemplate(
      t("notes.copyOf", { name: template.name }),
      template.description,
      template.icon,
      template.content,
      template.tags,
    );
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
            <Section label={t("notes.builtInTemplates")} />
            {builtIn.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                active={template.id === selectedId}
                onSelect={() => setSelectedId(template.id)}
              />
            ))}
            {templates.length > 0 && <Section label={t("notes.myTemplates")} />}
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
          {selected && !selected.builtIn && (
            <button
              type="button"
              onClick={() => {
                void confirmAction(
                  t("notes.deleteTemplateConfirm", { name: selected.name }),
                  true,
                  t("notes.delete"),
                ).then((ok) => {
                  if (!ok) return;
                  void deleteTemplate(selected.id);
                  setSelectedId(builtIn[0]?.id ?? "");
                });
              }}
              className="mr-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-danger)] transition-colors hover:bg-[var(--cf-danger)]/10"
            >
              <Trash2 size={12} />
              {t("notes.delete")}
            </button>
          )}
          {selected?.builtIn && (
            <button
              type="button"
              onClick={() => void duplicate(selected)}
              className="mr-auto flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
            >
              <Copy size={12} />
              {t("notes.duplicateToMine")}
            </button>
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
    </div>
  );
}

function Section({ label }: { label: string }) {
  return (
    <div className="px-1.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
      {label}
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
