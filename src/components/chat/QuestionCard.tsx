import { useId, useReducer, type KeyboardEvent } from "react";
import { MessageCircleQuestion, Send } from "lucide-react";
import { buttonClass } from "../common/Button";
import { answerMessage, type ChatQuestion } from "../../lib/chatQuestions";
import { collectQuestionAnswers, countQuestionAnswers, createQuestionAnswers, QUESTION_ANSWER_ACTION, questionAnswersReducer } from "../../lib/questionAnswers";
import { useT } from "../../state/languageStore";

const NO_QUESTIONS = 0;
const SINGLE_QUESTION = 1;
const QUESTION_ICON_SIZE = 13;
const SEND_ICON_SIZE = 12;
const SUBMIT_KEY = "Enter";
const OTHER_LABEL = "chat.question.other";
const SEND_LABEL = "chat.question.send";
const SEND_ALL_LABEL = "chat.question.sendAll";
const PROGRESS_LABEL = "chat.question.progress";
const HINT_LABEL = "chat.question.hint";
const MULTIPLE_LABEL = "chat.question.multiple";
const CARD_CLASS = "mt-2 min-w-0 max-w-full overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-2)] text-[12.5px]";
const HEADER_CLASS = "flex flex-wrap items-center justify-between gap-2 border-b border-[var(--cf-border)] px-2.5 py-2 text-[11px] text-[var(--cf-text-muted)]";
const PROGRESS_CLASS = "shrink-0 tabular-nums text-[var(--cf-text-faint)]";
const QUESTIONS_CLASS = "max-h-[min(50vh,28rem)] space-y-3 overflow-y-auto overscroll-contain p-2.5";
const QUESTION_CLASS = "min-w-0 space-y-1.5";
const LEGEND_CLASS = "mb-1.5 flex max-w-full items-start gap-1.5 font-medium text-[var(--cf-text)]";
const QUESTION_ICON_CLASS = "mt-0.5 shrink-0 text-[var(--cf-accent)]";
const QUESTION_TEXT_CLASS = "min-w-0 [overflow-wrap:anywhere]";
const MULTIPLE_CLASS = "pl-[19px] text-[11px] text-[var(--cf-text-muted)]";
const OPTIONS_CLASS = "flex min-w-0 flex-wrap gap-1.5 pl-[19px]";
const OPTION_CLASS = "max-w-full rounded-md border px-2 py-0.5 text-left text-[12px] [overflow-wrap:anywhere] transition-colors disabled:cursor-default disabled:opacity-60";
const SELECTED_CLASS = "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]";
const UNSELECTED_CLASS = "border-[var(--cf-border)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]";
const OTHER_CLASS = "flex min-w-0 pl-[19px]";
const INPUT_CLASS = "min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-0.5 text-[12px] outline-none focus:border-[var(--cf-accent)]";
const FOOTER_CLASS = "flex justify-end border-t border-[var(--cf-border)] px-2.5 py-2";
const SUBMIT_CLASS = buttonClass({ variant: "primary", size: "sm" });
const SUBMIT_BUTTON_TYPE = "button";

interface QuestionCardProps {
  questions: ChatQuestion[];
  onAnswer?: (text: string) => void;
}

export function QuestionCard(props: QuestionCardProps) {
  const questionSetKey = JSON.stringify(props.questions);
  if (props.questions.length === NO_QUESTIONS) return null;
  return <QuestionAnswers key={questionSetKey} {...props} />;
}

function QuestionAnswers({ questions, onAnswer }: QuestionCardProps) {
  const t = useT();
  const id = useId();
  const [drafts, dispatch] = useReducer(questionAnswersReducer, questions, createQuestionAnswers);
  const answers = collectQuestionAnswers(drafts);
  const answered = countQuestionAnswers(answers);
  const complete = answered === questions.length;
  const sendLabel = questions.length === SINGLE_QUESTION ? SEND_LABEL : SEND_ALL_LABEL;
  const hint = t(HINT_LABEL);
  const progress = t(PROGRESS_LABEL, { answered, total: questions.length });
  const sendText = t(sendLabel);
  const otherPlaceholder = t(OTHER_LABEL);
  const multipleHint = t(MULTIPLE_LABEL);

  const send = () => {
    if (!onAnswer || !complete) return;
    const message = answerMessage(questions, answers);
    onAnswer(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const composing = event.nativeEvent.isComposing;
    if (event.key !== SUBMIT_KEY || composing) return;
    event.preventDefault();
    send();
  };

  return (
    <div className={CARD_CLASS}>
      {onAnswer && (
        <div className={HEADER_CLASS}>
          <span>{hint}</span>
          {questions.length > SINGLE_QUESTION && <span className={PROGRESS_CLASS} role="status">{progress}</span>}
        </div>
      )}
      <div className={QUESTIONS_CLASS}>
        {questions.map((question, index) => {
          const otherId = `${id}-${index}`;
          const otherLabel = `${question.question} — ${otherPlaceholder}`;
          return (
            <fieldset key={index} disabled={!onAnswer} className={QUESTION_CLASS}>
              <legend className={LEGEND_CLASS}>
                <MessageCircleQuestion size={QUESTION_ICON_SIZE} className={QUESTION_ICON_CLASS} />
                <span className={QUESTION_TEXT_CLASS}>{question.question}</span>
              </legend>
              {question.multiple && <p className={MULTIPLE_CLASS}>{multipleHint}</p>}
              {question.options.length > NO_QUESTIONS && (
                <div className={OPTIONS_CLASS}>
                  {question.options.map((option) => {
                    const selected = drafts[index].selected.includes(option);
                    const selectionClass = selected ? SELECTED_CLASS : UNSELECTED_CLASS;
                    const optionClass = `${OPTION_CLASS} ${selectionClass}`;
                    return (
                      <button
                        key={option}
                        type={SUBMIT_BUTTON_TYPE}
                        disabled={!onAnswer}
                        aria-pressed={selected}
                        onClick={() => dispatch({ type: QUESTION_ANSWER_ACTION.SELECT, index, option, multiple: question.multiple })}
                        className={optionClass}
                      >
                        {option}
                      </button>
                    );
                  })}
                </div>
              )}
              {onAnswer && (
                <div className={OTHER_CLASS}>
                  <input
                    id={otherId}
                    value={drafts[index].other}
                    onChange={(event) => dispatch({ type: QUESTION_ANSWER_ACTION.WRITE, index, text: event.target.value, multiple: question.multiple })}
                    onKeyDown={onKeyDown}
                    placeholder={otherPlaceholder}
                    aria-label={otherLabel}
                    className={INPUT_CLASS}
                  />
                </div>
              )}
            </fieldset>
          );
        })}
      </div>
      {onAnswer && (
        <div className={FOOTER_CLASS}>
          <button type={SUBMIT_BUTTON_TYPE} disabled={!complete} className={SUBMIT_CLASS} onClick={send}>
            <Send size={SEND_ICON_SIZE} />
            {sendText}
          </button>
        </div>
      )}
    </div>
  );
}
