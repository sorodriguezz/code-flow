/**
 * Which engine, model and account a PR review is about to run on, as a tag beside the level
 * selector — and where that is changed.
 *
 * It answers the question *before* the click, which is the only time the answer is worth anything:
 * the review footer already stamps what ran, and by then a review on the wrong model has been paid
 * for. It is the chat's model menu on the `review` row (`ChatModelPicker`, `tag`), which reads the
 * same per-task fallback chain the backend does and writes the row Settings shows — a second door to
 * one setting, so the two cannot disagree.
 */

import { ChatModelPicker } from "./ChatModelPicker";
import { useT } from "../../state/languageStore";

/** The task key the PR review routes under — `AiTask::Review` on the Rust side. */
const TASK = "review";

export function ReviewEngineTag() {
  const t = useT();
  return (
    <ChatModelPicker task={TASK} variant="tag" title={t("pr.reviewEngineHint")} liveModel={null} chatActive={false} />
  );
}
