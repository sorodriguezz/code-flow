/**
 * Which engine and model a PR review is about to run on, as a tag beside the level selector.
 *
 * It answers the question *before* the click, which is the only time the answer is worth anything:
 * the review footer already stamps what ran, and by then a review on the wrong model has been paid
 * for. Read from `aiProviderStore`, which resolves the same per-task fallback chain the backend
 * does (`ai_provider_review` → the global provider; `{provider}_review_model` → `{provider}_model`),
 * so this cannot disagree with what actually runs.
 *
 * A label, never a control. Changing the routing is Settings' job, and a picker here would be a
 * second place to set it — which is how the two end up disagreeing.
 */

import { AI_PROVIDERS, DEFAULT_AI_PROVIDER } from "../../lib/aiProviders";
import { ProviderGlyph } from "./ProviderGlyph";
import { useAiProviderStore } from "../../state/aiProviderStore";
import { useT } from "../../state/languageStore";

/** The task key the PR review routes under — `AiTask::Review` on the Rust side. */
const TASK = "review";

export function ReviewEngineTag() {
  const t = useT();
  const defaultProvider = useAiProviderStore((s) => s.providerId);
  const routed = useAiProviderStore((s) => s.taskProviders[TASK]);
  const model = useAiProviderStore((s) => s.taskModels[TASK]);

  const providerId = routed?.trim() || defaultProvider || DEFAULT_AI_PROVIDER;
  const provider = AI_PROVIDERS.find((entry) => entry.id === providerId);
  // Blank is a real state, not a missing read: neither the task override nor the provider's base
  // model is set, so the CLI picks — and saying that is more useful than showing nothing.
  const modelLabel = model?.trim() || t("pr.reviewEngineDefaultModel");

  return (
    <span
      // `ml-auto` rather than a fixed position: on a narrow panel the row wraps and the tag simply
      // drops to the next line instead of squeezing the selector it sits beside.
      className="ml-auto flex min-w-0 shrink items-center gap-1 rounded border border-[var(--cf-border)] px-1.5 py-px text-[10px] text-[var(--cf-text-muted)]"
      title={t("pr.reviewEngineHint", { provider: provider?.label ?? providerId, model: modelLabel })}
    >
      <ProviderGlyph providerId={providerId} size={10} />
      <span className="truncate">{modelLabel}</span>
    </span>
  );
}
