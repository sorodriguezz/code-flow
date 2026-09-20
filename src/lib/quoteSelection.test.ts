import { describe, expect, it } from "vitest";
import { appendQuote, passageForNewChat, quoteForReply } from "./quoteSelection";

describe("quoteForReply", () => {
  it("prefixes every line, so a multi-paragraph selection stays one quote", () => {
    // The failure this pins is silent and specific: a bare blank line *ends* a Markdown quote, so
    // the second paragraph would arrive as the user's own words rather than as the passage being
    // pointed at — and the model would answer the quote as if it were the question.
    expect(quoteForReply("primero\n\nsegundo")).toBe("> primero\n>\n> segundo\n\n");
  });

  it("leaves the caret on a blank line under the quote", () => {
    expect(quoteForReply("hola")).toBe("> hola\n\n");
  });

  it("has nothing to say about an empty selection", () => {
    expect(quoteForReply("   \n  ")).toBe("");
  });

  it("adds no lead-in of its own", () => {
    // A passage can be quoted from the user's own earlier message just as easily as from an
    // answer, so any sentence this app added would be wrong half the time.
    const quoted = quoteForReply("el índice va después");
    expect(quoted.startsWith(">")).toBe(true);
  });
});

describe("appendQuote", () => {
  it("keeps a draft that was already being typed", () => {
    // Quoting after starting to type is the ordinary order — you write "por qué", then go and
    // select the line you are asking about — and losing the draft there is unrecoverable.
    expect(appendQuote("por qué", "el índice")).toBe("por qué\n\n> el índice\n\n");
  });

  it("starts the quote on its own block rather than continuing the sentence", () => {
    expect(appendQuote("por qué   \n", "el índice")).toBe("por qué\n\n> el índice\n\n");
  });

  it("is the quote alone when the composer is empty", () => {
    expect(appendQuote("", "el índice")).toBe("> el índice\n\n");
  });

  it("leaves the draft alone when there is nothing to quote", () => {
    expect(appendQuote("por qué", "  ")).toBe("por qué");
  });
});

describe("passageForNewChat", () => {
  it("carries the passage verbatim, unquoted", () => {
    // In a new chat the passage *is* the message. A `>` would only say "this came from somewhere
    // you cannot see", which is the least useful thing to tell a model with no context.
    expect(passageForNewChat("el índice va después")).toBe("el índice va después\n\n");
  });

  it("still leaves the caret on its own line", () => {
    expect(passageForNewChat("uno\ndos")).toBe("uno\ndos\n\n");
  });

  it("has nothing to say about an empty selection", () => {
    expect(passageForNewChat("\n \n")).toBe("");
  });
});
