import { describe, expect, it } from "vitest";
import { insertMention, insertNoteMention, mentionAt, mentionName, noteMentionAt } from "./MentionMenu";

describe("mentionAt", () => {
  it("finds the @word at the caret, not an email's", () => {
    expect(mentionAt("mira @src/ap", 12)).toEqual({ start: 5, query: "src/ap" });
    expect(mentionAt("correo@rama", 11)).toBeNull();
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
  });
});

describe("insertMention", () => {
  it("ends a file with a space and leaves a folder or repository open for typing", () => {
    expect(insertMention("mira @sr y", 5, 8, "src/app.ts")).toEqual({ text: "mira @src/app.ts y", caret: 17 });
    expect(insertMention("@ap", 0, 3, "api/")).toEqual({ text: "@api/", caret: 5 });
  });
});

describe("mentionName", () => {
  it("keeps a repository's name one token, as the backend reads it", () => {
    expect(mentionName("mi api")).toBe("mi-api");
    expect(mentionName(" web ")).toBe("web");
  });
});

describe("noteMentionAt", () => {
  it("reads the title being typed after [[ and nothing once the link is closed", () => {
    expect(noteMentionAt("ver [[Plan Q", 12)).toEqual({ start: 4, query: "Plan Q" });
    expect(noteMentionAt("[[", 2)).toEqual({ start: 0, query: "" });
    expect(noteMentionAt("ver [[Plan]] y", 14)).toBeNull();
  });
});

describe("insertNoteMention", () => {
  it("closes the link, adds a space and keeps what follows", () => {
    expect(insertNoteMention("ver [[Pla y más", 4, 9, "Plan Q4")).toEqual({ text: "ver [[Plan Q4]] y más", caret: 16 });
    expect(insertNoteMention("[[Pla]]", 0, 5, "Plan")).toEqual({ text: "[[Plan]] ", caret: 9 });
  });
});
