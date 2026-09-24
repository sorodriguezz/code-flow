import { Check, SlidersHorizontal } from "lucide-react";
import { Tooltip } from "../common/Tooltip";
import { iconButtonClass } from "../common/Button";
import { IconGlyph } from "../common/FileGlyph";
import { explorerHeadClass, explorerTitleClass, rowClass, sectionLabelClass } from "../common/recipes";
import { DEFAULT_PROFILE_ID, profileById } from "../../lib/icons/profiles";
import { previewIcons } from "../../lib/icons/packs";
import { AUTO_PROFILE, useIconRulesStore } from "../../state/iconRulesStore";
import { useUiStore } from "../../state/uiStore";
import { useT } from "../../state/languageStore";

/**
 * Which icon pack this repository's tree is drawn with — the sixth panel of the editor's rail, under
 * the debugger.
 *
 * It started as a button in the explorer's header with a floating menu, and the user asked for it to
 * be a panel like its neighbours instead (2026-09-24): the choice sits in the column the tree itself
 * sits in, one row per option, with room for what a menu had none for — a preview of each pack's
 * glyphs, and what "automatic" resolved to for this checkout.
 *
 * **Per repository.** Every row calls the same `selectProfile` the Settings selector does: the
 * choice is this repository's own, remembered, and followed by every window showing it; several
 * repositories are free to share a pack (see `iconRulesStore`). Editing a pack's rules is still a
 * Settings job — they are shared by every repository on it — and the header button goes there.
 */
export function IconProfilePanel() {
  const t = useT();
  const profiles = useIconRulesStore((s) => s.profiles);
  const activeId = useIconRulesStore((s) => s.activeId);
  const autoSelected = useIconRulesStore((s) => s.autoSelected);
  const detectedId = useIconRulesStore((s) => s.detectedId);
  const repoPath = useIconRulesStore((s) => s.repoPath);
  const selectProfile = useIconRulesStore((s) => s.selectProfile);
  const openSettingsAt = useUiStore((s) => s.openSettingsAt);

  const repoName = repoPath ? (repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath) : "";
  /** What "automatic" draws with right now: the detected pack, else the default. */
  const autoProfile = profileById(profiles, detectedId ?? DEFAULT_PROFILE_ID);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={explorerHeadClass}>
        <span className={`${explorerTitleClass} mr-auto`}>
          <span className="truncate">{t("icons.panelTitle")}</span>
        </span>
        <Tooltip side="bottom" label={t("icons.editRules")}>
          <button
            onClick={() => openSettingsAt("editor", "icons")}
            aria-label={t("icons.editRules")}
            className={iconButtonClass({ size: "sm" })}
          >
            <SlidersHorizontal size={14} />
          </button>
        </Tooltip>
      </div>

      <p className="shrink-0 px-3.5 pb-2 text-[12px] leading-snug text-[var(--cf-text-muted)]">
        {t("icons.panelHint", { repo: repoName })}
      </p>

      <div
        role="radiogroup"
        aria-label={t("icons.profileFor", { repo: repoName })}
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-3"
      >
        {repoPath && autoProfile && (
          <OptionRow
            title={t("icons.auto")}
            subtitle={
              detectedId
                ? t("icons.autoDetected", { name: autoProfile.name })
                : t("icons.autoFallback", { name: autoProfile.name })
            }
            preview={previewIcons(autoProfile)}
            selected={autoSelected}
            onPick={() => void selectProfile(AUTO_PROFILE)}
          />
        )}
        <div className={`${sectionLabelClass} px-1.5`}>{t("icons.profilesHeading")}</div>
        {profiles.map((profile) => (
          <OptionRow
            key={profile.id}
            title={profile.name}
            preview={previewIcons(profile)}
            selected={!autoSelected && profile.id === activeId}
            onPick={() => void selectProfile(profile.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** One choice: its name (and, for "automatic", what it resolved to), four glyphs, and a tick. */
function OptionRow({
  title,
  subtitle,
  preview,
  selected,
  onPick,
}: {
  title: string;
  subtitle?: string;
  preview: string[];
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onPick}
      className={rowClass(selected, `shrink-0 py-1.5 ${subtitle ? "min-h-11" : "min-h-8"}`)}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className={`truncate ${selected ? "font-medium" : ""}`}>{title}</span>
        {subtitle && <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{subtitle}</span>}
      </span>
      <span aria-hidden className="flex shrink-0 items-center gap-1">
        {preview.map((id) => (
          <IconGlyph key={id} id={id} size={14} />
        ))}
      </span>
      {selected ? (
        <Check size={14} className="shrink-0 text-[var(--cf-accent)]" />
      ) : (
        <span aria-hidden className="w-3.5 shrink-0" />
      )}
    </button>
  );
}
