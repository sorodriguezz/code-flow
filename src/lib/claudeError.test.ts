import { describe, expect, it } from "vitest";
import { parseClaudeError } from "./claudeError";

/**
 * The three messages below are verbatim from a real session — the failures a user actually hit on
 * the first day the chat workspace existed, one per provider. They are the reason this classifier
 * exists, so they are the fixtures: a regression here is a regression against something that
 * demonstrably happens, not against an invented string.
 */
const REAL = {
  codex:
    "codex exited with an error (exit status: 1): Reading additional input from stdin...\nNot inside a trusted directory and --skip-git-repo-check was not specified.",
  grok:
    "grok exited with an error (exit status: 1): Error: Not signed in. To authenticate without a browser, run:\n  grok login --device-code\n\nAlternatively, set the XAI_API_KEY environment variable or run `grok login` on a machine with a browser.",
  opencode:
    "UnknownError: Model not found: opencode/deepseek-v4-flash-free. Did you mean: deepseek-v4-flash, deepseek-v4-flash-vision-exp, deepseek-v4-pro?",
};

describe("setup problems", () => {
  it("reads codex's refusal to run outside a git work tree", () => {
    expect(parseClaudeError(REAL.codex).setup).toEqual({ kind: "untrusted-directory" });
  });

  it("reads grok's sign-out and keeps the browserless variant of the command", () => {
    const setup = parseClaudeError(REAL.grok).setup;
    // `--device-code` is the half that matters: the app has no browser to hand back to, and the
    // plain `grok login` further down the same message is the wrong one to offer here.
    expect(setup).toEqual({ kind: "not-signed-in", command: "grok login --device-code" });
  });

  it("re-attaches the vendor the CLI dropped from its own suggestions", () => {
    // The bug this pins down happened in front of a user: opencode rejects a vendor-qualified id
    // and suggests bare names, so offering them verbatim produced a *second* failure —
    // `Model not found: deepseek-v4-flash/.` — because `vendor/model` parsed the bare name as the
    // vendor with nothing after the slash.
    expect(parseClaudeError(REAL.opencode).setup).toEqual({
      kind: "model-not-found",
      model: "opencode/deepseek-v4-flash-free",
      suggestions: [
        "opencode/deepseek-v4-flash",
        "opencode/deepseek-v4-flash-vision-exp",
        "opencode/deepseek-v4-pro",
      ],
    });
  });

  it("reads the second failure that bug produced without inventing a vendor from it", () => {
    // `deepseek-v4-flash/` has a slash but nothing after it. Treating that as a vendor would
    // re-apply the broken prefix to every suggestion and make the fix loop on itself.
    const setup = parseClaudeError("UnknownError: Model not found: deepseek-v4-flash/.").setup;
    expect(setup).toEqual({ kind: "model-not-found", model: "deepseek-v4-flash/", suggestions: [] });
  });

  it("leaves a suggestion that already carries a prefix alone", () => {
    const setup = parseClaudeError(
      "Model not found: opencode/a. Did you mean: opencode/b, c?",
    ).setup;
    expect(setup).toMatchObject({ suggestions: ["opencode/b", "opencode/c"] });
  });

  it("adds no prefix when the rejected id never had one", () => {
    const setup = parseClaudeError("Model not found: sonnet-9. Did you mean: sonnet-5, opus-5?").setup;
    expect(setup).toMatchObject({ suggestions: ["sonnet-5", "opus-5"] });
  });

  it("reads agy's phrasing of the same model failure, which offers no alternatives", () => {
    expect(parseClaudeError("model gemini-3.6-flash-high is not recognized").setup).toEqual({
      kind: "model-not-found",
      model: "gemini-3.6-flash-high",
      suggestions: [],
    });
  });

  it("names the binary when one is not installed", () => {
    expect(parseClaudeError("zsh: command not found: opencode").setup).toEqual({
      kind: "binary-missing",
      binary: "opencode",
    });
  });

  it("prefers a missing binary over the login command in the same message", () => {
    // Telling someone to run `claude login` for a CLI that is not installed is a step they cannot
    // take, and it hides the step they can.
    const setup = parseClaudeError("No such file or directory: claude. Run `claude login` first.").setup;
    expect(setup?.kind).toBe("binary-missing");
  });
});

describe("what must NOT be classified", () => {
  it("leaves an ordinary failure alone", () => {
    expect(parseClaudeError("the model returned an empty response").setup).toBeNull();
  });

  it("does not classify a long error that merely mentions signing in", () => {
    // A stack trace, a log tail, or a model writing about authentication. Guessing here would
    // replace a verbatim error the user can act on with a confident wrong instruction.
    const long = `Traceback: ${"x".repeat(700)} not signed in`;
    expect(parseClaudeError(long).setup).toBeNull();
  });

  it("does not offer a sign-in command it did not find anchored to a known CLI", () => {
    const setup = parseClaudeError("Not signed in. Please contact your administrator to log in.").setup;
    expect(setup).toEqual({ kind: "not-signed-in", command: null });
  });

  it("never reports a setup problem for a quota refusal", () => {
    // An account that is out of quota is an account that IS set up. Sending the user to
    // re-authenticate loses the one true fact in the message: when it resets.
    const quota = parseClaudeError("QUOTA_EXCEEDED::Claude AI usage limit reached, try again in 3 hours");
    expect(quota.isQuotaExceeded).toBe(true);
    expect(quota.setup).toBeNull();
    expect(quota.resetHint).toBe("3 hours");
  });
});

describe("the quota path still behaves", () => {
  it("separates billing from usage and keeps the provider's link", () => {
    const billing = parseClaudeError(
      "QUOTA_EXCEEDED::Insufficient balance. Manage your billing here: https://example.com/billing.",
    );
    expect(billing.kind).toBe("billing");
    expect(billing.actionUrl).toBe("https://example.com/billing");
  });
});
