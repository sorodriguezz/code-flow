import { describe, expect, it } from "vitest";
import { canResume, cliLine, hasCli, noteInLine, promptInLine } from "./cliLaunch";

describe("cliLine", () => {
  it("is the bare binary when there is nothing to resume", () => {
    expect(cliLine("codex", "codex", { sessionId: "abc" }, false)).toBe("codex");
    expect(cliLine("claude", "claude", { sessionId: null }, false)).toBe("claude");
  });

  it("resumes Claude Code's session, and only the system account's", () => {
    expect(cliLine("claude", "claude", { sessionId: "sess-1" }, false)).toBe("claude --resume sess-1");
    expect(cliLine("claude", "claude", { sessionId: "sess-1", accountId: "work" }, false)).toBe("claude");
    expect(canResume("claude", { sessionId: "  " })).toBe(false);
  });

  it("quotes a binary path with spaces for the shell it is typed into", () => {
    expect(cliLine("claude", "/Users/me/My Tools/claude", { sessionId: null }, false)).toBe("'/Users/me/My Tools/claude'");
    // PowerShell needs the call operator to run a quoted path.
    expect(cliLine("claude", "C:\\Program Files\\claude.exe", { sessionId: null }, true)).toBe('& "C:\\Program Files\\claude.exe"');
    expect(cliLine("claude", "claude.exe", { sessionId: null }, true)).toBe("claude.exe");
  });
});

describe("cliLine extras", () => {
  it("gives Claude Code its hooks file and the first prompt, quoted for the shell", () => {
    expect(
      cliLine("claude", "claude", { sessionId: null }, false, { settings: "/Users/me/Library/App Support/hooks.json", prompt: "fix the login, don't break it" }),
    ).toBe("claude --settings '/Users/me/Library/App Support/hooks.json' 'fix the login, don'\\''t break it'");
    // The settings are Claude's alone; Codex takes the prompt and nothing else.
    expect(cliLine("codex", "codex", { sessionId: null }, false, { settings: "/x.json", prompt: "hola" })).toBe("codex hola");
    // An agent that does not take a prompt on its line gets it typed in later.
    expect(cliLine("grok", "grok", { sessionId: null }, false, { prompt: "hola" })).toBe("grok");
  });

  it("tells Claude and Codex about cf on their command line, each its own way", () => {
    const extra = { settings: "/h/s.json", noteFile: "/h/cf-note.md", note: "Use cf ask <question> first." };
    expect(cliLine("claude", "claude", { sessionId: null }, false, extra)).toBe(
      "claude --settings /h/s.json --append-system-prompt-file /h/cf-note.md",
    );
    expect(cliLine("codex", "codex", { sessionId: null }, false, extra)).toBe(
      "codex -c 'developer_instructions=Use cf ask <question> first.'",
    );
    // The others take it with their first prompt instead.
    expect(cliLine("gemini", "agy", { sessionId: null }, false, extra)).toBe("agy");
    expect([noteInLine("claude"), noteInLine("codex"), noteInLine("grok")]).toEqual([true, true, false]);
  });

  it("never puts a prompt on a Windows command line", () => {
    expect(promptInLine("claude", true)).toBe(false);
    expect(cliLine("claude", "claude", { sessionId: null }, true, { prompt: "cost $5" })).toBe("claude");
  });
});

describe("hasCli", () => {
  it("knows the interactive CLIs and nothing else", () => {
    expect(hasCli("claude")).toBe(true);
    expect(hasCli("gemini")).toBe(true);
    expect(hasCli("custom")).toBe(false);
    expect(hasCli("codeflow")).toBe(false);
  });
});
