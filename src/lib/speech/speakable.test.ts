import { describe, expect, it } from "vitest";
import { speakable } from "./speakable";

describe("speakable", () => {
  it("drops what only a screen can show and keeps the words", () => {
    const answer = [
      "## Listo",
      "",
      "Cambié **el inicio de sesión** para que muestre el error.",
      "",
      "```ts",
      "const error = validate(form);",
      "```",
      "",
      "- Agregué dos pruebas",
      "- Actualicé [la guía](https://example.com/guide)",
      "",
      "| archivo | líneas |",
      "|---|---|",
      "| login.ts | 12 |",
      "",
      "Corre `npm test` para verlas.",
    ].join("\n");
    expect(speakable(answer)).toBe(
      "Listo. Cambié el inicio de sesión para que muestre el error. Agregué dos pruebas. Actualicé la guía. Corre npm test para verlas.",
    );
  });

  it("drops inline code that is a line rather than a word, and an unclosed fence", () => {
    expect(speakable("Usa `const x = { a: 1 };` aquí")).toBe("Usa aquí.");
    expect(speakable("Mira esto:\n```js\nconsole.log(1)")).toBe("Mira esto:");
    expect(speakable("")).toBe("");
  });
});
