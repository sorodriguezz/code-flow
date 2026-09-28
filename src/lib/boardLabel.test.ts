import { describe, expect, it } from "vitest";
import { boardLabelKey } from "./boardLabel";

describe("boardLabelKey", () => {
  it("names the board a row points at, and Azure for rows that predate the choice", () => {
    expect(boardLabelKey("jira")).toBe("stories.targetJira");
    expect(boardLabelKey("monday")).toBe("stories.targetMonday");
    expect(boardLabelKey("azure")).toBe("stories.targetAzure");
    expect(boardLabelKey("")).toBe("stories.targetAzure");
    expect(boardLabelKey(undefined)).toBe("stories.targetAzure");
  });
});
