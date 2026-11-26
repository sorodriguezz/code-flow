import type { TranslationKey } from "./i18n/translations";

/**
 * The `remote.action.*` keys the backend is allowed to name.
 *
 * A payload from `remotectl` is the one place a `TranslationKey` arrives from outside this
 * codebase — in a notification as the act happens, and in the log of what devices did — and a
 * newer desktop paired with an older one, or the reverse, can send a key this build has no string
 * for. Checking against the list here means an unknown one is dropped rather than rendered as its
 * own raw key, which is what `translate` would do with it.
 *
 * Kept in step with `announce_for` in `src-tauri/src/remotectl/dispatch.rs` — and checked against it
 * by `remoteActions.test.ts`, because this list fell behind once: the two flow actions had strings
 * and were never added here, so a flow decided from a phone was announced by the backend and
 * dropped by the window.
 */
const REMOTE_ACTION_KEYS = new Set<string>([
  "remote.action.commit",
  "remote.action.push",
  "remote.action.pull",
  "remote.action.fetch",
  "remote.action.checkout",
  "remote.action.branch",
  "remote.action.gateApproved",
  "remote.action.stepSkipped",
  "remote.action.chainAborted",
  "remote.action.chainResumed",
  "remote.action.stepRetried",
  "remote.action.runCancelled",
  "remote.action.prReviewed",
  "remote.action.prActed",
  "remote.action.prCommented",
  "remote.action.threadResolved",
  "remote.action.findingDiscarded",
  "remote.action.analyzed",
  "remote.action.chat",
  "remote.action.terminalOpened",
  "remote.action.terminalClosed",
  "remote.action.stashApplied",
  "remote.action.stashPopped",
  "remote.action.pipelineRerun",
  "remote.action.pipelineCancelled",
  "remote.action.flowDecided",
  "remote.action.flowStarted",
  "remote.action.servicesStarted",
  "remote.action.servicesStopped",
  "remote.action.servicesRestarted",
  "remote.action.teamDecided",
  "remote.action.teamAnswered",
  "remote.action.teamNoted",
  "remote.action.teamControlled",
  "remote.action.teamStarted",
  "remote.action.teamChat",
  "remote.action.noteCreated",
  "remote.action.noteSaved",
  "remote.action.containerActed",
]);

export function isRemoteActionKey(key: string): key is TranslationKey {
  return REMOTE_ACTION_KEYS.has(key);
}

/** Every key, for the test that holds this list against the backend's. */
export const remoteActionKeys = (): string[] => [...REMOTE_ACTION_KEYS];
