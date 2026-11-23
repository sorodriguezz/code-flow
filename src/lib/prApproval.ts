import type { TranslationKey } from "./i18n/translations";

/**
 * Approving a pull request on the strength of a review — the decisions the panel makes before it
 * offers the action, and how it says a refusal.
 *
 * Kept out of the component so the rules are one readable list (and tested): an approval is an act
 * in a person's name on somebody else's pull request, and "why isn't the button there" has to have
 * an answer that does not depend on reading JSX.
 */

/** Why the review does not support approving — `null` when it does. */
export type ApprovalBlocker = "gate_failed" | "inconclusive" | "incomplete" | "closed" | "approved" | "stale";

/**
 * Whether the review on screen is grounds for approving, and if not, why.
 *
 * Order matters only for which reason is given: a closed PR or one already approved by this user
 * has nothing to approve whatever the gate says; a FAILED gate outranks the gate's other caveats.
 * `stale` covers reading an older iteration or a re-review still running — an approval must follow
 * the latest review, not whichever one happens to be open.
 */
export function approvalBlocker(state: {
  gatePassed: boolean;
  /** The report flagged its PASSED as not conclusive for its level (see `render.rs`). */
  inconclusive: boolean;
  /** A reviewer or pass failed, so part of the PR was not looked at. */
  incomplete: boolean;
  prStatus: string;
  decision: string;
  /** An older run is pinned, or a new one is running. */
  stale: boolean;
}): ApprovalBlocker | null {
  if (state.prStatus === "merged" || state.prStatus === "closed") return "closed";
  if (state.decision === "approved") return "approved";
  if (state.stale) return "stale";
  if (!state.gatePassed) return "gate_failed";
  if (state.inconclusive) return "inconclusive";
  if (state.incomplete) return "incomplete";
  return null;
}

/** Blockers under which the action is not shown at all, rather than shown disabled with a reason:
 * there is nothing to explain about a FAILED gate (the header says it) or a settled PR. */
export function hidesApproval(blocker: ApprovalBlocker | null): boolean {
  return blocker === "gate_failed" || blocker === "closed" || blocker === "approved" || blocker === "stale";
}

/** The line `render.rs` writes under a PASSED nobody earned. */
const INCONCLUSIVE_MARK = "Gate no concluyente";

/** Whether a rendered review flags its gate as not conclusive for the level it ran at. */
export function isGateInconclusive(reviewText: string | null | undefined): boolean {
  return Boolean(reviewText?.includes(INCONCLUSIVE_MARK));
}

/** The approval a run's memory records (`meta.approval`), or `null` when it records none. */
export interface RecordedApproval {
  account: string | null;
  approvedAt: string;
  gate: string;
}

export function recordedApproval(meta: Record<string, unknown> | null | undefined): RecordedApproval | null {
  const raw = meta?.approval;
  if (!raw || typeof raw !== "object") return null;
  const approval = raw as Record<string, unknown>;
  if (typeof approval.approved_at !== "string") return null;
  return {
    account: typeof approval.account === "string" && approval.account.trim() ? approval.account : null,
    approvedAt: approval.approved_at,
    gate: typeof approval.gate === "string" ? approval.gate : "",
  };
}

/**
 * A refused approval, in words. The hosts answer in their own dialects — GitHub's 422 "Can not
 * approve your own pull request", Bitbucket's "You can't approve your own pull request", a 403 from
 * a token missing the scope — and the raw text alone reads as a crash. The host's message is kept
 * after the sentence: it is the part that names what exactly was missing.
 */
export function describeApprovalError(
  error: string,
  translate: (key: TranslationKey, params?: Record<string, string>) => string,
): string {
  const text = error.replace(/^Error:\s*/, "");
  // The backend's own refusal (the gate no longer holds) is already a sentence.
  if (text.startsWith("No se aprobó el PR")) return text;
  if (/own (pull|merge) request|your own|author.*(cannot|can't|not allowed)|approve.*own/i.test(text)) {
    return translate("pr.approveOwnRefused", { error: text });
  }
  if (/\b40[13]\b|forbidden|permission|not authori[sz]ed|unauthori[sz]ed|scope|insufficient/i.test(text)) {
    return translate("pr.approvePermissionRefused", { error: text });
  }
  return translate("pr.approveFailed", { error: text });
}
