import { describe, expect, it } from "vitest";
import { extensionOf, paletteKey, usageHitsFor } from "./usageActions";

const surface = () => "chat" as const;

describe("usageActions", () => {
  it("counts a request by method and status class, never by URL", () => {
    const hits = usageHitsFor("api_send_http", { request: { method: "post", url: "https://secret.example/?token=x" } }, true, { status: 404 }, surface);
    expect(hits?.map((h) => h.key)).toEqual(["api.send", "api.method.POST", "api.status.4xx"]);
    expect(JSON.stringify(hits)).not.toContain("secret");
  });

  it("files a failed call as an error of its app", () => {
    expect(usageHitsFor("db_execute", { sql: "select 1" }, false, undefined, surface)).toEqual([{ kind: "error", key: "db.query" }]);
    expect(usageHitsFor("git_push", {}, false, undefined, surface)).toEqual([{ kind: "error", key: "git.push" }]);
    // A git success is the backend's to count.
    expect(usageHitsFor("git_push", {}, true, undefined, surface)).toEqual([]);
  });

  it("keeps only a file's extension", () => {
    expect(extensionOf("/repo/src/My Secret Plan.TS")).toBe("ts");
    expect(extensionOf("Makefile")).toBe("none");
    const hits = usageHitsFor("write_editor_file", { repoPath: "/r", relPath: "notes/plan.md" }, true, null, surface);
    expect(hits?.map((h) => h.key)).toEqual(["editor.save", "editor.save.md"]);
  });

  it("counts a chat turn by surface, then its reply by engine and model", () => {
    const reply = { provider: "claude", model: "opus", response_time_ms: 4200 };
    const hits = usageHitsFor("chat_send", { conversationId: "c", message: "private words" }, true, reply, () => "workspace");
    expect(hits).toEqual([
      { kind: "chat", key: "workspace.sent" },
      { kind: "chat", key: "workspace.reply", seconds: 4.2 },
      { kind: "chat_engine", key: "claude/opus" },
    ]);
    const agents = usageHitsFor("send_chat_message", { agentPrompt: "role" }, false, undefined, surface);
    expect(agents).toEqual([{ kind: "chat", key: "agents.sent" }, { kind: "error", key: "chat.agents" }]);
    expect(usageHitsFor("repo_chat_attach_bytes", { name: "shot.png" }, true, null, surface)).toEqual([{ kind: "chat", key: "repo.image" }]);
  });

  it("ignores everything it does not know", () => {
    expect(usageHitsFor("get_setting", { key: "x" }, true, "v", surface)).toBeNull();
  });

  it("names palette rows by catalogue id, never by data", () => {
    expect(paletteKey("branches", "branch:feature/secret")).toBe("branches");
    expect(paletteKey("views", "view:graph:ws-1")).toBe("view:graph");
    expect(paletteKey("actions", "action:flow:f1:n2")).toBe("action:flow");
    expect(paletteKey("settings", "settings:git:identity")).toBe("settings:git:identity");
  });
});
