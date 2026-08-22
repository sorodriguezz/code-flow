import { useEffect } from "react";
import { TriangleAlert } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { useLocalAiStore } from "../../state/localAiStore";

/**
 * Whether the local model is doing anything, in the one place the editor already looks for that.
 *
 * The problem it solves: ghost text that has not arrived yet and ghost text that is never coming
 * look identical — an empty line and a caret. Without a mark somewhere, the only way to tell "the
 * model is loading" from "the model had nothing to say" is to keep typing and guess.
 *
 * # It stays silent almost always
 *
 * Three states reach the bar and nothing else does:
 *
 * | State | Shown | Why |
 * |---|---|---|
 * | Idle, or a request that finished in under 300 ms | nothing | The common case. A warm engine answers in ~170 ms, so an indicator tied to *every* request would blink dozens of times a minute and mean nothing. See `THINKING_AFTER_MS`. |
 * | Warming up | orb + "warming up" | Seconds, once, after five idle minutes. This is the wait that needs explaining. |
 * | A request past 300 ms | orb | The answer is genuinely late — cold cache, large model — and this says so. |
 * | Failed | a warning glyph | Something is broken and the editor will keep silently producing nothing until it is fixed. Sends the reader to Settings. |
 *
 * # The orb is the right component here, not a spinner
 *
 * `ThinkingOrb` means *a model is reasoning* and must never be spent on a generic wait — which is
 * exactly why the download bar in `AiCompletionSettings` does not use it. This is the other case:
 * a model on this machine producing tokens. `AgentActivity`, sitting next to this in the same bar,
 * uses it for the same reason.
 */
export function CompletionActivity() {
  const t = useT();
  const thinking = useLocalAiStore((store) => store.thinking);
  const state = useLocalAiStore((store) => store.state);
  const load = useLocalAiStore((store) => store.load);

  // The bar mounts long before any editor does, and `thinking`/`engine` are only meaningful once
  // the store knows whether the feature is even on. Idempotent — the provider calls it too.
  useEffect(() => {
    void load();
  }, [load]);

  // Nothing to say when the user has not turned it on, when this install has no engine, or when
  // the model was never downloaded. A bar item that is permanently dark is furniture.
  if (!state?.enabled || !state.engine_available) return null;

  const engine = state.engine;
  const warming = engine.kind === "starting";
  const failed = engine.kind === "failed";

  if (!warming && !thinking && !failed) return null;

  if (failed) {
    return (
      <Tooltip label={engine.message}>
        <span className="flex items-center gap-1 px-1.5 text-[var(--cf-warning)]">
          <TriangleAlert size={12} />
          <span className="text-[11px]">{t("localai.barFailed")}</span>
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={warming ? t("localai.barWarmingHint") : t("localai.barThinkingHint")}>
      <span className="flex items-center gap-1.5 px-1.5 text-[var(--cf-text-muted)]">
        <ThinkingOrb size="sm" />
        {/* The label only while warming. A one-off wait of several seconds deserves words; a
            request that is merely slow does not need the bar to grow and shove its neighbours
            sideways every time it happens. */}
        {warming && <span className="text-[11px]">{t("localai.barWarming")}</span>}
      </span>
    </Tooltip>
  );
}
