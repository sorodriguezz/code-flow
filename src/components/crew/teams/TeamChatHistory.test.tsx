import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeamChatSummary } from "../../../lib/tauri/teamCommands";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("../state", () => ({ useL: () => (_es: string, en: string) => en }));

const { chatTitle, nextChat, TeamChatHistory } = await import("./TeamChatHistory");
const en = (_es: string, text: string) => text;
const items: TeamChatSummary[] = [
  { id: "new", title: "", createdAt: "2026-11-25T12:17:13Z", messages: 0 },
  { id: "hola", title: "hola", createdAt: "2026-11-25T11:00:00Z", messages: 6 },
  { id: "old", title: "Revisa el esquema", createdAt: "2026-11-20T11:00:00Z", messages: 2 },
];

describe("team chat history", () => {
  it("names a conversation by its first words, and says so when it has none", () => {
    expect(chatTitle(items[1], en)).toBe("hola");
    expect(chatTitle(items[0], en)).toBe("Conversation with no messages");
  });

  it("turns to the most recent of the others when the one on screen is deleted", () => {
    expect(nextChat(items, "new")).toBe("hola");
    expect(nextChat(items, "hola")).toBe("new");
    expect(nextChat([items[1]], "hola")).toBeUndefined();
  });

  it("shows the conversation on screen and how many there are, closed until asked", () => {
    const html = renderToStaticMarkup(<TeamChatHistory chatId="hola" items={items} busy={false} compact onPick={() => {}} onNew={() => {}} onDelete={async () => true} />);
    expect(html).toContain("aria-label=\"Team conversations\"");
    expect(html).toContain("aria-expanded=\"false\"");
    expect(html).toContain(">hola<");
    expect(html).toContain(">3<");
    expect(html).not.toContain("Delete the conversation");
  });
});
