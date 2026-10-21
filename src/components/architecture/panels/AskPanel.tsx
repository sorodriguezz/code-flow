/**
 * Ask: a conversation about the open document. The model reads the whole JSON, the review findings
 * and the simulation, re-reads the document's own sources, opens this section's skills, and answers
 * — asking back when it needs to, and proposing changes the person applies one by one.
 *
 * No sources bar here: the conversation is about the diagram on screen, and what it was generated
 * from is already in what the model reads. Adding a source is the toolbar's «Generar/Actualizar»,
 * which changes the diagram. The composer is the chats' own: the engine chip and the send button
 * inside the box, at its foot.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Eraser, Info } from "lucide-react";
import type { TranslationKey } from "../../../lib/i18n/translations";
import { useArchitectureStore } from "../../../state/architectureStore";
import { useT } from "../../../state/languageStore";
import { ChatModelPicker } from "../../ai/ChatModelPicker";
import { iconButtonClass } from "../../common/Button";
import { Tooltip } from "../../common/Tooltip";
import { useArchModelContext } from "../useArchModel";
import { ArchAnswer, ArchThinking, askArchitecture, useArchAskStore } from "../ai/archAi";

const SUGGESTIONS = ["failure", "explainFlow", "threats", "campaign", "simplify"] as const;
const SKILL_CHIPS = ["codeflow-architecture", "grilling", "architecture-designer", "system-design", "security-threat-model", "teach", "c4-architecture"];

export function AskPanel() {
  const t = useT();
  const model = useArchModelContext();
  const docId = useArchitectureStore((s) => s.draft?.id ?? "");
  const thread = useArchAskStore((s) => s.threads[docId]) ?? [];
  const running = useArchAskStore((s) => !!s.running[docId]);
  const clear = useArchAskStore((s) => s.clear);
  const [input, setInput] = useState("");
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [thread.length, running]);

  const send = (text: string, action: "ask" | "threats" | "tutor" | "design" = "ask") => {
    if (!model || running || !text.trim()) return;
    setInput("");
    void askArchitecture(model, action, text.trim());
  };

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)_auto]" data-tour="arch-ask">
      <div ref={list} className="grid content-start gap-3 overflow-y-auto p-3">
        {thread.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="max-w-[88%] justify-self-end rounded-[12px_12px_4px_12px] bg-[var(--cf-accent-soft)] px-3 py-1.5 text-[12.5px] leading-[1.45] text-[var(--cf-text)]">{m.text}</div>
          ) : (
            <ArchAnswer key={i} docId={docId} index={i} message={m} onAnswer={(text) => send(text, m.action === "ask" || m.action === "threats" || m.action === "tutor" || m.action === "design" ? m.action : "ask")} />
          ),
        )}
        <ArchThinking docId={docId} />
      </div>
      <div className="grid gap-2 p-2.5 pt-1">
        <div className="flex flex-wrap gap-1">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" disabled={running} onClick={() => send(t(`arch.ask.suggest.${s}` as TranslationKey), s === "threats" ? "threats" : s === "explainFlow" ? "tutor" : "ask")} className="rounded-full border border-[var(--cf-border)] px-2.5 py-[2px] text-[11.5px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-45">
              {t(`arch.ask.suggest.${s}` as TranslationKey)}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-1.5 rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1.5 focus-within:border-[color-mix(in_oklab,var(--cf-accent)_45%,var(--cf-border))]">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(input); } }}
            rows={2}
            placeholder={t("arch.ask.placeholder")}
            aria-label={t("arch.ask.placeholder")}
            className="max-h-[160px] resize-none bg-transparent px-1.5 py-1 text-[12.5px] leading-[1.45] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
            data-ai-input
          />
          <div className="flex min-w-0 items-center gap-1 px-0.5">
            <div className="min-w-0 overflow-hidden whitespace-nowrap">
              <ChatModelPicker task="architecture" liveModel={null} chatActive={false} />
            </div>
            <span className="flex-1" />
            <Tooltip label={t("arch.ask.skills")} description={SKILL_CHIPS.join(" · ")}>
              <span className="grid h-6 w-6 shrink-0 cursor-help place-items-center text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"><Info size={13} /></span>
            </Tooltip>
            {thread.length ? (
              <Tooltip label={t("arch.ask.clear")}><button type="button" className={iconButtonClass({ size: "xs" })} onClick={() => clear(docId)} aria-label={t("arch.ask.clear")}><Eraser size={13} /></button></Tooltip>
            ) : null}
            <button
              type="button"
              disabled={running || !input.trim()}
              onClick={() => send(input)}
              title={t("arch.ask.send")}
              aria-label={t("arch.ask.send")}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)] hover:bg-[color-mix(in_oklab,var(--cf-accent-fill)_86%,var(--cf-text))] disabled:opacity-40"
            >
              <ArrowUp size={13} />
            </button>
          </div>
        </div>
        <button type="button" disabled={running} className="justify-self-start text-left text-[11.5px] text-[var(--cf-accent)] hover:underline disabled:opacity-45" onClick={() => send(input.trim() || t("arch.ask.designDefault"), "design")}>
          {t("arch.ask.design")}
        </button>
      </div>
    </div>
  );
}
