import { beforeEach, describe, expect, it } from "vitest";

import { useCommitDraftStore } from "./commitDraftStore";

describe("commit drafts", () => {
  beforeEach(() => useCommitDraftStore.setState({ drafts: {} }));

  it("keep each repository's message and generation apart", () => {
    const { patch } = useCommitDraftStore.getState();
    // Generating in /a, then the user switches to /b and types there.
    patch("/a", { aiBusy: true });
    patch("/b", { message: "wip" });
    // The model answers for /a.
    patch("/a", { message: "feat: a", aiBusy: false });

    const { drafts } = useCommitDraftStore.getState();
    expect(drafts["/a"]).toEqual({ message: "feat: a", aiBusy: false, aiError: null });
    expect(drafts["/b"]).toEqual({ message: "wip", aiBusy: false, aiError: null });
  });

  it("applies an update to the draft's current message", () => {
    const { patch } = useCommitDraftStore.getState();
    patch("/a", { message: "fix" });
    patch("/a", (d) => ({ message: `${d.message}\n\nSigned-off-by: x` }));
    expect(useCommitDraftStore.getState().drafts["/a"].message).toBe("fix\n\nSigned-off-by: x");
  });
});
