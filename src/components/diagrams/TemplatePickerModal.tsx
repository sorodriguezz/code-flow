import { useEffect, useState } from "react";
import { LayoutTemplate, Plus, Table2, Trash2, X } from "lucide-react";
import { TagPill } from "../notes/notesChrome";
import { ICON_BUTTON } from "./diagramsChrome";
import { templateIcon } from "../../lib/diagrams/templateIcons";
import { FORMAT_DBML } from "../../lib/diagrams/doc";
import type { DiagramFormat, DiagramTemplate } from "../../types/diagrams";
import { useDiagramsStore } from "../../state/diagramsStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";

/**
 * Pick a template to start a diagram from.
 *
 * One list: the five that ship with the app and whatever the user has saved since, in whatever
 * order `diagramsStore` holds them. They read the same because they *are* the same kind of row —
 * see the one-time seed in `diagramsStore.setWorkspace` — so there is nothing here that says
 * "built-in": every template can be used or deleted the same way.
 *
 * **The preview is the template's own thumbnail, and there isn't one.** A template is stored as a
 * document, not as a picture, and rendering one would mean booting draw.io five times to fill a
 * dialog. So the list leads with the icon and the description, which is what a person chooses by
 * anyway — and choosing wrong costs one undo, because a diagram made from a template is an
 * ordinary diagram.
 */
export function TemplatePickerModal({
  folderId,
  onClose,
}: {
  /** Where the new diagram is filed. `null` is the root. */
  folderId: string | null;
  onClose: () => void;
}) {
  const templates = useDiagramsStore((s) => s.templates);
  const createFromTemplate = useDiagramsStore((s) => s.createFromTemplate);
  const createDiagram = useDiagramsStore((s) => s.createDiagram);
  const deleteTemplate = useDiagramsStore((s) => s.deleteTemplate);
  const t = useT();

  const [busy, setBusy] = useState(false);

  // Escape closes, like every other dialog in the app. On `window` rather than the panel, because
  // focus may legitimately be inside a button, a list, or nothing at all.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const use = async (template: DiagramTemplate) => {
    if (busy) return;
    setBusy(true);
    await createFromTemplate(folderId, template);
    onClose();
  };

  const blank = async (format?: DiagramFormat) => {
    if (busy) return;
    setBusy(true);
    await createDiagram(folderId, undefined, format);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("diagrams.templatePickerTitle")}
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--cf-border)] px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 className="text-[13px] font-semibold">{t("diagrams.templatePickerTitle")}</h2>
            <p className="text-[11.5px] text-[var(--cf-text-muted)]">
              {t("diagrams.templatePickerSubtitle")}
            </p>
          </div>
          <button type="button" className={ICON_BUTTON} aria-label={t("diagrams.close")} onClick={onClose}>
            <X size={14} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
            {/* First, and not part of the list: an empty canvas is not a template, it is what you
                pick when none of them fit. Putting it here means the picker can be the one door
                into "new diagram" rather than a second button beside it. */}
            <button
              type="button"
              onClick={() => void blank()}
              disabled={busy}
              className="flex items-start gap-2.5 rounded-lg border border-dashed border-[var(--cf-field-border)] p-3 text-left transition-colors hover:border-[var(--cf-accent)] disabled:opacity-50"
            >
              <Plus size={15} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[12px] font-medium">
                  {t("diagrams.blankDiagram")}
                </span>
                <span className="text-[11px] text-[var(--cf-text-muted)]">
                  {t("diagrams.blankDiagramDesc")}
                </span>
              </span>
            </button>

            {/* The second empty start, and the only place in the app where the *dialect* of a new
                diagram is chosen. It has to be a card of its own rather than a toggle on the one
                above: which editor opens is decided here and never again, so it is a choice
                between two things and not a setting on one. */}
            <button
              type="button"
              onClick={() => void blank(FORMAT_DBML)}
              disabled={busy}
              className="flex items-start gap-2.5 rounded-lg border border-dashed border-[var(--cf-field-border)] p-3 text-left transition-colors hover:border-[var(--cf-accent)] disabled:opacity-50"
            >
              <Table2 size={15} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-[12px] font-medium">
                  {t("diagrams.newDbmlDiagram")}
                </span>
                <span className="text-[11px] text-[var(--cf-text-muted)]">
                  {t("diagrams.tpl.dbml.desc")}
                </span>
              </span>
            </button>

            {templates.map((template) => {
              const Icon = templateIcon(template.icon);
              return (
                <div
                  key={template.id}
                  className="group/tpl relative flex items-start gap-2.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-field)] p-3 transition-colors hover:border-[var(--cf-accent)]"
                >
                  <button
                    type="button"
                    onClick={() => void use(template)}
                    disabled={busy}
                    className="flex min-w-0 flex-1 items-start gap-2.5 text-left disabled:opacity-50"
                  >
                    <Icon size={15} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate text-[12px] font-medium">{template.name}</span>
                      {template.description && (
                        <span className="text-[11px] text-[var(--cf-text-muted)]">
                          {template.description}
                        </span>
                      )}
                      {template.tags.length > 0 && (
                        <span className="mt-1 flex flex-wrap gap-1">
                          {template.tags.map((tag) => (
                            <TagPill key={tag} tag={tag} />
                          ))}
                        </span>
                      )}
                    </span>
                  </button>
                  {/* Revealed on hover rather than always drawn: a grid of cards each wearing a
                      delete button reads as a management screen, and this one is a picker. */}
                  <button
                    type="button"
                    aria-label={t("diagrams.deleteTemplate")}
                    title={t("diagrams.deleteTemplate")}
                    className={`${ICON_BUTTON} opacity-0 transition-opacity group-hover/tpl:opacity-100 focus-visible:opacity-100`}
                    onClick={() => {
                      void confirmAction(
                        t("diagrams.deleteTemplateConfirm", { name: template.name }),
                      ).then((ok) => ok && void deleteTemplate(template.id));
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </div>

          {templates.length === 0 && (
            <p className="flex items-center justify-center gap-2 px-2 py-8 text-center text-[11.5px] text-[var(--cf-text-muted)]">
              <LayoutTemplate size={14} />
              {t("diagrams.noTemplates")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
