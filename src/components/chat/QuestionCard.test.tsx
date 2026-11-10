import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ChatQuestion } from "../../lib/chatQuestions";
import { QuestionCard } from "./QuestionCard";

vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string, params?: { answered: number; total: number }) => params ? `${params.answered}/${params.total}` : key,
}));

const SINGLE_QUESTION_COUNT = 1;
const FIRST_QUESTION_INDEX = 0;
const MANY_QUESTIONS_COUNT = 12;
const EMPTY_MATCHES: string[] = [];
const QUESTIONS: ChatQuestion[] = [
  { question: "¿Qué endpoint tienes?", options: ["Búsqueda", "Alta"], multiple: false },
  { question: "¿Enmascarar nombre?", options: ["Sí", "No"], multiple: false },
  { question: "¿Qué campos incluimos?", options: ["Sexo", "Nacimiento"], multiple: true },
];
const SEND_LABEL = "chat.question.send";
const SEND_ALL_LABEL = "chat.question.sendAll";
const MULTIPLE_LABEL = "chat.question.multiple";
const BUTTON_PATTERN = /<button[^>]*>[\s\S]*?<\/button>/g;
const INPUT_PATTERN = /<input[^>]*>/g;
const FIELDSET_PATTERN = /<fieldset[^>]*>/g;
const DISABLED_ATTRIBUTE = 'disabled=""';
const EMPTY_MARKUP = "";
const SCROLL_CLASS = "overflow-y-auto";
const HEIGHT_CLASS = "max-h-[min(50vh,28rem)]";
const PROGRESS_TEXT = "0/3";

describe("question card", () => {
  it("offers a separate send button even for a single question", () => {
    const questions = QUESTIONS.slice(undefined, SINGLE_QUESTION_COUNT);
    const markup = renderToStaticMarkup(<QuestionCard questions={questions} onAnswer={vi.fn()} />);
    const buttons = markup.match(BUTTON_PATTERN) ?? EMPTY_MATCHES;
    const send = buttons.find((button) => button.includes(SEND_LABEL));
    expect(send).toContain(DISABLED_ATTRIBUTE);
  });

  it("offers one send button for the whole group and shows pending progress", () => {
    const markup = renderToStaticMarkup(<QuestionCard questions={QUESTIONS} onAnswer={vi.fn()} />);
    const buttons = markup.match(BUTTON_PATTERN) ?? EMPTY_MATCHES;
    const sendButtons = buttons.filter((button) => button.includes(SEND_ALL_LABEL));
    expect(sendButtons).toHaveLength(SINGLE_QUESTION_COUNT);
    expect(sendButtons[FIRST_QUESTION_INDEX]).toContain(DISABLED_ATTRIBUTE);
    expect(markup).toContain(PROGRESS_TEXT);
    expect(markup).toContain(MULTIPLE_LABEL);
  });

  it("keeps every question and bounds the scrolling area", () => {
    const questions = Array.from({ length: MANY_QUESTIONS_COUNT }, () => QUESTIONS[FIRST_QUESTION_INDEX]);
    const markup = renderToStaticMarkup(<QuestionCard questions={questions} onAnswer={vi.fn()} />);
    const inputs = markup.match(INPUT_PATTERN) ?? EMPTY_MATCHES;
    expect(inputs).toHaveLength(MANY_QUESTIONS_COUNT);
    expect(markup).toContain(SCROLL_CLASS);
    expect(markup).toContain(HEIGHT_CLASS);
  });

  it("keeps historical questions read only without a send button or text inputs", () => {
    const markup = renderToStaticMarkup(<QuestionCard questions={QUESTIONS} />);
    const inputs = markup.match(INPUT_PATTERN) ?? EMPTY_MATCHES;
    const fieldsets = markup.match(FIELDSET_PATTERN) ?? EMPTY_MATCHES;
    const allDisabled = fieldsets.every((fieldset) => fieldset.includes(DISABLED_ATTRIBUTE));
    expect(inputs).toEqual(EMPTY_MATCHES);
    expect(allDisabled).toBe(true);
    expect(markup).not.toContain(SEND_ALL_LABEL);
  });

  it("does not show an empty questionnaire", () => {
    const markup = renderToStaticMarkup(<QuestionCard questions={[]} onAnswer={vi.fn()} />);
    expect(markup).toBe(EMPTY_MARKUP);
  });
});
