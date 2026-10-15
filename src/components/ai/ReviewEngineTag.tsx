/**
 * Which engine, model and account a PR review is about to run on, as a tag beside the level
 * selector — and where that is changed for this review.
 *
 * It answers the question *before* the click, which is the only time the answer is worth anything:
 * the review footer already stamps what ran, and by then a review on the wrong model has been paid
 * for. Until something is picked it reads the Review row of Settings (the same fallback chain the
 * backend resolves); a pick is held in `prStore.reviewEngine` and goes with the next review as its
 * own provider + model — a one-off choice that leaves the configured row alone.
 */

import { ChatModelPicker } from "./ChatModelPicker";
import { useT } from "../../state/languageStore";
import { useAiProviderStore, useTaskProvider } from "../../state/aiProviderStore";
import { usePrStore } from "../../state/prStore";
import { useAiAccountsStore } from "../../state/aiAccountsStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { resolveAccount } from "../../lib/aiAccounts";

/** The task key the PR review routes under — `AiTask::Review` on the Rust side. */
const TASK = "review";

export function ReviewEngineTag() {
  const t = useT();
  const routedProvider = useTaskProvider(TASK);
  const routedModel = useAiProviderStore((s) => s.taskModels[TASK] ?? s.model);
  const engine = usePrStore((s) => s.reviewEngine);
  const setEngine = usePrStore((s) => s.setReviewEngine);
  const accounts = useAiAccountsStore((s) => s.accounts);
  const taskPins = useAiAccountsStore((s) => s.taskPins);
  const workspaceDefaults = useAiAccountsStore((s) => s.workspaceDefaults);
  const providerDefaults = useAiAccountsStore((s) => s.providerDefaults);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const provider = engine?.provider ?? routedProvider;
  // An unpinned pick runs on whichever account the backend would resolve, so the tag names that one.
  const account =
    engine?.account !== undefined && engine?.account !== null
      ? engine.account
      : resolveAccount({ accounts, taskPins, workspaceDefaults, providerDefaults }, provider, TASK, workspaceId);
  const bound = { provider, model: engine?.model ?? routedModel, account };
  return (
    <ChatModelPicker
      task={TASK}
      variant="tag"
      title={t("pr.reviewEngineHint")}
      liveModel={null}
      chatActive={false}
      bound={bound}
      onPick={(next, model, picked) =>
        setEngine({ provider: next, model, account: picked ?? (next === engine?.provider ? engine.account : null) })
      }
    />
  );
}
