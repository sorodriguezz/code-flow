import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import {
  setTsRunning,
  setTsServed,
  signatureLabel,
  tsAbsolute,
  tsCandidateFile,
  tsFileOf,
  tsIsRunning,
  tsOpenFiles,
  tsRelPath,
} from "./tsserver";

const part = (text: string) => ({ text, kind: "text" });

afterEach(() => {
  setTsServed(null);
  setTsRunning(null);
  tsOpenFiles.clear();
});

describe("signatureLabel", () => {
  it("writes the signature out and marks each parameter's slice of it", () => {
    const { label, parameters } = signatureLabel({
      prefixDisplayParts: [part("fetchUser(")],
      suffixDisplayParts: [part("): Promise<User>")],
      separatorDisplayParts: [part(", ")],
      parameters: [
        { name: "id", displayParts: [part("id: string")], documentation: [part("The user's id.")] },
        { name: "opts", displayParts: [part("opts?: Options")] },
      ],
    });
    expect(label).toBe("fetchUser(id: string, opts?: Options): Promise<User>");
    expect(parameters.map((parameter) => label.slice(...parameter.label))).toEqual(["id: string", "opts?: Options"]);
    expect(parameters[0].documentation).toBe("The user's id.");
    expect(parameters[1].documentation).toBe("");
  });
});

describe("the served project", () => {
  it("counts as running only for the repository the server was started for", () => {
    setTsServed({ repoPath: "/repo", projectId: "p1" });
    expect(tsIsRunning()).toBe(false);
    setTsRunning("/repo");
    expect(tsIsRunning()).toBe(true);
    setTsServed({ repoPath: "/other", projectId: "p2" });
    expect(tsIsRunning()).toBe(false);
  });

  it("maps a model to the server's file only once the server holds it", () => {
    setTsServed({ repoPath: "/repo", projectId: "p1" });
    const uri = { scheme: "cf-editor", path: "/p1/src/a.ts" };
    expect(tsCandidateFile(uri)).toBe("/repo/src/a.ts");
    expect(tsFileOf(uri)).toBeNull();
    tsOpenFiles.add(tsAbsolute("/repo", "src/a.ts"));
    expect(tsFileOf(uri)).toBe("/repo/src/a.ts");
    // Not a script, and not this project's model.
    expect(tsCandidateFile({ scheme: "cf-editor", path: "/p1/README.md" })).toBeNull();
    expect(tsCandidateFile({ scheme: "cf-editor", path: "/p2/src/a.ts" })).toBeNull();
  });

  it("turns the server's absolute paths back into the project's", () => {
    setTsServed({ repoPath: "C:\\work\\repo", projectId: "p1" });
    expect(tsRelPath("C:/work/repo/src/a.ts")).toBe("src/a.ts");
    expect(tsRelPath("C:/work/repo-two/src/a.ts")).toBeNull();
  });
});
