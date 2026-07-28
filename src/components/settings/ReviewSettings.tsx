import { useState } from "react";
import { Database, MessageSquareText, ShieldCheck, SquarePen, type LucideIcon } from "lucide-react";
import { WorkspacePromptEditor } from "./WorkspacePromptEditor";
import { ReviewContextEditor } from "./ReviewContextEditor";
import { ReviewMemoriesSettings } from "./ReviewMemoriesSettings";
import { ActiveUnderline } from "../common/ActivePill";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

type TabId = "standard" | "context" | "prDesc" | "memories";

const TABS: { id: TabId; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "standard", labelKey: "settings.reviewTabStandard", icon: ShieldCheck },
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
      <div className="mb-3">
        <h3 className="text-sm font-semibold">
          {workspaceName ? t("settings.reviewTitleForProject", { name: workspaceName }) : t("settings.review")}
        </h3>
      </div>

      <div className="mb-4 flex flex-wrap gap-1 border-b border-[var(--cf-border)]">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            // No weight change on select, for the same reason as the settings nav: bolding
            // re-measures the label and shoves every tab to its right along by a few pixels.
            className={`relative -mb-px flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] ${
              tab === id ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {tab === id && <ActiveUnderline layoutId="cf-review-tab-underline" />}
            <Icon size={13} />
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
