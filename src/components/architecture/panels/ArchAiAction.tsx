/**
 * A lens's AI action — the review board in Review, a decision record in Decisions, the tutor in
 * Learn: the engine picker as the button, an optional line of what to focus on, and the latest
 * answer for this action shown right here.
 */
import { useState } from "react";
import { Info } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import type { ArchAiActionId } from "../../../lib/tauri/architectureCommands";
import { useArchitectureStore } from "../../../state/architectureStore";
import { useT } from "../../../state/languageStore";
import { ChatModelPicker } from "../../ai/ChatModelPicker";
import { AiSparkles } from "../../common/AiGlyph";
import { fieldClass } from "../../common/recipes";
import { Tooltip } from "../../common/Tooltip";
import { useArchModelContext } from "../useArchModel";
import { ArchAnswer, ArchThinking, askArchitecture, useArchAskStore } from "../ai/archAi";

export function ArchAiAction({ action, withInput = action !== "review" }: { action: ArchAiActionId; withInput?: boolean }) {
  const t = useT();
  const model = useArchModelContext();
  const docId = useArchitectureStore((s) => s.draft?.id ?? "");
  const thread = useArchAskStore((s) => s.threads[docId]);
  const running = useArchAskStore((s) => !!s.running[docId]);
  const [focus, setFocus] = useState("");
  const lastIndex = (thread ?? []).map((m, i) => ({ m, i })).filter(({ m }) => m.role === "assistant" && m.action === action).pop()?.i ?? -1;
  const last = lastIndex >= 0 ? thread![lastIndex] : null;
  const run = () => { if (model) void askArchitecture(model, action, focus.trim()); };

  return (
    <div className="grid gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] p-2" data-tour={`arch-ai-${action}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        <ChatModelPicker
          task="architecture"
          variant="button"
          liveModel={null}
          chatActive={false}
          action={{ icon: <AiSparkles size={13} />, label: t(`arch.ai.action.${action}` as TranslationKey), onClick: run, disabled: running || !model }}
        />
        <span className="flex-1" />
        <Tooltip label={t(`arch.ai.action.${action}` as TranslationKey)} description={t(`arch.ai.skills.${action}` as TranslationKey)}>
          <span className="grid h-5 w-5 shrink-0 cursor-help place-items-center text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"><Info size={13} /></span>
        </Tooltip>
      </div>
      {withInput ? (
        <input
          value={focus}
          onChange={(e) => setFocus(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !running) run(); }}
          placeholder={t(`arch.ai.placeholder.${action}` as TranslationKey)}
          className={fieldClass({ size: "sm", className: "w-full" })}
        />
      ) : null}
      <ArchThinking docId={docId} />
      {last ? <ArchAnswer docId={docId} index={lastIndex} message={last} onAnswer={(text) => model && void askArchitecture(model, action, text)} /> : null}
    </div>
  );
}
