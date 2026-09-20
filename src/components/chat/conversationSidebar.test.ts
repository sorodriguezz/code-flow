import { describe, expect, it } from "vitest";
import { splitProjects } from "./ConversationSidebar";
import type { ChatGroup } from "../../lib/tauri/chatCommands";

/**
 * The sidebar draws three bands and a project has to land in exactly one of them. Which one is
 * decided by a precedence rule — archived beats pinned — and a precedence rule is the kind of thing
 * that survives every review and then quietly inverts during an unrelated edit, because both
 * orderings look reasonable in isolation.
 *
 * The other half of the contract is that this function **never sorts**. The backend's `ORDER BY`
 * is the single opinion about order in the app; a filter that also sorted would be a second one,
 * in a second language, and the two would agree right up until they didn't.
 */
const project = (over: Partial<ChatGroup>): ChatGroup => ({
  id: over.name ?? "id",
  name: "p",
  color: "",
  sortOrder: 0,
  collapsed: false,
  instructions: "",
  createdAt: "2026-01-01T00:00:00Z",
  conversationCount: 0,
  ...over,
});

describe("splitProjects", () => {
  it("puts pinned projects on the pinned shelf and leaves the rest below", () => {
    const groups = [
      project({ name: "pinned", pinnedAt: "2026-02-01T00:00:00Z" }),
      project({ name: "plain" }),
    ];

    const { pinned, loose } = splitProjects(groups);
    expect(pinned.map((g) => g.name)).toEqual(["pinned"]);
    expect(loose.map((g) => g.name)).toEqual(["plain"]);
  });

  it("keeps an archived project on the shelf even when it is also pinned", () => {
    // The trap: turning on "show archived" would otherwise lift a project the user put away to the
    // very top of the sidebar, above everything they still use.
    const groups = [
      project({ name: "both", pinnedAt: "2026-02-01T00:00:00Z", archivedAt: "2026-03-01T00:00:00Z" }),
    ];

    const { pinned, loose } = splitProjects(groups);
    expect(pinned).toEqual([]);
    expect(loose.map((g) => g.name)).toEqual(["both"]);
  });

  it("keeps the order it was given, in both bands", () => {
    // Deliberately handed back-to-front against every field it could be tempted to sort by.
    const groups = [
      project({ name: "z", pinnedAt: "2026-01-01T00:00:00Z", createdAt: "2026-09-01T00:00:00Z" }),
      project({ name: "a", pinnedAt: "2026-02-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z" }),
      project({ name: "y", createdAt: "2026-09-01T00:00:00Z" }),
      project({ name: "b", createdAt: "2026-01-01T00:00:00Z" }),
    ];

    const { pinned, loose } = splitProjects(groups);
    expect(pinned.map((g) => g.name)).toEqual(["z", "a"]);
    expect(loose.map((g) => g.name)).toEqual(["y", "b"]);
  });

  it("returns two empty bands rather than throwing on an empty sidebar", () => {
    expect(splitProjects([])).toEqual({ pinned: [], loose: [] });
  });
});
