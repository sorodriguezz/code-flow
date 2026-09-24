import { useState } from "react";
import { Database, MessageSquareText, ShieldCheck, SlidersHorizontal, SquarePen, type LucideIcon } from "lucide-react";
import { WorkspacePromptEditor } from "./WorkspacePromptEditor";
import { ReviewContextEditor } from "./ReviewContextEditor";
import { ReviewMemoriesSettings } from "./ReviewMemoriesSettings";
import { ReviewEngineSettings } from "./ReviewEngineSettings";
import { ActiveUnderline } from "../common/ActivePill";
import { underlineStripClass, underlineTabClass } from "../common/recipes";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { SettingsHeader } from "../api/settingsChrome";

type TabId = "standard" | "engine" | "context" | "prDesc" | "memories";

const TABS: { id: TabId; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "standard", labelKey: "settings.reviewTabStandard", icon: ShieldCheck },
  // Right after the methodology, because it is the other half of it: the standard says how a
  // review is done and this says what each depth level actually costs.
  { id: "engine", labelKey: "settings.reviewTabEngine", icon: SlidersHorizontal },
  { id: "context", labelKey: "settings.reviewTabContext", icon: MessageSquareText },
  { id: "prDesc", labelKey: "settings.reviewTabPrDesc", icon: SquarePen },
  { id: "memories", labelKey: "settings.reviewTabMemories", icon: Database },
];

/**
 * The single per-workspace "PR review" section — everything the analysis pipeline reads, gathered
 * behind sub-tabs instead of scattered across the settings menu: the review standard (methodology),
 * project review context, markdown instructions, the PR-description template, and the saved-review
 * memory manager. All of it is provider-independent, so it applies to whatever model each task runs.
 */
export function ReviewSettings() {
  const t = useT();
  const workspaceName = useWorkspaceStore((s) => {
    const id = s.activeWorkspaceId;
    return s.workspaces.find((w) => w.id === id)?.name ?? "";
  });
  const [tab, setTab] = useState<TabId>("standard");

  return (
    <section>
      <SettingsHeader
        title={workspaceName ? t("settings.reviewTitleForProject", { name: workspaceName }) : t("settings.review")}
        hint={t("settings.reviewHint")}
      />

      {/* The shared underline strip, less its own inset: the pane already pads the column, and the
          first tab should start under the heading rather than a step to the right of it. */}
      <div role="tablist" className={`${underlineStripClass} mb-4 pl-0 pr-0`}>
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            // No weight change on select (the recipe keeps every tab at one weight), for the same
            // reason as the settings nav: bolding re-measures the label and shoves every tab to its
            // right along by a few pixels.
            className={underlineTabClass(tab === id)}
          >
            {tab === id && <ActiveUnderline layoutId="cf-review-tab-underline" />}
            <Icon size={14} />
            {t(labelKey)}
          </button>
        ))}
      </div>

      {tab === "standard" && (
        <WorkspacePromptEditor
          kind="review_standard"
          hintKey="settings.reviewStandardHint"
          placeholderKey="settings.reviewStandardPlaceholder"
          resetConfirmKey="settings.reviewStandardResetConfirm"
        />
      )}
      {tab === "engine" && <ReviewEngineSettings />}
      {tab === "context" && <ReviewContextEditor />}
      {tab === "prDesc" && (
        <WorkspacePromptEditor
          kind="pr_description"
          hintKey="settings.prDescHint"
          placeholderKey="settings.prDescPlaceholder"
          resetConfirmKey="settings.prDescResetConfirm"
          rows={12}
        />
      )}
      {tab === "memories" && <ReviewMemoriesSettings />}
    </section>
  );
}
