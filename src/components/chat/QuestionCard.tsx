import { useState } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import { buttonClass } from "../common/Button";
import { answerMessage, type ChatQuestion } from "../../lib/chatQuestions";
import { useT } from "../../state/languageStore";

/**
 * The questions at the end of a model's answer (`lib/chatQuestions`), as something to answer: the
 * options as buttons and «Otra respuesta» to write one's own. A single question with single choice
 * sends on the click; anything else collects first and sends with «Responder».
 *
 * Without `onAnswer` — an older turn, or one the conversation has moved past — it only shows what
 * was asked, so a reopened transcript still reads.
 */
export function QuestionCard({ questions, onAnswer }: { questions: ChatQuestion[]; onAnswer?: (text: string) => void }) {
  const t = useT();
  const [picked, setPicked] = useState<string[][]>(() => questions.map(() => []));
  const [other, setOther] = useState<string[]>(() => questions.map(() => ""));
  const instant = questions.length === 1 && !questions[0].multiple;
  const answers = questions.map((_, i) => [...picked[i], ...(other[i].trim() ? [other[i].trim()] : [])]);
  const complete = answers.every((list) => list.length > 0);

  const send = (list: string[][]) => onAnswer?.(answerMessage(questions, list));
  const choose = (i: number, option: string, multiple: boolean) => {
    if (instant) return send([[option]]);
    setPicked((now) =>
      now.map((list, at) => (at !== i ? list : multiple ? (list.includes(option) ? list.filter((o) => o !== option) : [...list, option]) : [option])),
    );
    if (!multiple) setOther((now) => now.map((text, at) => (at === i ? "" : text)));
  };

  return (
    <div className="mt-2 space-y-2.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-2)] p-2.5 text-[12.5px]">
      {questions.map((q, i) => (
        <div key={i} className="space-y-1.5">
          <p className="flex items-start gap-1.5 font-medium text-[var(--cf-text)]">
            <MessageCircleQuestion size={13} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
            <span>{q.question}</span>
          </p>
          {q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pl-[19px]">
              {q.options.map((option) => {
                const on = picked[i].includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    disabled={!onAnswer}
                    aria-pressed={on}
                    onClick={() => choose(i, option, q.multiple)}
                    className={`rounded-md border px-2 py-0.5 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-60 ${
                      on
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                        : "border-[var(--cf-border)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
          )}
          {onAnswer && (
            <div className="flex items-center gap-1.5 pl-[19px]">
              <input
                value={other[i]}
                onChange={(event) => {
                  const text = event.target.value;
                  setOther((now) => now.map((value, at) => (at === i ? text : value)));
                  if (!q.multiple && text) setPicked((now) => now.map((list, at) => (at === i ? [] : list)));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  if (instant && other[i].trim()) send([[other[i].trim()]]);
                  else if (complete) send(answers);
                }}
                placeholder={t("chat.question.other")}
                aria-label={t("chat.question.other")}
                data-ai-input
                className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-0.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
              />
              {instant && (
                <button type="button" disabled={!other[i].trim()} className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => send([[other[i].trim()]])} aria-label={t("chat.question.send")}>
                  <Send size={12} />
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      {onAnswer && !instant && (
        <div className="flex justify-end">
          <button type="button" disabled={!complete} className={buttonClass({ variant: "primary", size: "sm" })} onClick={() => send(answers)}>
            <Send size={12} />
            {t("chat.question.send")}
          </button>
        </div>
      )}
    </div>
  );
}
