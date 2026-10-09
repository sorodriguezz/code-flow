import { ArrowRight } from "lucide-react";
import { ReviewContextEditor } from "./ReviewContextEditor";
import { ReviewMemoriesSettings } from "./ReviewMemoriesSettings";
import { ReviewEngineSettings } from "./ReviewEngineSettings";
import { RailSection } from "./settingsNav";
import { chipClass } from "../common/recipes";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";

/**
 * The per-workspace "PR review" section — what the analysis pipeline reads beyond its prompts: how
 * deep each level goes, the project's own context, and the saved-review memory. All of it is
 * provider-independent, so it applies to whatever model each task runs.
 *
 * On a rail like every other section since 2026-10-09 (it was the one horizontal strip), and
 * without its two prompt tabs: the review standard and the PR description are edited in «Tareas y
 * prompts» only — they used to be editable from both places.
 */
export function ReviewSettings() {
  const t = useT();
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.name ?? "");

  return (
    <RailSection
      section="review"
      title={t("settings.review")}
      hint={t("settings.reviewHint")}
      fallback="engine"
      aside={workspaceName ? <span className={chipClass("neutral")}>{t("settings.workspaceScope", { name: workspaceName })}</span> : undefined}
    >
      {(tab) => (
        <>
          {tab === "engine" && (
            <>
              <button
                type="button"
                onClick={() => useUiStore.getState().openSettingsAt("tasks", "review")}
                className="mb-3 flex w-full items-start gap-2 rounded-md bg-[var(--cf-accent-soft)] px-3 py-2 text-left text-[12px] leading-snug text-[var(--cf-text)] hover:brightness-[0.98]"
              >
                <ArrowRight size={13} className="mt-[2px] shrink-0 text-[var(--cf-accent)]" />
                <span>{t("settings.reviewPromptsMoved")}</span>
              </button>
              <ReviewEngineSettings />
            </>
          )}
          {tab === "context" && <ReviewContextEditor />}
          {tab === "memories" && <ReviewMemoriesSettings />}
        </>
      )}
    </RailSection>
  );
}
