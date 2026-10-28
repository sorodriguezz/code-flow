import type { ProviderLastError } from "../../lib/tauri/commands";

/**
 * What the slab above the composer says, if anything. One notice at a time, by what the person can
 * act on first: a message sent offline cannot run at all, a signed-out CLI cannot either, a spent plan
 * may be worked around with a backup, and an update is only an offer.
 */
export type ComposerNotice =
  | { kind: "offline" }
  | { kind: "signIn"; provider: string }
  | { kind: "quota"; provider: string; message: string; backup: { provider: string; model: string } | null }
  | { kind: "cliMissing"; provider: string }
  | { kind: "update"; provider: string; label: string; from: string; to: string };

export interface NoticeInputs {
  provider: string;
  /** Whether the provider runs on this machine (no network involved). */
  local: boolean;
  online: boolean;
  lastError: ProviderLastError | null;
  /** The first entry of the user's backup list that is not the provider in use, if any. */
  backup: { provider: string; model: string } | null;
  update: { label: string; from: string; to: string } | null;
}

export function composerNotice(input: NoticeInputs): ComposerNotice | null {
  if (!input.online && !input.local) return { kind: "offline" };
  const error = input.lastError;
  if (error?.kind === "auth_required") return { kind: "signIn", provider: input.provider };
  if (error?.kind === "quota") {
    return { kind: "quota", provider: input.provider, message: error.message, backup: input.backup };
  }
  if (error?.kind === "cli_missing") return { kind: "cliMissing", provider: input.provider };
  if (input.update) return { kind: "update", provider: input.provider, ...input.update };
  return null;
}

/** A stable identity for dismissing: the same notice about the same thing stays closed, a different one shows. */
export function noticeKey(notice: ComposerNotice): string {
  switch (notice.kind) {
    case "offline":
      return "offline";
    case "update":
      return `update:${notice.provider}:${notice.to}`;
    case "quota":
      return `quota:${notice.provider}:${notice.message}`;
    default:
      return `${notice.kind}:${notice.provider}`;
  }
}

/** The first backup that is not the provider already in use. */
export function firstBackup(
  list: { provider: string; model: string }[],
  current: string,
): { provider: string; model: string } | null {
  return list.find((entry) => entry.provider !== current && entry.model.trim() !== "") ?? null;
}
