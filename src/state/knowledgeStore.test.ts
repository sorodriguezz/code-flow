import { describe, expect, it, vi } from "vitest";
import { knowledgeOverview, type KnowledgeOverview } from "../lib/tauri/knowledgeCommands";
import { useKnowledgeStore } from "./knowledgeStore";

vi.mock("../lib/tauri/knowledgeCommands", () => ({ knowledgeOverview: vi.fn() }));
vi.mock("../lib/tauri/events", () => ({ onLocalAiDownload: vi.fn() }));
vi.mock("./localExecStore", () => ({ localExecErrorText: String }));

const overview = (pendingVectors: number): KnowledgeOverview => ({
  cloudAllowed: true,
  embedModels: [],
  embedSetting: null,
  space: null,
  embeddingModel: null,
  codeVectors: true,
  pendingVectors,
  repos: [],
  folders: [],
  sources: [],
});

describe("workspace knowledge loading", () => {
  it("shares pending reads and shows the cached workspace on return", async () => {
    const read = vi.mocked(knowledgeOverview);
    read.mockReset();
    read.mockResolvedValueOnce(overview(1)).mockResolvedValueOnce(overview(2)).mockResolvedValueOnce(overview(3));
    const { load } = useKnowledgeStore.getState();

    await Promise.all([load("first"), load("first")]);
    expect(read).toHaveBeenCalledTimes(1);
    await load("second");
    expect(useKnowledgeStore.getState().overview?.pendingVectors).toBe(2);

    const returning = load("first");
    expect(useKnowledgeStore.getState().overview?.pendingVectors).toBe(1);
    await returning;
    expect(useKnowledgeStore.getState().overview?.pendingVectors).toBe(3);
  });

  it("ignores a superseded response and recovers after a failed load", async () => {
    const read = vi.mocked(knowledgeOverview);
    read.mockReset();
    let finishFirst!: (result: KnowledgeOverview) => void;
    read.mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }));
    read.mockRejectedValueOnce(new Error("Index temporarily unavailable"));
    read.mockResolvedValueOnce(overview(4));
    const { load } = useKnowledgeStore.getState();

    const original = load("retry");
    await load("retry", true);
    expect(useKnowledgeStore.getState().loadFailed).toBe(true);
    await load("retry");
    expect(useKnowledgeStore.getState().loadFailed).toBe(false);
    finishFirst(overview(9));
    await original;
    expect(useKnowledgeStore.getState().overview?.pendingVectors).toBe(4);
  });
});
