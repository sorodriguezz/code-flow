import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/tauri/events", () => ({ onAgentCliCreated: vi.fn() }));
vi.mock("../lib/tauri/memoryCommands", () => ({ aiMemoryDelete: vi.fn() }));
vi.mock("../lib/tauri/commands", () => ({ deleteAgentTask: vi.fn() }));
vi.mock("./agentsStore", () => ({ useAgentsStore: { getState: () => ({}) } }));
vi.mock("./uiStore", () => ({ useUiStore: { getState: () => ({}) } }));
vi.mock("./toastStore", () => ({ pushErrorToast: vi.fn() }));
vi.mock("../lib/windowIdentity", () => ({ isMainWindow: () => true }));

import { cardKey, withCard } from "./createdCardsStore";

describe("withCard", () => {
  const made = (id: string, kind: "task" | "memory" = "task") => ({ kind, id, title: id });

  it("shows the newest last and a repeat only once", () => {
    const cards = withCard(withCard(withCard([], made("a")), made("b")), made("a"));
    expect(cards.map((card) => card.id)).toEqual(["b", "a"]);
  });

  it("keeps a task and a memory with the same id apart", () => {
    expect(cardKey(made("x"))).not.toBe(cardKey(made("x", "memory")));
  });

  it("lets the oldest go past four", () => {
    const cards = ["a", "b", "c", "d", "e"].reduce((list, id) => withCard(list, made(id)), [] as ReturnType<typeof withCard>);
    expect(cards.map((card) => card.id)).toEqual(["b", "c", "d", "e"]);
  });
});
