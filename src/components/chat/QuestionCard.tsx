import { useId, useMemo, useReducer, useState, type KeyboardEvent } from "react";
import { ArrowRight, Check, ChevronDown, MessageCircleQuestion, Pencil, Send } from "lucide-react";
import { buttonClass } from "../common/Button";
import { answerMessage, answersIn, type ChatQuestion } from "../../lib/chatQuestions";
import { collectQuestionAnswers, countQuestionAnswers, createQuestionAnswers, QUESTION_ANSWER_ACTION, questionAnswersReducer } from "../../lib/questionAnswers";
import { useT } from "../../state/languageStore";

const NO_QUESTIONS = 0;
const SINGLE_QUESTION = 1;
const QUESTION_ICON_SIZE = 13;
const SEND_ICON_SIZE = 12;
const SUBMIT_KEY = "Enter";
/** Options past the ninth have no key to press; they are still a click away. */
const KEYED_OPTIONS = 9;
const OTHER_LABEL = "chat.question.other";
const OTHER_ENTER_LABEL = "chat.question.otherEnter";
const SEND_LABEL = "chat.question.send";
const SEND_ALL_LABEL = "chat.question.sendAll";
const PROGRESS_LABEL = "chat.question.progress";
const MULTIPLE_LABEL = "chat.question.multiple";
const CARD_CLASS = "mt-1 min-w-0 max-w-[36rem] overflow-hidden rounded-[10px] bg-[var(--cf-surface-raised)] text-[12.5px] shadow-[inset_0_0_0_1px_var(--cf-border)]";
const QUESTIONS_CLASS = "max-h-[min(50vh,28rem)] space-y-3 overflow-y-auto overscroll-contain px-2.5 pb-2 pt-2.5";
const QUESTION_CLASS = "min-w-0";
const LEGEND_CLASS = "mb-1.5 flex max-w-full items-start gap-1.5 font-semibold leading-snug text-[var(--cf-text)]";
const QUESTION_ICON_CLASS = "mt-0.5 shrink-0 text-[var(--cf-accent)]";
const QUESTION_TEXT_CLASS = "min-w-0 [overflow-wrap:anywhere]";
const MULTIPLE_CLASS = "mb-1 pl-[19px] text-[11px] text-[var(--cf-text-muted)]";
const OPTIONS_CLASS = "flex min-w-0 flex-col gap-0.5";
const OPTION_CLASS = "group/opt flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left leading-snug text-[var(--cf-text)] transition-colors disabled:cursor-default disabled:opacity-60";
const SELECTED_CLASS = "bg-[var(--cf-accent-soft)]";
const UNSELECTED_CLASS = "hover:bg-[var(--cf-accent-soft)]";
const KEY_CLASS = "flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] font-mono text-[10.5px] font-semibold";
const KEY_IDLE_CLASS = "text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)]";
const KEY_ON_CLASS = "bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)]";
const OTHER_CLASS = "flex min-w-0 cursor-text items-center gap-2 rounded-md px-1.5 py-1 text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] focus-within:bg-[var(--cf-hover)]";
const INPUT_CLASS = "min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)]";
const FOOTER_CLASS = "flex items-center gap-2 px-3 pb-2.5 pt-0.5";
const PROGRESS_CLASS = "tabular-nums text-[11px] text-[var(--cf-text-faint)]";
const SUBMIT_CLASS = `ml-auto ${buttonClass({ variant: "primary", size: "sm" })}`;
const SUBMIT_BUTTON_TYPE = "button";

interface QuestionCardProps {
  questions: ChatQuestion[];
  /** Present only on the latest answer: an earlier card folds into one line. */
  onAnswer?: (text: string) => void;
  /** The message that followed these questions, for a folded card to show what was chosen. */
  answeredWith?: string;
}

/**
 * The questions an answer ends with (`lib/chatQuestions`).
 *
 * Three shapes, by what the card is for (user ask, 2026-11-23 — the old card spent a grey header
 * band on «Elige tus respuestas y luego envíalas juntas.» and a grey footer band on one button,
 * around a single question):
 * - one single-choice question: the options are the answer — a click (or its number key) sends it;
 * - several questions, or one that takes several options: pick, then one line at the bottom with
 *   the progress and the send button;
 * - an earlier answer's questions: folded into one line that opens on a click, with «✓ chosen»
 *   when the next message picked one of its options.
 */
export function QuestionCard(props: QuestionCardProps) {
  const questionSetKey = JSON.stringify(props.questions);
  if (props.questions.length === NO_QUESTIONS) return null;
  if (!props.onAnswer) return <PastQuestions questions={props.questions} answeredWith={props.answeredWith} />;
  return <QuestionAnswers key={questionSetKey} questions={props.questions} onAnswer={props.onAnswer} />;
}

function QuestionAnswers({ questions, onAnswer }: { questions: ChatQuestion[]; onAnswer: (text: string) => void }) {
  const t = useT();
  const id = useId();
  const [drafts, dispatch] = useReducer(questionAnswersReducer, questions, createQuestionAnswers);
  const answers = collectQuestionAnswers(drafts);
  const answered = countQuestionAnswers(answers);
  const complete = answered === questions.length;
  // A lone single-choice question needs no send step: picking is answering.
  const instant = questions.length === SINGLE_QUESTION && !questions[0].multiple;
  const sendText = t(questions.length === SINGLE_QUESTION ? SEND_LABEL : SEND_ALL_LABEL);
  const progress = t(PROGRESS_LABEL, { answered, total: questions.length });
  const otherPlaceholder = t(instant ? OTHER_ENTER_LABEL : OTHER_LABEL);
  const multipleHint = t(MULTIPLE_LABEL);

  const send = (chosen: string[][] = answers) => {
    if (countQuestionAnswers(chosen) !== questions.length) return;
    onAnswer(answerMessage(questions, chosen));
  };

  const choose = (index: number, option: string) => {
    if (instant) send([[option]]);
    else dispatch({ type: QUESTION_ANSWER_ACTION.SELECT, index, option, multiple: questions[index].multiple });
  };

  const onInputKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== SUBMIT_KEY || event.nativeEvent.isComposing) return;
    event.preventDefault();
    send();
  };

  // 1–9 pick an option of the question the focus is in. Only from inside the card: a digit typed in
  // the composer is a digit.
  const onCardKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.tagName === "INPUT" || event.metaKey || event.ctrlKey || event.altKey) return;
    const n = Number.parseInt(event.key, 10);
    if (!Number.isInteger(n) || n < 1) return;
    const index = Number(target.closest<HTMLElement>("[data-question]")?.dataset.question ?? 0);
    const option = questions[index]?.options[n - 1];
    if (!option) return;
    event.preventDefault();
    choose(index, option);
  };

  return (
    <div className={CARD_CLASS} onKeyDown={onCardKey}>
      <div className={QUESTIONS_CLASS}>
        {questions.map((question, index) => {
          const otherId = `${id}-${index}`;
          return (
            <fieldset key={index} data-question={index} className={QUESTION_CLASS}>
              <legend className={LEGEND_CLASS}>
                <MessageCircleQuestion size={QUESTION_ICON_SIZE} className={QUESTION_ICON_CLASS} />
                <span className={QUESTION_TEXT_CLASS}>{question.question}</span>
              </legend>
              {question.multiple && <p className={MULTIPLE_CLASS}>{multipleHint}</p>}
              <div className={OPTIONS_CLASS}>
                {question.options.map((option, n) => {
                  const selected = drafts[index].selected.includes(option);
                  return (
                    <button
                      key={option}
                      type={SUBMIT_BUTTON_TYPE}
                      aria-pressed={instant ? undefined : selected}
                      onClick={() => choose(index, option)}
                      className={`${OPTION_CLASS} ${selected ? SELECTED_CLASS : UNSELECTED_CLASS}`}
                    >
                      <span className={`${KEY_CLASS} ${selected ? KEY_ON_CLASS : KEY_IDLE_CLASS}`}>{n < KEYED_OPTIONS ? n + 1 : "·"}</span>
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option}</span>
                      {instant ? (
                        <ArrowRight size={12} className="shrink-0 text-[var(--cf-accent)] opacity-0 group-hover/opt:opacity-100 group-focus-visible/opt:opacity-100" />
                      ) : (
                        selected && <Check size={12} className="shrink-0 text-[var(--cf-accent)]" />
                      )}
                    </button>
                  );
                })}
                <label htmlFor={otherId} className={OTHER_CLASS}>
                  <span className={`${KEY_CLASS} ${KEY_IDLE_CLASS}`}>
                    <Pencil size={10} />
                  </span>
                  <input
                    id={otherId}
                    value={drafts[index].other}
                    onChange={(event) => dispatch({ type: QUESTION_ANSWER_ACTION.WRITE, index, text: event.target.value, multiple: question.multiple })}
                    onKeyDown={onInputKey}
                    placeholder={otherPlaceholder}
                    aria-label={`${question.question} — ${t(OTHER_LABEL)}`}
                    className={INPUT_CLASS}
                  />
                </label>
              </div>
            </fieldset>
          );
        })}
      </div>
      {!instant && (
        <div className={FOOTER_CLASS}>
          {questions.length > SINGLE_QUESTION && (
            <span className={PROGRESS_CLASS} role="status">
              {progress}
            </span>
          )}
          <button type={SUBMIT_BUTTON_TYPE} disabled={!complete} className={SUBMIT_CLASS} onClick={() => send()}>
            <Send size={SEND_ICON_SIZE} />
            {sendText}
          </button>
        </div>
      )}
    </div>
  );
}

/** An earlier answer's questions: one line, opened on a click. */
function PastQuestions({ questions, answeredWith }: { questions: ChatQuestion[]; answeredWith?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const chosen = useMemo(() => answersIn(questions, answeredWith ?? ""), [questions, answeredWith]);
  const single = questions.length === SINGLE_QUESTION;
  const picked = single ? chosen[0] : [];
  const answeredCount = chosen.filter((c) => c.length > 0).length;
  const summary = single
    ? questions[0].options.length > 0
      ? t("chat.question.optionsCount", { n: questions[0].options.length })
      : null
    : t("chat.question.questionsCount", { n: questions.length });
  return (
    <div className="mt-1 flex min-w-0 max-w-full flex-col items-start gap-1.5">
      <button
        type={SUBMIT_BUTTON_TYPE}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] text-[var(--cf-text-muted)] shadow-[inset_0_0_0_1px_var(--cf-border)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        <MessageCircleQuestion size={12} className="shrink-0 text-[var(--cf-accent)]" />
        <span className="min-w-0 truncate font-medium text-[var(--cf-text)]">{questions[0].question}</span>
        {picked.length > 0 ? (
          <span className="inline-flex min-w-0 shrink items-center gap-0.5 text-[var(--cf-success)]">
            <Check size={11} className="shrink-0" />
            <span className="max-w-[16rem] truncate">{picked.join(", ")}</span>
          </span>
        ) : (
          summary && <span className="shrink-0 whitespace-nowrap">· {summary}</span>
        )}
        {!single && answeredCount > 0 && <Check size={11} className="shrink-0 text-[var(--cf-success)]" />}
        <ChevronDown size={10} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="min-w-0 max-w-[36rem] space-y-2 pl-2.5 text-[12px]">
          {questions.map((question, index) => (
            <div key={index} className="min-w-0 space-y-0.5">
              {!single && <p className="font-medium text-[var(--cf-text)] [overflow-wrap:anywhere]">{question.question}</p>}
              {question.options.map((option, n) => {
                const was = chosen[index]?.includes(option);
                return (
                  <p key={option} className={`flex min-w-0 items-center gap-2 ${was ? "font-medium text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
                    <span className={`${KEY_CLASS} ${was ? KEY_ON_CLASS : KEY_IDLE_CLASS}`}>{n < KEYED_OPTIONS ? n + 1 : "·"}</span>
                    <span className="min-w-0 [overflow-wrap:anywhere]">{option}</span>
                    {was && <Check size={11} className="shrink-0 text-[var(--cf-success)]" />}
                  </p>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
