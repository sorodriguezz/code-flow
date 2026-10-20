import { useEffect, useRef, useState } from "react";
import { Database, Globe, KeyRound, ListChecks, MessageCircleQuestion, ShieldAlert, type LucideIcon } from "lucide-react";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { fieldClass } from "../common/recipes";
import { useAgentCliStore } from "../../state/agentCliStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { AgentCliAsk } from "../../lib/tauri/events";

/**
 * What an agent asked through `cf`, in front of the user: a question (`cf ask`), a choice
 * (`cf choose`), a destructive command the guard held (`cf guard`), or a saved credential about to
 * be used on its behalf (`cf secret`, `cf db`, `cf http`).
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
 *
 * # Approvals show the thing itself
 *
 * A command, a statement or a request is shown verbatim (`detail`), never summarised: approving a
 * description of a command is not approving the command. "Allow in this terminal" is offered only
 * where the backend says it may be (a database read, a given saved request) — never for the guard
 * or a Llavero entry, where each use is a different command.
 */
export function AgentAskModal() {
  const t = useT();
  const asks = useAgentCliStore((s) => s.asks);
  const answer = useAgentCliStore((s) => s.answer);
  const ask = asks[0] ?? null;
  const waiting = asks.length - 1;
  const [text, setText] = useState("");
  const [always, setAlways] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  // Cleared per question, not per render: the previous answer left in the box would be the wrong
  // default for the next one — the same rule `PromptModal` follows. So is "allow in this terminal".
  useEffect(() => {
    if (!ask) return;
    setText("");
    setAlways(false);
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
  const look = LOOKS[ask.kind] ?? LOOKS.ask;
  const Icon = look.icon;
  const choosing = ask.kind === "choose";
  const approval = look.approval;

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/40 p-6">
      <div className="w-full max-w-[520px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-4 shadow-[var(--cf-shadow)]">
        <div className="flex items-start gap-2">
          <Icon size={16} className={`mt-0.5 shrink-0 ${ask.kind === "guard" ? "text-[var(--cf-danger)]" : "text-[var(--cf-accent)]"}`} />
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-faint)]">
              <span className="min-w-0 flex-1 truncate">{t(look.title)}</span>
              {waiting > 0 && (
                <span className="shrink-0 normal-case tracking-normal">{t("agentcli.askMore", { count: waiting })}</span>
              )}
            </p>
            {ask.cwd && (
              <p title={ask.cwd} className="mt-0.5 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                {ask.cwd}
              </p>
            )}
            {ask.question && (
              <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--cf-text)]">{ask.question}</p>
            )}
          </div>
        </div>

        {ask.detail && (
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 font-mono text-[12px] leading-relaxed text-[var(--cf-text)] select-text">
            {ask.detail}
          </pre>
        )}

        {choosing && (
          <div className="mt-3 flex flex-col gap-1.5">
            {(ask.options ?? []).map((option, index) => (
              <button
                key={`${option}-${index}`}
                type="button"
                onClick={() => answer(true, option)}
                className={buttonClass({ variant: "secondary", className: "w-full justify-start text-left" })}
              >
                {option}
              </button>
            ))}
          </div>
        )}

        <input
          ref={field}
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            // A typed answer to a choice is the answer; anywhere else Enter alone decides nothing.
            if (choosing && text.trim()) answer(true, text);
            else if (!choosing && (event.metaKey || event.ctrlKey)) answer(true, text, always);
          }}
          placeholder={t(choosing ? "agentcli.chooseOther" : "agentcli.askPlaceholder")}
          aria-label={t(choosing ? "agentcli.chooseOther" : "agentcli.askPlaceholder")}
          className={fieldClass({ className: "mt-3 w-full" })}
        />

        {approval && ask.always && (
          <label className="mt-3 flex items-start gap-2 text-[12px] text-[var(--cf-text)]">
            <Checkbox checked={always} onChange={setAlways} className="mt-[1px]" />
            <span>{t("agentcli.allowAlways")}</span>
          </label>
        )}

        <div className="mt-3 flex items-center justify-end gap-2">
          {choosing ? (
            <>
              <button type="button" onClick={() => answer(false, "")} className={buttonClass({ variant: "ghost" })}>
                {t("agentcli.dismiss")}
              </button>
              <button type="button" disabled={!text.trim()} onClick={() => answer(true, text)} className={buttonClass({ variant: "primary" })}>
                {t("agentcli.chooseSend")}
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => answer(false, text)} className={buttonClass({ variant: "ghost" })}>
                {t(approval ? "agentcli.deny" : "agentcli.no")}
              </button>
              <button
                type="button"
                onClick={() => answer(true, text, always)}
                className={buttonClass({ variant: ask.kind === "guard" ? "danger" : "primary" })}
              >
                {t(approval ? "agentcli.allow" : "agentcli.yes")}
              </button>
            </>
          )}
        </div>
        <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">
          {t(look.hint)}
          {approval && ` ${t("agentcli.approvalHintKeys")}`}
        </p>
      </div>
    </div>
  );
}

/** How each kind of question looks: its icon, its title, what the line under it explains, and
 *  whether it is an approval (Allow / Deny) rather than a question (Yes / No). */
const LOOKS: Record<AgentCliAsk["kind"], { icon: LucideIcon; title: TranslationKey; hint: TranslationKey; approval: boolean }> = {
  ask: { icon: MessageCircleQuestion, title: "agentcli.askTitle", hint: "agentcli.askHint", approval: false },
  choose: { icon: ListChecks, title: "agentcli.chooseTitle", hint: "agentcli.chooseHint", approval: false },
  guard: { icon: ShieldAlert, title: "agentcli.guardTitle", hint: "agentcli.guardHint", approval: true },
  secret: { icon: KeyRound, title: "agentcli.secretTitle", hint: "agentcli.secretHint", approval: true },
  db: { icon: Database, title: "agentcli.dbTitle", hint: "agentcli.dbHint", approval: true },
  http: { icon: Globe, title: "agentcli.httpTitle", hint: "agentcli.httpHint", approval: true },
};
