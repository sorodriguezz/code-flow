/**
 * The keyring's shared visual vocabulary — the counterpart of `notesChrome` and `dbChrome`.
 *
 * One extra job here that the other two don't have: **the masked value**. A hidden secret has to be
 * drawn the same way everywhere it appears, or "is this hidden or is it empty?" becomes a question
 * the user has to answer by clicking. `MASK` is that answer, in one place.
 */

import {
  Cloud,
  CreditCard,
  Database,
  FileLock2,
  IdCard,
  KeyRound,
  Paperclip,
  Server,
  StickyNote,
  type LucideIcon,
} from "lucide-react";

import type { VaultItemKind } from "../../types/vault";

/** The panel fill, matching the other workspaces' so the views read as one app. */
export const CARD = "bg-[var(--cf-surface)]";

export const ROW =
  "group/row flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left text-[12px] transition-colors";

export const ROW_IDLE = "text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]";

export const ROW_ACTIVE = "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]";

const ICON_BUTTON_SHELL =
  "flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-white/[0.07]";

export const ICON_BUTTON = `${ICON_BUTTON_SHELL} text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]`;

export const INPUT =
  "w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";

export const BUTTON =
  "rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40";

export const BUTTON_QUIET =
  "rounded-md border border-[var(--cf-border)] px-3 py-1.5 text-[12px] text-[var(--cf-text)] transition-colors hover:bg-black/[0.04] disabled:opacity-40 dark:hover:bg-white/[0.05]";

/**
 * What a hidden value looks like.
 *
 * A fixed number of dots, deliberately — not one per character. A mask that matched the length
 * would leak the length of every password in the vault to anyone glancing at the screen, which is
 * exactly the sort of thing this app exists to avoid handing out for free.
 */
export const MASK = "••••••••••••";

/** One glyph per kind, so a list of mixed entries is scannable without reading it. */
const KIND_ICONS: Record<VaultItemKind, LucideIcon> = {
  login: KeyRound,
  key: FileLock2,
  // The same three glyphs the Remote and Database workspaces use for these things, so an entry and
  // the connection it belongs to are recognisably the same object in two lists.
  database: Database,
  server: Server,
  storage: Cloud,
  card: CreditCard,
  identity: IdCard,
  note: StickyNote,
  file: Paperclip,
};

export function kindIcon(kind: VaultItemKind): LucideIcon {
  return KIND_ICONS[kind] ?? KeyRound;
}

/** A size, for an attachment row. */
export function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A rough strength reading for the master-password box.
 *
 * Deliberately crude — length and variety, nothing more. It is a nudge while typing, not a promise:
 * a real estimator (zxcvbn and friends) is a dictionary this app has no reason to ship, and a
 * confident-looking score from a naive check is worse than an obviously rough one.
 */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 {
  const classes =
    Number(/[a-z]/.test(password)) +
    Number(/[A-Z]/.test(password)) +
    Number(/[0-9]/.test(password)) +
    Number(/[^A-Za-z0-9]/.test(password));
  const length = password.length;
  if (length < 10) return 0;
  if (length >= 20 || (length >= 16 && classes >= 3)) return 3;
  if (length >= 14 || classes >= 3) return 2;
  return 1;
}
