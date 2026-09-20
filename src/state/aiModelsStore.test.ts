import { describe, expect, it } from "vitest";
import { pruneRemembered } from "./aiModelsStore";

/**
 * Which hand-typed model ids survive a live listing.
 *
 * The bug this came from: `ollama/gemma4:e4b` sat in `cline_known_models` long after the model was
 * deleted, so the picker offered it, the user had it selected, and the turn was aimed at something
 * that did not exist. The opposite mistake is worse though — for Claude Code and Codex, which
 * enumerate nothing, the remembered ids *are* the catalog, and pruning them empties the dropdown.
 * So every case below is really the same question: what counts as proof that an id is gone.
 */
describe("pruneRemembered", () => {
  it("drops an id the provider no longer lists", () => {
    const live = ["ollama/qwen2.5-coder:7b", "ollama/qwen3:8b", "ollama/qwen2.5:7b-instruct"];
    expect(pruneRemembered(live, ["ollama/qwen2.5:7b-instruct", "ollama/gemma4:e4b"])).toEqual([
      "ollama/qwen2.5:7b-instruct",
    ]);
  });

  it("keeps everything when the listing came back empty", () => {
    // Ollama not running, a CLI that failed to spawn, a network that was down. None of those is
    // "you have no models", and treating them as one would delete the user's list for them.
    const remembered = ["ollama/gemma4:e4b", "claude-opus-4-1"];
    expect(pruneRemembered([], remembered)).toEqual(remembered);
  });

  it("does not let one provider answer for another", () => {
    // Cline drives several back ends. A live list of Ollama models says nothing whatsoever about
    // an Anthropic id typed by hand, and silence is not evidence.
    const live = ["ollama/qwen3:8b"];
    expect(pruneRemembered(live, ["anthropic/claude-opus-4-1", "ollama/gone:7b"])).toEqual([
      "anthropic/claude-opus-4-1",
    ]);
  });

  it("treats bare ids as their own namespace, in both directions", () => {
    // `agy models` answers with bare ids, so a bare remembered id is in scope there…
    expect(pruneRemembered(["gemini-3.7-flash"], ["gemini-3.6-flash"])).toEqual([]);
    // …but a qualified live list is not evidence about a bare id, nor the reverse.
    expect(pruneRemembered(["ollama/qwen3:8b"], ["my-local-build"])).toEqual(["my-local-build"]);
    expect(pruneRemembered(["gemini-3.7-flash"], ["ollama/qwen3:8b"])).toEqual(["ollama/qwen3:8b"]);
  });

  it("keeps an id the live list also has, so the caller can dedupe rather than lose it", () => {
    expect(pruneRemembered(["a/one"], ["a/one"])).toEqual(["a/one"]);
  });

  it("keeps a remembered list when there is nothing to check it against", () => {
    expect(pruneRemembered([], [])).toEqual([]);
    expect(pruneRemembered(["a/one"], [])).toEqual([]);
  });
});
