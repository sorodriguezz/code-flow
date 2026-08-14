import { useEffect, useState } from "react";
import { LayoutTemplate, X } from "lucide-react";
import { MarkdownEditor } from "../common/MarkdownEditor";
import { NoteTagBar } from "./NoteTagBar";
import { TEMPLATE_ICON_NAMES, iconOf } from "../../lib/notes/templateIcons";
import { serializeTags } from "../../lib/notes/tags";
import type { NoteTemplate } from "../../types/notes";
import { useNotesStore } from "../../state/notesStore";
import { useT } from "../../state/languageStore";

/**
 * Edits a template in place — name, description, icon, tags and body — including the six that
 * ship with the app, which `notesStore.setWorkspace` has already turned into ordinary rows by the
 * time this can open. There is no built-in/custom distinction left to enforce here.
 *
 * Its own dialog rather than the picker's preview pane turning editable in place: the picker is
 * 760px built for a name, a description and rendered Markdown, and a body field wants room to
 * type in, not the width left over from a list column.
 */
export function EditTemplateModal({
  template,
  onClose,
}: {
  template: NoteTemplate;
  onClose: () => void;
}) {
  const updateTemplate = useNotesStore((s) => s.updateTemplate);
  const t = useT();

  const [name, setName] = useState(template.name);
  const [description, setDescription] = useState(template.description);
  const [icon, setIcon] = useState(template.icon);
  const [tags, setTags] = useState(template.tags);
  const [content, setContent] = useState(template.content);
  const [busy, setBusy] = useState(false);

  const ready = name.trim().length > 0 && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    await updateTemplate({
      id: template.id,
      workspace_id: template.workspace_id,
      name: name.trim(),
      description: description.trim(),
      icon,
      content,
      tags: serializeTags(tags),
      sort_order: template.sort_order,
      created_at: template.created_at,
      updated_at: template.updated_at,
    });
    onClose();
  };

  // Escape closes, like every other dialog in the app. On `window` rather than the panel, because
  // focus may legitimately be inside a field, a suggestion list, or the body editor.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const field =
    "w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";

  return (
    // `z-[65]`, above the picker (`z-[60]`) it opens on top of — see `ApiModal`'s header comment
    // for the tiers this follows. `stopPropagation` on the backdrop click matters here in a way it
    // doesn't for a dialog opened from a plain page: this one is mounted *inside* the picker's own
    // backdrop div, so without it a click meant to dismiss this dialog would keep bubbling and
    // close the picker underneath it in the same gesture.
    <div
      className="fixed inset-0 z-[65] flex items-center justify-center bg-black/30 p-4"
      onClick={(event) => {
        event.stopPropagation();
        onClose();
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="cf-fade-in flex h-[600px] max-h-[calc(100vh-2rem)] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <LayoutTemplate size={14} className="text-[var(--cf-accent)]" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">
            {t("notes.editTemplate")}
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

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.templateName")}
            </span>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={field}
              placeholder={t("notes.templateNamePlaceholder")}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.templateDescription")}
            </span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={field}
              placeholder={t("notes.templateDescriptionPlaceholder")}
            />
          </label>

          <div>
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.templateIcon")}
            </span>
            <div className="flex flex-wrap gap-1">
              {TEMPLATE_ICON_NAMES.map((name_) => {
                const Icon = iconOf(name_);
                return (
                  <button
                    key={name_}
                    type="button"
                    onClick={() => setIcon(name_)}
                    aria-pressed={icon === name_}
                    aria-label={name_}
                    className={`flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
                      icon === name_
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                        : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                    }`}
                  >
                    <Icon size={13} />
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.tags")}
            </span>
            <NoteTagBar tags={tags} onChange={setTags} />
          </div>

          <div>
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              {t("notes.templateContent")}
            </span>
            <div className="min-h-0" style={{ height: 260 }}>
              <MarkdownEditor
                value={content}
                onChange={setContent}
                placeholder={t("notes.templateNamePlaceholder")}
                ariaLabel={t("notes.templateContent")}
                historyKey={template.id}
              />
            </div>
          </div>

          <p className="text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("notes.templateVariablesHint")}
          </p>
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
          >
            {t("notes.cancel")}
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void submit()}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {t("notes.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
