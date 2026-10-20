import { useEffect, useRef, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { useAgentCliStore } from "../../state/agentCliStore";
import { useT } from "../../state/languageStore";

/**
 * The question an agent asked with `cf ask`, in front of the user.
 *
 * # Why this is a dialog and not a line in a transcript
 *
 * A shell is blocked on the answer. The agent ran `cf ask "drop the column?"` and is sitting there
 * — so this is not a notification to be read later, it is the only thing standing between a process
 * and what it does next. It takes the window the way a confirmation does, and it says which folder
 * the question came from, because an answer given to the wrong worktree is the failure that matters.
 *
 * # Why Yes and No are buttons and not something typed
 *
 * The exit code is the verdict — `cf ask "go ahead?" && …` runs the second half on a zero — so it
 * cannot come from the text: typing "no" and pressing Enter once counted as an answer, and an
 * answer as success. The box is a note that `cf` prints either way; the verdict is a button press.
 * Enter alone does nothing for that reason, ⌘/Ctrl+Enter is Yes and Escape is No.
 */
export function AgentAskModal() {
  const t = useT();
  const asks = useAgentCliStore((s) => s.asks);
  const answer = useAgentCliStore((s) => s.answer);
  const ask = asks[0] ?? null;
  const waiting = asks.length - 1;
  const [text, setText] = useState("");
  const field = useRef<HTMLInputElement>(null);

  // Cleared per question, not per render: the previous answer left in the box would be the wrong
  // default for the next one — the same rule `PromptModal` follows.
  useEffect(() => {
    if (!ask) return;
    setText("");
    field.current?.focus();
  }, [ask]);

  useEffect(() => {
    if (!ask) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") answer(false, "");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [ask, answer]);

  if (!ask) return null;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-[460px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]">
        <div className="flex items-start gap-2">
          <MessageCircleQuestion size={16} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-faint)]">
              <span className="min-w-0 flex-1 truncate">{t("agentcli.askTitle")}</span>
              {waiting > 0 && (
                <span className="shrink-0 normal-case tracking-normal">{t("agentcli.askMore", { count: waiting })}</span>
              )}
            </p>
            {ask.cwd && (
              <p title={ask.cwd} className="mt-0.5 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                {ask.cwd}
              </p>
            )}
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--cf-text)]">{ask.question}</p>
          </div>
        </div>

        <input
          ref={field}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              answer(true, text);
            }
          }}
          placeholder={t("agentcli.askPlaceholder")}
          aria-label={t("agentcli.askPlaceholder")}
          className={fieldClass({ className: "mt-3 w-full" })}
        />

        <div className="mt-3 flex items-center justify-end gap-2">
          <button type="button" onClick={() => answer(false, text)} className={buttonClass({ variant: "ghost" })}>
            {t("agentcli.no")}
          </button>
          <button type="button" onClick={() => answer(true, text)} className={buttonClass({ variant: "primary" })}>
            {t("agentcli.yes")}
          </button>
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">{t("agentcli.askHint")}</p>
      </div>
    </div>
  );
}
