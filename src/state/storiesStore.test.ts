import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StoryBatch, StoryDraft } from "../types/domain";

/**
 * Two things the stories screen used to do without asking: regenerating deleted every unpublished
 * story — edited and hand-added ones included — on one click, and editing a published story never
 * reached the board at all.
 */

type Handler = (args: Record<string, unknown>) => unknown;
let handlers: Record<string, Handler> = {};
let calls: string[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push(name);
    const handler = handlers[name];
    return handler ? handler(args) : null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));

const { regenerationLoss, useStoriesStore } = await import("./storiesStore");
const { useConfirmStore } = await import("./confirmStore");
const { useToastStore } = await import("./toastStore");

const GENERATED = "2026-09-20T10:00:00Z";

function story(id: string, patch: Partial<StoryDraft> = {}): StoryDraft {
  return {
    id,
    batch_id: "b1",
    seq: 0,
    title: `Historia ${id}`,
    narrative: "",
    description: "",
    acceptance_criteria: "[]",
    priority: 0,
    story_points: 0,
    original_estimate: 0,
    tags: "",
    notes: "",
    work_item_id: 0,
    work_item_key: "",
    work_item_url: "",
    verify_status: "",
    verify_summary: "",
    verify_criteria: "[]",
    verified_at: "",
    status: "draft",
    last_error: "",
    created_at: GENERATED,
    updated_at: GENERATED,
    ...patch,
  } as StoryDraft;
}

const batch = { id: "b1", generated_at: GENERATED, board_provider: "jira" } as unknown as StoryBatch;

/** Waits for the confirmation the store is awaiting. */
async function asked() {
  for (let i = 0; i < 50; i++) {
    const request = useConfirmStore.getState().request;
    if (request) return request;
    await Promise.resolve();
  }
  throw new Error("nothing was asked");
}

beforeEach(() => {
  handlers = {};
  calls = [];
  useToastStore.setState({ toasts: [] });
  useConfirmStore.setState({ request: null });
});

describe("regenerationLoss", () => {
  it("counts what a regeneration deletes, and which kinds of work go with it", () => {
    const stories = [
      story("untouched"),
      story("edited", { updated_at: "2026-09-21T09:00:00Z" }),
      story("mine", { created_at: "2026-09-22T09:00:00Z", updated_at: "2026-09-22T09:00:00Z" }),
      story("checked", { verified_at: "2026-09-23T09:00:00Z" }),
      story("published", { work_item_id: 42, updated_at: "2026-09-24T09:00:00Z" }),
    ];
    expect(regenerationLoss(batch, stories)).toEqual({ deleted: 4, edited: 1, handAdded: 1, verified: 1 });
  });

  it("treats every story of a set never generated as added by hand", () => {
    const never = { generated_at: "" } as StoryBatch;
    expect(regenerationLoss(never, [story("a"), story("b")])).toEqual({
      deleted: 2,
      edited: 0,
      handAdded: 2,
      verified: 0,
    });
  });
});

describe("confirmRegenerate", () => {
  it("does not ask when nothing unpublished would go", async () => {
    useStoriesStore.setState({ batches: [batch], storiesByBatch: { b1: [story("p", { work_item_id: 7 })] } });
    await expect(useStoriesStore.getState().confirmRegenerate("b1")).resolves.toBe(true);
    expect(useConfirmStore.getState().request).toBeNull();
  });

  it("asks, as a danger, with the count and what kind of work is lost", async () => {
    useStoriesStore.setState({
      batches: [batch],
      storiesByBatch: {
        b1: [story("a"), story("b", { updated_at: "2026-09-21T09:00:00Z" }), story("c", { created_at: "2026-09-25T00:00:00Z" })],
      },
    });
    const answer = useStoriesStore.getState().confirmRegenerate("b1");
    const request = await asked();
    expect(request.danger).toBe(true);
    expect(request.message).toContain("3");
    expect(request.items).toHaveLength(2);
    useConfirmStore.getState().respond(false);
    await expect(answer).resolves.toBe(false);
  });
});

describe("updateOnBoard", () => {
  beforeEach(() => {
    useStoriesStore.setState({
      batches: [batch],
      storiesByBatch: { b1: [story("s1", { work_item_id: 101, work_item_key: "WEB-7" })] },
    });
  });

  it("says the board is up to date instead of writing the same thing again", async () => {
    handlers.preview_story_board_update = () => [];
    await useStoriesStore.getState().updateOnBoard("b1", "s1");
    expect(calls).not.toContain("update_story_on_board");
    expect(useToastStore.getState().toasts.map((toast) => toast.message).join(" ")).toContain("Jira");
  });

  it("lists what would change, and writes only on a yes", async () => {
    handlers.preview_story_board_update = () => [
      { field: "title", before: "Viejo", after: "Nuevo" },
      { field: "content", before: "", after: "" },
    ];
    const first = useStoriesStore.getState().updateOnBoard("b1", "s1");
    const request = await asked();
    expect(request.danger).toBe(true);
    expect(request.message).toContain("WEB-7");
    expect(request.items?.[0]).toContain("Nuevo");
    useConfirmStore.getState().respond(false);
    await first;
    expect(calls).not.toContain("update_story_on_board");

    const second = useStoriesStore.getState().updateOnBoard("b1", "s1");
    await asked();
    useConfirmStore.getState().respond(true);
    await second;
    expect(calls).toContain("update_story_on_board");
  });

  it("does nothing for a story that was never published", async () => {
    useStoriesStore.setState({ storiesByBatch: { b1: [story("s1")] } });
    await useStoriesStore.getState().updateOnBoard("b1", "s1");
    expect(calls).toEqual([]);
  });
});
