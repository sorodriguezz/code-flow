import { useState } from "react";
import { Folder } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Field } from "../settings/modelPicker";
import { ACCENT_OPTIONS } from "../../state/accentStore";
import { useAgentsStore } from "../../state/agentsStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { AgentProject } from "../../types/domain";

/** The accent palette rather than a second list of hexes: those shades are already checked against
 * both themes, and a folder's colour is drawn as a glyph in the same rail the accent tints. */
const PROJECT_COLORS = ACCENT_OPTIONS.map((option) => option.light);

/**
 * Create or edit a folder for agent work.
 *
 * The subtitle earns its place. In this view "project" already means the git working copy a turn
 * runs in — the field the rest of the UI calls `agents.repository` — and this dialog gives the word
 * a second owner, so it says up front what the folder is *not*: nothing here changes where an agent
 * runs, and deleting it later leaves the work standing.
 */
export function AgentProjectModal({
  project,
  onClose,
}: {
  /** `null` creates a new one. */
  project: AgentProject | null;
  onClose: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [color, setColor] = useState(project?.color ?? PROJECT_COLORS[0]);
  const [saving, setSaving] = useState(false);

  const blank = name.trim() === "";

  const save = async () => {
    if (blank) return;
    setSaving(true);
    try {
      await useAgentsStore.getState().saveProject({
        id: project?.id,
        name: name.trim(),
        description: description.trim(),
        color,
      });
      onClose();
    } catch (e) {
      // The one refusal the backend has for this dialog arrives as a translation key rather than a
      // sentence, so it can be read in the reader's language; anything else came from further down
      // and is shown as it arrived.
      const reason = String(e);
      pushErrorToast(reason === "agents.projectNameRequired" ? t("agents.projectNameRequired") : reason);
    } finally {
      setSaving(false);
    }
  };

  return (
    <ApiModal
      icon={Folder}
      title={t(project ? "agents.editProjectTitle" : "agents.newProjectTitle")}
      subtitle={t("agents.newProjectSubtitle")}
      width="max-w-md"
      busy={saving}
      // A form holding unsaved input has nothing to recover from a mis-click on the backdrop.
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <span className="ml-auto flex items-center gap-2">
          <GhostButton onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={saving || blank}>
            {t("common.save")}
          </PrimaryButton>
        </span>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {blank && <Note tone="warning">{t("agents.projectNameRequired")}</Note>}

        <Field label={t("agents.projectName")}>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("agents.projectNamePlaceholder")}
            className="w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[13px] font-medium outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        <Field label={t("agents.projectDescription")}>
          <textarea
            value={description}
            rows={3}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("agents.projectDescriptionPlaceholder")}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        <Field label={t("agents.projectColor")}>
          <div className="flex flex-wrap items-center gap-2">
            {PROJECT_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                title={swatch}
                onClick={() => setColor(swatch)}
                className="h-5 w-5 shrink-0 rounded-full ring-1 ring-inset ring-black/10 dark:ring-white/20"
                style={{
                  background: swatch,
                  // The ring is drawn as two shadows so the halo sits outside the swatch instead of
                  // shrinking it — a selected colour that changed size would read as a hover.
                  boxShadow:
                    color === swatch ? `0 0 0 2px var(--cf-surface), 0 0 0 3.5px ${swatch}` : undefined,
                }}
              />
            ))}
          </div>
        </Field>
      </div>
    </ApiModal>
  );
}
