import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTeamStore } from "../../../state/teamStore";
import type { TeamMessage } from "../../../types/team";
import { Btn, field } from "../kit/ui";
import { useL } from "../state";

export function QuestionReply({ message }: { message: TeamMessage }) {
  const l = useL();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const send = async (answer: string) => {
    const text = answer.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await useTeamStore.getState().answer(message.run_id, message.id, text);
    } finally {
      setSending(false);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void send(draft);
      }}
      className="flex min-w-0 flex-col gap-2 border-t border-[var(--cf-border)] pt-2"
    >
      {message.options.length > 0 && (
        <ul className="grid min-w-0 gap-1.5">
          {message.options.map((option, index) => (
            <li key={index} className="min-w-0">
              <button
                type="button"
                disabled={sending}
                onClick={() => void send(option)}
                className="flex min-h-8 w-full items-center gap-2 rounded-lg border border-[var(--cf-border-strong)] bg-[var(--cf-surface)] px-2.5 py-2 text-left text-[12px] leading-snug transition-colors hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)] focus-visible:outline-2 focus-visible:outline-[var(--cf-accent)] disabled:opacity-60"
              >
                <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{option}</span>
                <ChevronRight size={13} aria-hidden className="shrink-0 text-[var(--cf-text-muted)]" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        rows={2}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        aria-label={l("Tu respuesta", "Your answer")}
        placeholder={l("Tu respuesta…", "Your answer…")}
        disabled={sending}
        className={`${field} h-auto min-h-[3.25rem] resize-y py-1.5 leading-snug`}
      />
      <Btn type="submit" small kind="primary" disabled={!draft.trim() || sending} className="self-end">
        {l("Responder", "Answer")}
      </Btn>
    </form>
  );
}
