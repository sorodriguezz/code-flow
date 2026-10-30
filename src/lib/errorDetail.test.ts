import { beforeEach, describe, expect, it, vi } from "vitest";

const classify = vi.fn();
const write = vi.fn();
vi.mock("./tauri/commands", () => ({ userErrorClassify: (e: string) => classify(e) }));
vi.mock("./clipboard", () => ({ writeClipboardText: (t: string) => write(t) }));

import { copyErrorDetail, errorDetailText } from "./errorDetail";

describe("errorDetailText", () => {
  it("puts the code first and the message after it", () => {
    expect(errorDetailText("boom", "NET-1A2B")).toBe("NET-1A2B\nboom");
  });
  it("is just the message without a code", () => {
    expect(errorDetailText("boom", null)).toBe("boom");
    expect(errorDetailText("boom", "  ")).toBe("boom");
  });
});

describe("copyErrorDetail", () => {
  beforeEach(() => {
    classify.mockReset();
    write.mockReset();
  });
  it("classifies only when called and copies code + message", async () => {
    classify.mockResolvedValue({ kind: "network", reference: "NET-1", retryable: true });
    expect(classify).not.toHaveBeenCalled();
    await copyErrorDetail("offline");
    expect(classify).toHaveBeenCalledWith("offline");
    expect(write).toHaveBeenCalledWith("NET-1\noffline");
  });
  it("falls back to the message when the classifier fails", async () => {
    classify.mockRejectedValue(new Error("no backend"));
    await copyErrorDetail("offline");
    expect(write).toHaveBeenCalledWith("offline");
  });
});
