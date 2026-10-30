import type { GitRemoteProgressEvent } from "../types/domain";
import type { TranslationKey } from "./i18n/translations";

/** The latest meter redraw of one repository's running fetch/pull/push. */
export interface RemoteProgress {
  operation: string;
  line: string;
  phase: string | null;
  percent: number | null;
}

/** Keyed by repository path: switching repos must never show another repo's progress. */
export type RemoteProgressMap = Record<string, RemoteProgress>;

/** The map after `event`. A line without a meter (no phase, no percent) keeps the last meter's
 *  phase and percent rather than blanking them, so the tooltip doesn't flicker between redraws. */
export function reduceRemoteProgress(map: RemoteProgressMap, event: GitRemoteProgressEvent): RemoteProgressMap {
  const prev = map[event.repoPath];
  const meter = event.phase !== null || event.percent !== null;
  return {
    ...map,
    [event.repoPath]: {
      operation: event.operation,
      line: event.line,
      phase: meter ? event.phase : (prev?.phase ?? null),
      percent: meter ? event.percent : (prev?.percent ?? null),
    },
  };
}

export function clearRemoteProgress(map: RemoteProgressMap, repoPath: string): RemoteProgressMap {
  if (!(repoPath in map)) return map;
  const { [repoPath]: _gone, ...rest } = map;
  return rest;
}

export function remoteProgressOf(map: RemoteProgressMap, repoPath: string | null): RemoteProgress | null {
  return repoPath ? (map[repoPath] ?? null) : null;
}

const PHASE_KEYS: Record<string, TranslationKey> = {
  "enumerating objects": "git.phaseEnumerating",
  "counting objects": "git.phaseCounting",
  "compressing objects": "git.phaseCompressing",
  "writing objects": "git.phaseWriting",
  "receiving objects": "git.phaseReceiving",
  "resolving deltas": "git.phaseResolving",
};

/** The i18n key for a git meter phase, or `null` for one this build has no translation for. */
export function phaseKey(phase: string | null): TranslationKey | null {
  return phase ? (PHASE_KEYS[phase.trim().toLowerCase()] ?? null) : null;
}

/** «Receiving objects 45 %» — `translatePhase` turns a phase into its words. Empty when there is nothing to say. */
export function progressLabel(progress: RemoteProgress | null, translatePhase: (key: TranslationKey) => string): string {
  if (!progress || (progress.phase === null && progress.percent === null)) return "";
  const key = phaseKey(progress.phase);
  const phase = key ? translatePhase(key) : (progress.phase ?? "");
  const percent = progress.percent === null ? "" : `${Math.round(progress.percent)} %`;
  return [phase, percent].filter(Boolean).join(" ");
}
