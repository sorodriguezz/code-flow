import { useEffect, useState } from "react";
import { LayoutTemplate, X } from "lucide-react";
import { TEMPLATE_ICON_NAMES, iconOf } from "../../lib/notes/templateIcons";
import { useNotesStore } from "../../state/notesStore";
import { useT } from "../../state/languageStore";

/**
 * Turns the open note into a reusable template.
 *
 * The body is taken as-is, `{{date}}` placeholders included — which is the feature, not an
 * oversight: someone who writes "# Reunión — {{date}}" in a note and saves it as a template gets a
 * template that dates itself. The hint under the field says so, because a placeholder nobody knows
 * about is a placeholder nobody uses.
 */
export function SaveTemplateModal({ onClose }: { onClose: () => void }) {
  const draft = useNotesStore((s) => s.draft);
  const notes = useNotesStore((s) => s.notes);
  const createTemplate = useNotesStore((s) => s.createTemplate);
  const t = useT();

  const note = draft ? notes.find((n) => n.id === draft.id) : undefined;
  const [name, setName] = useState(note?.title ?? "");
  const [description, setDescription] = useState("");
  const [icon, setIcon] = useState(TEMPLATE_ICON_NAMES[0]);
  const [busy, setBusy] = useState(false);

  const ready = name.trim().length > 0 && !busy;

  const submit = async () => {
    if (!ready || !draft) return;
    setBusy(true);
    await createTemplate(name.trim(), description.trim(), icon, draft.content, draft.tags);
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

  const field =
    "w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <form
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="cf-fade-in w-[420px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <LayoutTemplate size={14} className="text-[var(--cf-accent)]" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">
            {t("notes.saveAsTemplate")}
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

        <div className="space-y-3 p-4">
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

          <p className="text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("notes.templateVariablesHint")}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
          >
            {t("notes.cancel")}
          </button>
          <button
            type="submit"
            disabled={!ready}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {t("notes.save")}
          </button>
        </div>
      </form>
    </div>
  );
}
