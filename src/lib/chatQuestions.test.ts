import { describe, expect, it } from "vitest";
import { answerMessage, answersIn, splitQuestions } from "./chatQuestions";

describe("chatQuestions", () => {
  it("lifts a question block out of the answer", () => {
    const text = 'Puedo hacerlo de dos formas.\n\n```pregunta\n{"pregunta": "¿Cuál prefieres?", "opciones": ["Rápida", "Completa"]}\n```\n';
    const { text: rest, questions } = splitQuestions(text);
    expect(rest).toBe("Puedo hacerlo de dos formas.");
    expect(questions).toEqual([{ question: "¿Cuál prefieres?", options: ["Rápida", "Completa"], multiple: false }]);
  });

  it("reads English keys, arrays and option objects", () => {
    const text = '```question\n[{"question": "Which?", "options": [{"label": "A"}, "B"], "multiple": true}, {"question": "Name?"}]\n```';
    const { questions } = splitQuestions(text);
    expect(questions).toEqual([
      { question: "Which?", options: ["A", "B"], multiple: true },
      { question: "Name?", options: [], multiple: false },
    ]);
  });

  it("leaves a block that is not a question as it was", () => {
    const text = "```pregunta\nno es json\n```";
    expect(splitQuestions(text)).toEqual({ text, questions: [] });
    const plain = "```ts\nconst a = 1;\n```";
    expect(splitQuestions(plain).questions).toEqual([]);
  });

  it("keeps a ```json payload with a loose text key as the code block it is", () => {
    const text = 'La respuesta del API:\n\n```json\n{"text": "hi", "id": 1}\n```';
    expect(splitQuestions(text)).toEqual({ text, questions: [] });
    // A json fence that does say it is a question is still read as one.
    const asked = '```json\n{"pregunta": "¿Seguimos?", "opciones": ["Sí", "No"]}\n```';
    expect(splitQuestions(asked).questions).toEqual([{ question: "¿Seguimos?", options: ["Sí", "No"], multiple: false }]);
    // Inside a fence named for questions, the loose key is fine.
    expect(splitQuestions('```pregunta\n{"texto": "¿Cuál?"}\n```').questions).toEqual([{ question: "¿Cuál?", options: [], multiple: false }]);
  });

  it("reads a question written as bare JSON at the end, and nothing else bare", () => {
    const text = 'No veo los repos.{"pregunta":"¿A qué proyecto te refieres?","opciones":[],"multiple":false}';
    expect(splitQuestions(text)).toEqual({
      text: "No veo los repos.",
      questions: [{ question: "¿A qué proyecto te refieres?", options: [], multiple: false }],
    });
    const several = 'Dos dudas:\n[{"pregunta": "¿Uno?", "opciones": ["a", "b"]}, {"pregunta": "¿Dos?"}]';
    expect(splitQuestions(several).questions.map((q) => q.question)).toEqual(["¿Uno?", "¿Dos?"]);
    const fenced = 'Elige:\n```json\n{"pregunta": "¿Cuál?", "opciones": ["X", "Y"]}\n```';
    expect(splitQuestions(fenced)).toEqual({ text: "Elige:", questions: [{ question: "¿Cuál?", options: ["X", "Y"], multiple: false }] });
    // JSON in the middle of prose, or that is not a question, stays where it is.
    const middle = 'El formato es {"pregunta": "¿?"} y sigue el texto.';
    expect(splitQuestions(middle)).toEqual({ text: middle, questions: [] });
    const config = 'La configuración:\n```json\n{"port": 8080}\n```';
    expect(splitQuestions(config)).toEqual({ text: config, questions: [] });
  });

  it("answers one question with the choice alone, several with each question", () => {
    const one = [{ question: "¿Color?", options: ["Rojo"], multiple: false }];
    expect(answerMessage(one, [["Rojo"]])).toBe("Rojo");
    const two = [...one, { question: "¿Tamaño?", options: [], multiple: false }];
    expect(answerMessage(two, [["Rojo"], ["Grande"]])).toBe("¿Color?\n→ Rojo\n\n¿Tamaño?\n→ Grande");
  });

  it("reads back which options a reply chose, and nothing from a reply in other words", () => {
    const one = [{ question: "¿Color?", options: ["Rojo", "Azul, oscuro", "Verde"], multiple: true }];
    expect(answersIn(one, "Rojo")).toEqual([["Rojo"]]);
    expect(answersIn(one, "Azul, oscuro")).toEqual([["Azul, oscuro"]]);
    expect(answersIn(one, "Rojo, Verde, y algo más")).toEqual([["Rojo", "Verde"]]);
    expect(answersIn(one, "sigo sin entender")).toEqual([[]]);
    const two = [one[0], { question: "¿Tamaño?", options: ["Grande", "Chico"], multiple: false }];
    expect(answersIn(two, answerMessage(two, [["Verde"], ["Chico"]]))).toEqual([["Verde"], ["Chico"]]);
    expect(answersIn(two, answerMessage(two, [["Verde"], []]))).toEqual([["Verde"], []]);
    expect(answersIn(two, "")).toEqual([[], []]);
  });
});
