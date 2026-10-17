/**
 * Questions a model asks the user in a chat, written as a fenced block at the end of its answer:
 *
 * ```pregunta
 * {"pregunta": "¿Qué base de datos usamos?", "opciones": ["PostgreSQL", "SQLite"], "multiple": false}
 * ```
 *
 * Headless CLIs have no question tool (Claude's `AskUserQuestion` does not exist under `-p`, Codex's
 * `request_user_input` is refused outside Plan mode), so a model that needs an answer used to end its
 * turn with the question buried in prose. The backend tells every turn this format
 * (`ai::QUESTION_RULES`); the bubble draws the blocks as a card with the options and a free answer,
 * and what is picked goes back as the next message.
 *
 * Tolerant on the way in — English keys, a bare array of questions, options as objects with a
 * `label` — because a model asked for one shape writes a near one. A block that is not JSON at
 * all stays in the text as the code block it is.
 */

export interface ChatQuestion {
  question: string;
  options: string[];
  multiple: boolean;
}

const FENCE = /```(?:pregunta|question|preguntas|questions)[^\S\n]*\n([\s\S]*?)```/gi;

function readOne(raw: unknown): ChatQuestion | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const question = value.pregunta ?? value.question ?? value.texto ?? value.text;
  if (typeof question !== "string" || !question.trim()) return null;
  const listed = value.opciones ?? value.options ?? [];
  const options = (Array.isArray(listed) ? listed : [])
    .map((option) => (typeof option === "string" ? option : option && typeof option === "object" ? ((option as Record<string, unknown>).label ?? (option as Record<string, unknown>).texto) : null))
    .filter((option): option is string => typeof option === "string" && option.trim() !== "")
    .map((option) => option.trim())
    .slice(0, 8);
  return { question: question.trim(), options, multiple: value.multiple === true || value.multiple === "true" };
}

/** `text` without its question blocks, and the questions they held. */
export function splitQuestions(text: string): { text: string; questions: ChatQuestion[] } {
  const questions: ChatQuestion[] = [];
  const rest = text.replace(FENCE, (block, body: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.trim());
    } catch {
      return block;
    }
    const found = (Array.isArray(parsed) ? parsed : [parsed]).map(readOne).filter((q): q is ChatQuestion => q !== null);
    if (found.length === 0) return block;
    questions.push(...found);
    return "";
  });
  return { text: questions.length > 0 ? rest.replace(/\n{3,}/g, "\n\n").trimEnd() : text, questions };
}

/** The message an answer is sent as: each question with what was chosen, so the model reads it alone. */
export function answerMessage(questions: ChatQuestion[], answers: string[][]): string {
  if (questions.length === 1) return answers[0]?.join(", ") ?? "";
  return questions
    .map((q, i) => `${q.question}\n→ ${(answers[i] ?? []).join(", ") || "—"}`)
    .join("\n\n");
}
