import { SquarePen } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { WorkspacePromptEditor } from "../settings/WorkspacePromptEditor";
import { useT } from "../../state/languageStore";

/**
 * The house style of the generated stories: INVEST wording, Gherkin vs checklist criteria, which
 * language, how many criteria per story.
 *
 * Per workspace and shared by every set, which is why it is *not* the "extra instructions" field on
 * the rail — that one is about one document ("split payments into its own story"), this one is
 * about how this team writes stories at all. Reuses the same editor as the review standard and the
 * PR-description template, so "restore default" and the autosave-on-blur behave identically.
 *
 * Opened from the set rather than from Settings because it is edited while looking at the stories
 * it produced — the reason to change it is always a batch that came out wrong.
 */
export function StoryPromptModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <ApiModal
      icon={SquarePen}
      title={t("stories.promptTitle")}
      subtitle={t("stories.promptSubtitle")}
      width="max-w-3xl"
      height="h-[80vh]"
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <GhostButton onClick={onClose}>
          <span className="ml-auto">{t("common.close")}</span>
        </GhostButton>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <Note>{t("stories.promptContract")}</Note>
        <WorkspacePromptEditor
          kind="user_stories"
          hintKey="stories.promptEditorHint"
          placeholderKey="stories.promptEditorPlaceholder"
          resetConfirmKey="stories.promptResetConfirm"
          rows={24}
        />
      </div>
    </ApiModal>
  );
}
