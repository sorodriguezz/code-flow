import { MERGE_BLOCKED_MARKER } from "./tauri/commands";
import type { PublishOutcome } from "../types/domain";

/**
 * Why a host refused to merge, in the backend's words (`ado::classify_merge_refusal`). The panel
 * says each in its own sentence — "405 Method Not Allowed" on its own tells nobody that the branch
 * has conflicts — and keeps the host's message beside it.
 */
export type MergeRefusalKind =
  | "stale"
  | "conflicts"
  | "behind"
  | "checks"
  | "approvals"
  | "method"
  | "draft"
  | "blocked"
  | "other";

const KINDS: readonly MergeRefusalKind[] = [
  "stale",
  "conflicts",
  "behind",
  "checks",
  "approvals",
  "method",
  "draft",
  "blocked",
  "other",
];

/**
 * Reads a `MERGE_BLOCKED::{kind}::{message}` error. `null` for any other failure — a network error,
 * a missing token — which is said as it came. An unknown kind reads as `other` rather than being
 * dropped: the host's words are still the useful part.
 */
export function parseMergeRefusal(error: unknown): { kind: MergeRefusalKind; message: string } | null {
  const text = String(error);
  const at = text.indexOf(MERGE_BLOCKED_MARKER);
  if (at < 0) return null;
  const rest = text.slice(at + MERGE_BLOCKED_MARKER.length);
  const split = rest.indexOf("::");
  const rawKind = split < 0 ? rest : rest.slice(0, split);
  const message = split < 0 ? "" : rest.slice(split + 2).trim();
  const kind = (KINDS as readonly string[]).includes(rawKind) ? (rawKind as MergeRefusalKind) : "other";
  return { kind, message };
}

/** What a publish amounted to, counted the way the panel reports it. */
export interface PublishTally {
  /** New threads, anchored or general. */
  opened: number;
  /** Findings posted as a general comment because the host refused their line. */
  fallback: number;
  /** "Still present" replies and threads closed as fixed. */
  followedUp: number;
  /** Already published in this iteration, so nothing was said twice. */
  skipped: number;
  failed: number;
  /** The first failure's words, for the message. */
  firstError: string | null;
  /** Something that half-worked on an item that did land — a thread replied on that the host
   * wouldn't close. */
  warning: string | null;
  /** Ids of the findings that are now on the pull request (not failed, not skipped). */
  landedIds: string[];
  /** Ids of the findings that failed — what a retry should select. */
  failedIds: string[];
}

export function tallyPublish(outcome: PublishOutcome): PublishTally {
  const tally: PublishTally = {
    opened: 0,
    fallback: 0,
    followedUp: 0,
    skipped: 0,
    failed: 0,
    firstError: null,
    warning: null,
    landedIds: [],
    failedIds: [],
  };
  for (const item of outcome.items) {
    switch (item.status) {
      case "opened":
        tally.opened++;
        break;
      case "fallback":
        tally.opened++;
        tally.fallback++;
        break;
      case "replied":
      case "resolved":
        tally.followedUp++;
        break;
      case "skipped":
        tally.skipped++;
        break;
      default:
        tally.failed++;
        tally.firstError ??= item.error;
        if (item.id) tally.failedIds.push(item.id);
        continue;
    }
    // A reply that landed but whose thread would not close carries an error too: the reply is on the
    // pull request, so it counts as landed — the close is the warning.
    if (item.status !== "skipped" && item.id) tally.landedIds.push(item.id);
    if (item.error) tally.warning ??= item.error;
  }
  if (outcome.summary_error) {
    tally.failed++;
    tally.firstError ??= outcome.summary_error;
  }
  return tally;
}
