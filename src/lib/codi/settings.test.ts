import { describe, expect, it } from "vitest";
import { billions, tidyNames } from "./settings";

describe("billions", () => {
  it("reads the catalogue's and Ollama's sizes", () => {
    expect(billions("7.6B · Q4_K_M")).toBe(7.6);
    expect(billions("3.8B · Q4_K_M")).toBe(3.8);
    expect(billions("8B")).toBe(8);
    expect(billions("1.7b")).toBe(1.7);
  });

  it("is null when there is no size", () => {
    expect(billions(null)).toBeNull();
    expect(billions(undefined)).toBeNull();
    expect(billions("Q4_K_M")).toBeNull();
  });
});

describe("tidyNames", () => {
  it("drops Codi itself, blanks and repeats", () => {
    expect(tidyNames("Codi, jarvis ,, compu, Jarvis")).toBe("jarvis, compu");
  });
});
