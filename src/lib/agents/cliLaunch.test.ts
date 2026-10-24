import { describe, expect, it } from "vitest";
import { canResume, cliLine, hasCli, noteInLine, promptInLine, shellFamily } from "./cliLaunch";

describe("cliLine", () => {
  it("is the bare binary when there is nothing to resume", () => {
    expect(cliLine("codex", "codex", { sessionId: "abc" }, "posix")).toBe("codex");
    expect(cliLine("claude", "claude", { sessionId: null }, "posix")).toBe("claude");
  });

  it("resumes Claude Code's session, and only the system account's", () => {
    expect(cliLine("claude", "claude", { sessionId: "sess-1" }, "posix")).toBe("claude --resume sess-1");
    expect(cliLine("claude", "claude", { sessionId: "sess-1", accountId: "work" }, "posix")).toBe("claude");
    expect(canResume("claude", { sessionId: "  " })).toBe(false);
  });

  it("quotes a binary path with spaces for the shell it is typed into", () => {
    expect(cliLine("claude", "/Users/me/My Tools/claude", { sessionId: null }, "posix")).toBe("'/Users/me/My Tools/claude'");
    // PowerShell needs the call operator to run a quoted path.
    expect(cliLine("claude", "C:\\Program Files\\claude.exe", { sessionId: null }, "powershell")).toBe('& "C:\\Program Files\\claude.exe"');
    expect(cliLine("claude", "claude.exe", { sessionId: null }, "powershell")).toBe("claude.exe");
  });
});

describe("cliLine extras", () => {
  it("gives Claude Code its hooks file and the first prompt, quoted for the shell", () => {
    expect(
      cliLine("claude", "claude", { sessionId: null }, "posix", { settings: "/Users/me/Library/App Support/hooks.json", prompt: "fix the login, don't break it" }),
    ).toBe("claude --settings '/Users/me/Library/App Support/hooks.json' 'fix the login, don'\\''t break it'");
    // The settings are Claude's alone; Codex takes the prompt and nothing else.
    expect(cliLine("codex", "codex", { sessionId: null }, "posix", { settings: "/x.json", prompt: "hola" })).toBe("codex hola");
    // An agent that does not take a prompt on its line gets it typed in later.
    expect(cliLine("grok", "grok", { sessionId: null }, "posix", { prompt: "hola" })).toBe("grok");
  });

  it("tells Claude and Codex about cf on their command line, each its own way", () => {
    const extra = { settings: "/h/s.json", noteFile: "/h/cf-note.md", note: "Use cf ask <question> first." };
    expect(cliLine("claude", "claude", { sessionId: null }, "posix", extra)).toBe(
      "claude --settings /h/s.json --append-system-prompt-file /h/cf-note.md",
    );
    expect(cliLine("codex", "codex", { sessionId: null }, "posix", extra)).toBe(
      "codex -c 'developer_instructions=Use cf ask <question> first.'",
    );
    // The others take it with their first prompt instead.
    expect(cliLine("gemini", "agy", { sessionId: null }, "posix", extra)).toBe("agy");
    expect([noteInLine("claude"), noteInLine("codex"), noteInLine("grok")]).toEqual([true, true, false]);
  });

  it("never puts a prompt on a Windows command line", () => {
    expect(promptInLine("claude", "powershell")).toBe(false);
    expect(cliLine("claude", "claude", { sessionId: null }, "powershell", { prompt: "cost $5" })).toBe("claude");
  });
});

describe("cliLine on Windows", () => {
  const extra = { settings: "C:\\Users\\me\\AppData\\Local\\CodeFlow\\agent-hooks\\claude-settings.json", noteFile: "C:\\Users\\me\\cf-note.md" };

  it("keeps the backslashes of a path typed into Git Bash", () => {
    // Bare, Git Bash ate them: `C:Usersme…` and «Settings file not found».
    expect(cliLine("claude", "claude", { sessionId: null }, "posix", extra)).toBe(
      "claude --settings 'C:\\Users\\me\\AppData\\Local\\CodeFlow\\agent-hooks\\claude-settings.json' --append-system-prompt-file 'C:\\Users\\me\\cf-note.md'",
    );
    // A quoted binary runs as is in Git Bash; only PowerShell needs the call operator.
    expect(cliLine("claude", "C:\\Tools\\claude.exe", { sessionId: null }, "posix")).toBe("'C:\\Tools\\claude.exe'");
    expect(cliLine("claude", "C:\\Tools\\claude.exe", { sessionId: null }, "powershell")).toBe('& "C:\\Tools\\claude.exe"');
    expect(cliLine("claude", "C:\\Tools\\claude.exe", { sessionId: null }, "cmd")).toBe('"C:\\Tools\\claude.exe"');
  });

  it("double-quotes those paths for PowerShell and cmd", () => {
    expect(cliLine("claude", "claude", { sessionId: null }, "powershell", extra)).toBe(
      'claude --settings "C:\\Users\\me\\AppData\\Local\\CodeFlow\\agent-hooks\\claude-settings.json" --append-system-prompt-file "C:\\Users\\me\\cf-note.md"',
    );
  });

  it("knows a profile's shell by its program", () => {
    expect(shellFamily("C:\\Program Files\\Git\\bin\\bash.exe")).toBe("posix");
    expect(shellFamily("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe("powershell");
    expect(shellFamily("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe("powershell");
    expect(shellFamily("C:\\Windows\\System32\\cmd.exe")).toBe("cmd");
    expect(shellFamily("/bin/zsh")).toBe("posix");
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
