import {
  Apple,
  AppWindow,
  FolderTree,
  Globe,
  HardDrive,
  Cloud,
  Database,
  Inbox,
  Monitor,
  MonitorSmartphone,
  Server,
  ShieldCheck,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { KIND_LABEL, type AzureService, type RemoteKind, type RemoteOs } from "../../types/remote";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * The Remote workspace's shared visual vocabulary, the counterpart of `dbChrome`.
 *
 * Same job and same reasoning: an operating system gets *one* glyph and *one* colour, defined here,
 * so a host reads the same in the tree, in a tab and in the status bar. Three files each picking
 * their own is how those three drift apart.
 */

/** The panel fill, matching the database workspace's so the two views read as one app. */
export const CARD = "bg-[var(--cf-surface)]";

/**
 * The glyph for what a host *speaks*, which is a different question from what it runs.
 *
 * Both are shown, and neither replaces the other: the OS glyph answers "what is that machine", the
 * kind glyph answers "what can I do with it here". A Linux box reachable only over FTP is a
 * penguin and a globe, and collapsing that to one icon would lose whichever half the user was
 * looking for.
 */
export function kindIcon(kind: RemoteKind): LucideIcon {
  switch (kind) {
    case "sftp":
      return FolderTree;
    case "ftp":
      return Globe;
    case "ftps":
      return ShieldCheck;
    case "vnc":
      return Monitor;
    case "rdp":
      return MonitorSmartphone;
    // Object storage gets the cloud; the two that are not files get glyphs that say what they are
    // instead, because a queue drawn as a cloud beside a blob drawn as a cloud is two rows the eye
    // cannot separate.
    case "s3":
    case "azure":
    case "azure_blob":
    case "azure_files":
      return Cloud;
    case "azure_queue":
      return Inbox;
    case "azure_table":
      return Database;
    default:
      return Terminal;
  }
}

/**
 * A tint per kind, on the same "quiet enough not to compete with the host's own colour" budget as
 * [`osColor`] — with one deliberate exception. Plain FTP is amber because it is the one kind whose
 * defining property is that it is *unencrypted*, and that is worth a glance costing something.
 */
export function kindColor(kind: RemoteKind): string {
  switch (kind) {
    case "sftp":
      return "#2a9071";
    case "ftp":
      return "#c46720";
    case "ftps":
      return "#2d86c2";
    // The two screen kinds share a hue and differ only in glyph: they are the same family, and a
    // row is told apart from its neighbours by the shape long before the tint.
    case "vnc":
    case "rdp":
      return "#7a63c8";
    // Each cloud keeps its own house colour, which is the fastest way to tell an S3 row from an
    // Azure one in a list that now has both.
    case "s3":
      return "#c4801f";
    case "azure":
    case "azure_blob":
    case "azure_files":
    case "azure_queue":
    case "azure_table":
      return "#2d86c2";
    default:
      return "#8b8b96";
  }
}

/**
 * What each of a storage account's four services is called and drawn as.
 *
 * Here rather than in either of the two places that need it — the host's context menu and the
 * account panel's rail — because they are two drawings of one list, and the tour, the menu and the
 * rail disagreeing about whether it is "Files" or "File shares" is exactly the drift this file
 * exists to prevent.
 */
export const AZURE_SERVICE_LABEL: Record<AzureService, TranslationKey> = {
  blob: "remote.azBlobContainers",
  files: "remote.azFileShares",
  queues: "remote.queues",
  tables: "remote.tables",
};

export const AZURE_SERVICE_ICON: Record<AzureService, LucideIcon> = {
  blob: HardDrive,
  files: FolderTree,
  queues: Inbox,
  tables: Database,
};

export function KindGlyph({ kind, size = 14 }: { kind: RemoteKind; size?: number }) {
  const Icon = kindIcon(kind);
  return (
    <Icon size={size} style={{ color: kindColor(kind) }} aria-label={KIND_LABEL[kind] ?? "SSH"} />
  );
}

export function osIcon(os: RemoteOs): LucideIcon {
  switch (os) {
    case "macos":
      return Apple;
    case "windows":
      return AppWindow;
    case "other":
      return HardDrive;
    default:
      return Server;
  }
}

/**
 * A tint per operating system, kept deliberately quiet.
 *
 * The colour that carries meaning in this tree is the *host's own* — the one the user sets to mark
 * production — so the OS glyph must not compete with it. These are muted enough to read as a
 * category and not as a warning.
 */
export function osColor(os: RemoteOs): string {
  switch (os) {
    case "macos":
      return "#a1a1aa";
    case "windows":
      return "#3b82f6";
    case "other":
      return "#94a3b8";
    default:
      return "#f59e0b";
  }
}

export function OsGlyph({ os, size = 14 }: { os: RemoteOs; size?: number }) {
  const Icon = osIcon(os);
  return <Icon size={size} style={{ color: osColor(os) }} />;
}

/**
 * The colours a host may be tinted with.
 *
 * A fixed set rather than a colour wheel, because this tint is not decoration: it is drawn as the
 * *label* of the active tab, over `--cf-accent-soft`, and as a dot on the surface — in both themes,
 * from the one hex that was stored. A free picker offers thousands of values that fail at least one
 * of those four backgrounds, and the failure is invisible at the moment of choosing: a yellow picked
 * while the light theme is on is an unreadable tab label the next time the user opens the dark one.
 *
 * Twenty hues around the wheel, each with its lightness solved so its relative luminance lands near
 * 0.215 — the narrow band where a single colour clears 3:1 against white *and* against `#1e1e27`.
 * Every entry measures at least 3.48:1 on all four backgrounds: light surface, light accent-soft,
 * dark surface, dark accent-soft. The band is why they are all mid-tone and none is pale or nearly
 * black: 4.5:1 against both a near-white and a near-black is arithmetically impossible for any one
 * colour, so 3:1 — the WCAG floor for UI components — is the honest target and the tints sit in the
 * middle of it.
 */
export const HOST_COLORS = [
  "#d75454", // rojo
  "#d85730", // bermellón
  "#c46720", // naranja
  "#a9761e", // ámbar
  "#977e19", // oro
  "#7f8521", // oliva
  "#628c2c", // lima
  "#429133", // verde
  "#309151", // esmeralda
  "#2a9071", // jade
  "#298d8a", // teal
  "#298ba3", // cian
  "#2d86c2", // azul cielo
  "#4d7fd5", // azul
  "#6b79d4", // índigo
  "#8273d0", // violeta
  "#996bc7", // púrpura
  "#b45dc2", // orquídea
  "#c756a5", // magenta
  "#ce577f", // rosa
] as const;

/**
 * A host's state, as one dot.
 *
 * Three states rather than two, because "has a live session" and "has a live tunnel" are genuinely
 * different things to know about a machine and collapsing them would make a host with a forward up
 * look idle. Filled = a session is open; ringed = no session but something of this host's is
 * running; hollow = nothing.
 */
/**
 * The row's state light: filled while something is live, ringed while something is up, hollow
 * otherwise.
 *
 * `session` is what "live" means, and for a cloud account that is not a process but a credential
 * that answered — see `cloudStatus` in the remote store. Same light for both because it answers one
 * question ("is this thing working right now") and a second kind of dot beside it would only make
 * the reader ask which one to believe.
 */
export function HostDot({
  session,
  active,
  color,
}: {
  session: boolean;
  active: boolean;
  color?: string;
}) {
  const tint = color?.trim() || "var(--cf-accent)";
  if (session) {
    return (
      <span
        aria-hidden
        className="h-[7px] w-[7px] shrink-0 rounded-full"
        style={{ background: tint }}
      />
    );
  }
  if (active) {
    return (
      <span
        aria-hidden
        className="h-[7px] w-[7px] shrink-0 rounded-full border"
        style={{ borderColor: tint }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="h-[7px] w-[7px] shrink-0 rounded-full border border-[var(--cf-text-muted)]/40"
    />
  );
}

/** The toolbar button shape the database explorer uses, so both sidebars' headers match. */
export function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: LucideIcon;
  label: string;
  /** The event is passed so a button that opens a menu can anchor it to itself — the (+) drops its
   *  list under the button rather than at wherever the pointer happened to be. */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-6 w-6 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
        active
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
      }`}
    >
      <Icon size={13} />
    </button>
  );
}

/**
 * A small labelled pill — the protocol on a screen tab, the direction on a forward row.
 *
 * `icon` and `title` exist for the one place two *different* things were being drawn as the same
 * pill: a host card shows its group beside its tags, and those are not the same kind of fact. The
 * group is where the host lives — one of them, structural, the folder in the tree. A tag is the
 * crossing axis the one-level tree deliberately doesn't have — several of them, and a filter. Two
 * identical grey capsules said neither, so the group takes a glyph and both take a title.
 */
export function Pill({
  children,
  tone = "muted",
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  tone?: "muted" | "accent";
  icon?: LucideIcon;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10px] font-medium uppercase tracking-wide ${
        tone === "accent"
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "bg-black/[0.05] text-[var(--cf-text-muted)] dark:bg-white/[0.07]"
      }`}
    >
      {Icon && <Icon size={9} className="shrink-0 opacity-70" />}
      {children}
    </span>
  );
}
