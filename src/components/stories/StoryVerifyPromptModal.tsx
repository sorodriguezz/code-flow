import { ShieldCheck } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { WorkspacePromptEditor } from "../settings/WorkspacePromptEditor";
import { useT } from "../../state/languageStore";

/**
 * What counts as proof that the code satisfies a criterion.
 *
 * Editable per workspace for the same reason the generator's prompt is, but the thing teams
 * actually change here is the *bar*: whether an implementation with no test still earns a `pass`,
 * whether a criterion covered only by an integration test counts, how hard the model should look
 * before it settles for `unknown`. Those are QA policy, not code.
 *
 * The output contract is restated in the built-in text and must survive any edit — the answer is
 * parsed as JSON, and a template rewritten into prose produces a run that reads the whole
 * repository and then fails to file a single verdict.
 */
export function StoryVerifyPromptModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  return (
    <ApiModal
      icon={ShieldCheck}
      title={t("qa.verifyPromptTitle")}
      subtitle={t("qa.verifyPromptSubtitle")}
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
        <Note>{t("qa.verifyPromptContract")}</Note>
        <WorkspacePromptEditor
          kind="story_verify"
          hintKey="qa.verifyPromptEditorHint"
          placeholderKey="qa.verifyPromptEditorPlaceholder"
          resetConfirmKey="qa.verifyPromptResetConfirm"
          rows={24}
        />
      </div>
    </ApiModal>
  );
}
