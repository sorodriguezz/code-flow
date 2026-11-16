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
 * `label`, a ```json fence, or the JSON with no fence at all at the end of the answer — because a
 * model asked for one shape writes a near one: gpt-oss 20B ended a turn with
 * `…del workspace.{"pregunta":"¿A qué proyecto te refieres?","opciones":[],"multiple":false}`
 * (user report, 2026-11-16). A block that is not JSON at all stays in the text as the code block
 * it is, and so does any JSON that is not a question.
 */

export interface ChatQuestion {
  question: string;
  options: string[];
  multiple: boolean;
}

const FENCE = /```(?:pregunta|question|preguntas|questions|json)[^\S\n]*\n([\s\S]*?)```/gi;

/** Where a question's JSON may start without a fence: `{"pregunta":`, or `[` before it. */
const BARE_START = /(?:\[\s*)?\{\s*"(?:pregunta|question|preguntas|questions)"\s*:/gi;

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

function readAll(parsed: unknown): ChatQuestion[] {
  return (Array.isArray(parsed) ? parsed : [parsed]).map(readOne).filter((q): q is ChatQuestion => q !== null);
}

/**
 * The questions a model wrote as bare JSON at the very end of its answer, and the text before them.
 * Only the end: JSON in the middle of prose is something the model is showing, not asking. The
 * earliest start that parses through to the end wins, so an array of several is read whole.
 */
function trailingQuestions(text: string): { text: string; questions: ChatQuestion[] } | null {
  const trimmed = text.trimEnd();
  if (!trimmed.endsWith("}") && !trimmed.endsWith("]")) return null;
  for (const match of trimmed.matchAll(BARE_START)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(match.index));
    } catch {
      continue;
    }
    const questions = readAll(parsed);
    if (questions.length === 0) return null;
    return { text: trimmed.slice(0, match.index).replace(/\n{3,}/g, "\n\n").trimEnd(), questions };
  }
  return null;
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
    const found = readAll(parsed);
    if (found.length === 0) return block;
    questions.push(...found);
    return "";
  });
  if (questions.length === 0) return trailingQuestions(text) ?? { text, questions };
  return { text: rest.replace(/\n{3,}/g, "\n\n").trimEnd(), questions };
}

/** The message an answer is sent as: each question with what was chosen, so the model reads it alone. */
export function answerMessage(questions: ChatQuestion[], answers: string[][]): string {
  if (questions.length === 1) return answers[0]?.join(", ") ?? "";
  return questions
    .map((q, i) => `${q.question}\n→ ${(answers[i] ?? []).join(", ") || "—"}`)
    .join("\n\n");
}
