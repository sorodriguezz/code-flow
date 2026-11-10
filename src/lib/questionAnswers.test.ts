import { describe, expect, it } from "vitest";
import { answerMessage, splitQuestions, type ChatQuestion } from "./chatQuestions";
import { collectQuestionAnswers, countQuestionAnswers, createQuestionAnswers, EMPTY_QUESTION_ANSWER, QUESTION_ANSWER_ACTION, questionAnswersReducer, type QuestionAnswerDraft } from "./questionAnswers";

const FIRST_QUESTION = 0;
const SECOND_QUESTION = 1;
const THIRD_QUESTION = 2;
const NO_ANSWERS = 0;
const ONE_ANSWER = 1;
const TWO_ANSWERS = 2;
const THREE_ANSWERS = 3;
const QUESTIONS: ChatQuestion[] = [
  { question: "¿Qué endpoint tienes?", options: ["Búsqueda", "Alta"], multiple: false },
  { question: "¿Enmascarar nombre?", options: ["Sí", "No"], multiple: false },
  { question: "¿Qué campos incluimos?", options: ["Sexo", "Nacimiento"], multiple: true },
];
const [ENDPOINT_QUESTION, MASK_QUESTION, FIELDS_QUESTION] = QUESTIONS;
const [SEARCH_OPTION, CREATE_OPTION] = ENDPOINT_QUESTION.options;
const [MASK_OPTION] = MASK_QUESTION.options;
const [SEX_OPTION, BIRTH_OPTION] = FIELDS_QUESTION.options;
const CUSTOM_ENDPOINT = "  /pacientes/buscar  ";
const TRIMMED_CUSTOM_ENDPOINT = CUSTOM_ENDPOINT.trim();
const CUSTOM_FIELD = "  Nacionalidad  ";
const TRIMMED_CUSTOM_FIELD = CUSTOM_FIELD.trim();
const WHITESPACE = "   ";
const FENCE_OPEN = "```pregunta\n";
const FENCE_CLOSE = "\n```";
const BLOCK_SEPARATOR = "\n\n";
const EXPECTED_MESSAGE = "¿Qué endpoint tienes?\n→ Búsqueda\n\n¿Enmascarar nombre?\n→ Sí\n\n¿Qué campos incluimos?\n→ Sexo, Nacimiento, Nacionalidad";

function select(drafts: QuestionAnswerDraft[], index: number, option: string) {
  const multiple = QUESTIONS[index].multiple;
  return questionAnswersReducer(drafts, { type: QUESTION_ANSWER_ACTION.SELECT, index, option, multiple });
}

function write(drafts: QuestionAnswerDraft[], index: number, text: string) {
  const multiple = QUESTIONS[index].multiple;
  return questionAnswersReducer(drafts, { type: QUESTION_ANSWER_ACTION.WRITE, index, text, multiple });
}

describe("question answer drafts", () => {
  it("collects two or three questions independently without losing earlier choices", () => {
    let drafts = createQuestionAnswers(QUESTIONS);
    let answers = collectQuestionAnswers(drafts);
    let answered = countQuestionAnswers(answers);
    expect(answered).toBe(NO_ANSWERS);
    drafts = select(drafts, FIRST_QUESTION, SEARCH_OPTION);
    answers = collectQuestionAnswers(drafts);
    answered = countQuestionAnswers(answers);
    expect(answered).toBe(ONE_ANSWER);
    drafts = select(drafts, SECOND_QUESTION, MASK_OPTION);
    answers = collectQuestionAnswers(drafts);
    answered = countQuestionAnswers(answers);
    expect(answered).toBe(TWO_ANSWERS);
    expect(answers).toEqual([[SEARCH_OPTION], [MASK_OPTION], []]);
    drafts = select(drafts, FIRST_QUESTION, CREATE_OPTION);
    answers = collectQuestionAnswers(drafts);
    expect(answers).toEqual([[CREATE_OPTION], [MASK_OPTION], []]);
    drafts = select(drafts, THIRD_QUESTION, BIRTH_OPTION);
    answers = collectQuestionAnswers(drafts);
    answered = countQuestionAnswers(answers);
    expect(answered).toBe(THREE_ANSWERS);
  });

  it("replaces a single choice with written text and clears that text when choosing again", () => {
    let drafts = createQuestionAnswers(QUESTIONS);
    drafts = select(drafts, FIRST_QUESTION, SEARCH_OPTION);
    drafts = write(drafts, FIRST_QUESTION, CUSTOM_ENDPOINT);
    let answers = collectQuestionAnswers(drafts);
    expect(answers[FIRST_QUESTION]).toEqual([TRIMMED_CUSTOM_ENDPOINT]);
    drafts = select(drafts, FIRST_QUESTION, CREATE_OPTION);
    answers = collectQuestionAnswers(drafts);
    expect(answers[FIRST_QUESTION]).toEqual([CREATE_OPTION]);
    expect(drafts[FIRST_QUESTION].other).toBe(EMPTY_QUESTION_ANSWER);
  });

  it("counts a multiple choice once, preserves its written text and supports deselecting", () => {
    let drafts = createQuestionAnswers(QUESTIONS);
    drafts = select(drafts, THIRD_QUESTION, SEX_OPTION);
    drafts = select(drafts, THIRD_QUESTION, BIRTH_OPTION);
    drafts = write(drafts, THIRD_QUESTION, CUSTOM_FIELD);
    let answers = collectQuestionAnswers(drafts);
    const answered = countQuestionAnswers(answers);
    expect(answered).toBe(ONE_ANSWER);
    expect(answers[THIRD_QUESTION]).toEqual([SEX_OPTION, BIRTH_OPTION, TRIMMED_CUSTOM_FIELD]);
    drafts = select(drafts, THIRD_QUESTION, SEX_OPTION);
    answers = collectQuestionAnswers(drafts);
    expect(answers[THIRD_QUESTION]).toEqual([BIRTH_OPTION, TRIMMED_CUSTOM_FIELD]);
  });

  it("marks a cleared answer as pending and ignores whitespace", () => {
    let drafts = createQuestionAnswers(QUESTIONS);
    drafts = write(drafts, SECOND_QUESTION, WHITESPACE);
    drafts = select(drafts, THIRD_QUESTION, SEX_OPTION);
    drafts = select(drafts, THIRD_QUESTION, SEX_OPTION);
    const answers = collectQuestionAnswers(drafts);
    const answered = countQuestionAnswers(answers);
    expect(answered).toBe(NO_ANSWERS);
  });

  it("does not erase a choice when the alternative input only contains spaces", () => {
    let drafts = createQuestionAnswers(QUESTIONS);
    drafts = select(drafts, FIRST_QUESTION, SEARCH_OPTION);
    drafts = write(drafts, FIRST_QUESTION, WHITESPACE);
    const answers = collectQuestionAnswers(drafts);
    expect(answers[FIRST_QUESTION]).toEqual([SEARCH_OPTION]);
  });

  it("groups separate question blocks and formats all answers in one message", () => {
    const blocks = QUESTIONS.map((question) => {
      const payload = JSON.stringify(question);
      return `${FENCE_OPEN}${payload}${FENCE_CLOSE}`;
    });
    const content = blocks.join(BLOCK_SEPARATOR);
    const parsed = splitQuestions(content);
    expect(parsed.questions).toEqual(QUESTIONS);
    let drafts = createQuestionAnswers(parsed.questions);
    drafts = select(drafts, FIRST_QUESTION, SEARCH_OPTION);
    drafts = select(drafts, SECOND_QUESTION, MASK_OPTION);
    drafts = select(drafts, THIRD_QUESTION, SEX_OPTION);
    drafts = select(drafts, THIRD_QUESTION, BIRTH_OPTION);
    drafts = write(drafts, THIRD_QUESTION, CUSTOM_FIELD);
    const answers = collectQuestionAnswers(drafts);
    const message = answerMessage(parsed.questions, answers);
    expect(message).toBe(EXPECTED_MESSAGE);
  });
});
