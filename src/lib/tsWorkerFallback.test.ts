import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { WORKER_MODE_CONFIGURATION, workerAnswers } from "./tsWorkerFallback";
import { setTsRunning, setTsServed, tsAbsolute, tsOpenFiles } from "./tsserver";
import { modelPathForId } from "./editorModel";

/** A model URI as Monaco parses it: the scheme, and the path with its leading slash. */
function uriOf(projectId: string, relPath: string) {
  const raw = modelPathForId(projectId, relPath);
  const [scheme, rest] = raw.split(":", 2);
  return { scheme, path: decodeURIComponent(rest) };
}

afterEach(() => {
  setTsServed(null);
  setTsRunning(null);
  tsOpenFiles.clear();
});

describe("the isolated worker's configuration", () => {
  it("leaves every answer about types to the gated providers", () => {
    for (const feature of [
      "completionItems",
      "hovers",
      "definitions",
      "references",
      "signatureHelp",
      "codeActions",
      "inlayHints",
      "rename",
    ] as const) {
      expect(WORKER_MODE_CONFIGURATION[feature], feature).toBe(false);
    }
  });

  it("keeps what is about the text's shape — and the one formatter most repositories have", () => {
    for (const feature of [
      "documentSymbols",
      "documentHighlights",
      "documentRangeFormattingEdits",
      "onTypeFormattingEdits",
      "diagnostics",
    ] as const) {
      expect(WORKER_MODE_CONFIGURATION[feature], feature).toBe(true);
    }
  });
});

describe("which of the two answers", () => {
  it("is the worker while no compiler is running", () => {
    setTsServed({ repoPath: "/repo", projectId: "p1" });
    tsOpenFiles.add(tsAbsolute("/repo", "src/a.ts"));
    expect(workerAnswers(uriOf("p1", "src/a.ts"))).toBe(true);
  });

  it("is the compiler, alone, for a project file it holds", () => {
    setTsServed({ repoPath: "/repo", projectId: "p1" });
    setTsRunning("/repo");
    tsOpenFiles.add(tsAbsolute("/repo", "src/a.ts"));
    expect(workerAnswers(uriOf("p1", "src/a.ts"))).toBe(false);
  });

  it("is the worker for everything the compiler does not hold", () => {
    setTsServed({ repoPath: "/repo", projectId: "p1" });
    setTsRunning("/repo");
    tsOpenFiles.add(tsAbsolute("/repo", "src/a.ts"));
    // Not handed to the server yet.
    expect(workerAnswers(uriOf("p1", "src/b.ts"))).toBe(true);
    // Another project's file of the same name.
    expect(workerAnswers(uriOf("p2", "src/a.ts"))).toBe(true);
    // A script in another panel — not one of the editor's models at all.
    expect(workerAnswers({ scheme: "inmemory", path: "/model/1" })).toBe(true);
  });

  it("is the worker while the server that is up belongs to the project the window just left", () => {
    setTsServed({ repoPath: "/other", projectId: "p2" });
    setTsRunning("/repo");
    tsOpenFiles.add(tsAbsolute("/other", "src/a.ts"));
    expect(workerAnswers(uriOf("p2", "src/a.ts"))).toBe(true);
  });
});
