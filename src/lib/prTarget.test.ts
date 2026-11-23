import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri/commands", () => ({
  reviewPrFromLink: vi.fn(() => Promise.resolve("ok")),
  reviewPullRequest: vi.fn(() => Promise.resolve("ok")),
  approvePrFromReview: vi.fn(() => Promise.resolve({ pr: {}, activity: {}, account: null, recorded: true })),
  notifyStateChange: vi.fn(),
  isRepoBusy: vi.fn(() => false),
}));

import * as api from "./tauri/commands";
import { approveFromReview, review } from "./prTarget";

const link = { kind: "link", url: "https://github.com/acme/app/pull/7", workspaceId: "w1" } as const;

describe("prTarget for a review by link", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes 'review anyway' through, so a promotion's question can be answered", async () => {
    await review(link, 7, "job-1", "completo", true);
    expect(api.reviewPrFromLink).toHaveBeenCalledWith(link.url, "job-1", "completo", "w1", null, true);
    await review(link, 7, "job-2", "completo");
    expect(api.reviewPrFromLink).toHaveBeenLastCalledWith(link.url, "job-2", "completo", "w1", null, false);
  });

  it("approves on the strength of the link review's run", async () => {
    await approveFromReview(link, 7, "job-1", "ana");
    expect(api.approvePrFromReview).toHaveBeenCalledWith({ url: link.url, workspaceId: "w1", prId: 7, runId: "job-1", account: "ana" });
  });
});
