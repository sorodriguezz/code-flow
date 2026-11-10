import type { ChatQuestion } from "./chatQuestions";

export const EMPTY_QUESTION_ANSWER = "";
const NO_ANSWERS = 0;
export const QUESTION_ANSWER_ACTION = { SELECT: "select", WRITE: "write" } as const;

export interface QuestionAnswerDraft {
  selected: string[];
  other: string;
}

export type QuestionAnswerAction =
  | { type: typeof QUESTION_ANSWER_ACTION.SELECT; index: number; option: string; multiple: boolean }
  | { type: typeof QUESTION_ANSWER_ACTION.WRITE; index: number; text: string; multiple: boolean };

export function createQuestionAnswers(questions: ChatQuestion[]): QuestionAnswerDraft[] {
  return questions.map(() => ({ selected: [], other: EMPTY_QUESTION_ANSWER }));
}

export function questionAnswersReducer(drafts: QuestionAnswerDraft[], action: QuestionAnswerAction): QuestionAnswerDraft[] {
  return drafts.map((draft, index) => {
    if (index !== action.index) return draft;
    if (action.type === QUESTION_ANSWER_ACTION.WRITE) {
      const trimmed = action.text.trim();
      const replaceSelection = !action.multiple && trimmed !== EMPTY_QUESTION_ANSWER;
      return { selected: replaceSelection ? [] : draft.selected, other: action.text };
    }
    if (!action.multiple) return { selected: [action.option], other: EMPTY_QUESTION_ANSWER };
    const alreadySelected = draft.selected.includes(action.option);
    const selected = alreadySelected
      ? draft.selected.filter((option) => option !== action.option)
      : [...draft.selected, action.option];
    return { ...draft, selected };
  });
}

export function collectQuestionAnswers(drafts: QuestionAnswerDraft[]): string[][] {
  return drafts.map((draft) => {
    const other = draft.other.trim();
    return other === EMPTY_QUESTION_ANSWER ? draft.selected : [...draft.selected, other];
  });
}

export function countQuestionAnswers(answers: string[][]): number {
  const answered = answers.filter((answer) => answer.length > NO_ANSWERS);
  return answered.length;
}
