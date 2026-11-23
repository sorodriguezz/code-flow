import { describe, expect, it } from "vitest";
import { approvalBlocker, describeApprovalError, hidesApproval, isGateInconclusive, recordedApproval } from "./prApproval";

const base = { gatePassed: true, inconclusive: false, incomplete: false, prStatus: "active", decision: "none", stale: false };

describe("approvalBlocker", () => {
  it("allows a conclusive, complete PASSED on an open PR", () => {
    expect(approvalBlocker(base)).toBeNull();
  });

  it("refuses for each reason, the settled PR first", () => {
    expect(approvalBlocker({ ...base, prStatus: "merged", gatePassed: false })).toBe("closed");
    expect(approvalBlocker({ ...base, decision: "approved" })).toBe("approved");
    expect(approvalBlocker({ ...base, stale: true })).toBe("stale");
    expect(approvalBlocker({ ...base, gatePassed: false, inconclusive: true })).toBe("gate_failed");
    expect(approvalBlocker({ ...base, inconclusive: true })).toBe("inconclusive");
    expect(approvalBlocker({ ...base, incomplete: true })).toBe("incomplete");
  });

  it("explains the caveats and hides the rest", () => {
    expect(hidesApproval("gate_failed")).toBe(true);
    expect(hidesApproval("closed")).toBe(true);
    expect(hidesApproval("inconclusive")).toBe(false);
    expect(hidesApproval(null)).toBe(false);
  });
});

describe("isGateInconclusive", () => {
  it("reads the report's own flag", () => {
    expect(isGateInconclusive("🚦 Quality Gate: ✅ PASSED\n⚠️ Gate no concluyente: la política…")).toBe(true);
    expect(isGateInconclusive("🚦 Quality Gate: ✅ PASSED")).toBe(false);
    expect(isGateInconclusive(null)).toBe(false);
  });
});

describe("recordedApproval", () => {
  it("reads who approved, and nothing from a meta without it", () => {
    expect(recordedApproval({ approval: { account: "@ana", approved_at: "2026-11-23T10:00:00Z", gate: "PASSED" } })).toEqual({
      account: "@ana",
      approvedAt: "2026-11-23T10:00:00Z",
      gate: "PASSED",
    });
    expect(recordedApproval({ approval: { account: null, approved_at: "t" } })?.account).toBeNull();
    expect(recordedApproval({})).toBeNull();
    expect(recordedApproval(null)).toBeNull();
  });
});

describe("describeApprovalError", () => {
  const t = (key: string, params?: Record<string, string>) => `${key}|${params?.error ?? ""}`;

  it("names the author's own PR", () => {
    expect(describeApprovalError("Error: 422 Can not approve your own pull request", t)).toBe(
      "pr.approveOwnRefused|422 Can not approve your own pull request",
    );
    expect(describeApprovalError("You can't approve your own pull request.", t)).toMatch(/^pr.approveOwnRefused/);
  });

  it("names a missing permission or scope", () => {
    expect(describeApprovalError("403 Forbidden", t)).toMatch(/^pr.approvePermissionRefused/);
    expect(describeApprovalError("token lacks the required scope", t)).toMatch(/^pr.approvePermissionRefused/);
  });

  it("keeps the backend's gate refusal and wraps anything else", () => {
    expect(describeApprovalError("No se aprobó el PR: el Quality Gate de esta revisión no pasó.", t)).toBe(
      "No se aprobó el PR: el Quality Gate de esta revisión no pasó.",
    );
    expect(describeApprovalError("couldn't reach GitHub", t)).toBe("pr.approveFailed|couldn't reach GitHub");
  });
});
