import {
  Apple,
  AppWindow,
  FolderTree,
  Globe,
  HardDrive,
  Cloud,
  Database,
  Inbox,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Server,
  ShieldCheck,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { KIND_LABEL, type AzureService, type RemoteKind, type RemoteOs } from "../../types/remote";
import { useT } from "../../state/languageStore";
import type { RemoteTransferEvent } from "../../lib/tauri/events";
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
 * **Four states, not three.** Filled = a shell is running — and for a cloud account, which has no
 * process, that is a credential that answered (see `cloudStatus` in the remote store); same light for
 * both because it answers one question, "is this thing working right now", and a second kind of dot
 * beside it would only make the reader ask which one to believe. Ringed = no shell, but this host is
 * holding something: a tunnel, a file session, a screen's loopback route, or a session whose pty
 * exited and whose pty master is still open. Hollow = nothing.
 *
 * `busy` is the one in between, while a release is in flight. Without it the dot held its old value
 * for the whole round trip — closing a pooled SFTP channel and killing two or three `ssh` children is
 * slower than the click — and then flipped, so the only reading available was that the click had not
 * registered.
 *
 * Drawn as a halo pulsing out of the dot rather than as a spinner, the same way `ConnectionDot` does
 * it: at seven pixels a spinner is a grey smudge, and the halo keeps the dot itself — which carries
 * the host's colour and the actual state — legible underneath. It sits in an overlay, so nothing in
 * the row moves when it appears.
 */
export function HostDot({
  session,
  active,
  busy = false,
  color,
}: {
  session: boolean;
  active: boolean;
  busy?: boolean;
  color?: string;
}) {
  const tint = color?.trim() || "var(--cf-accent)";
  const dot = session ? (
    <span
      aria-hidden
      className="h-[7px] w-[7px] shrink-0 rounded-full"
      style={{ background: tint }}
    />
  ) : active ? (
    <span
      aria-hidden
      className="h-[7px] w-[7px] shrink-0 rounded-full border"
      style={{ borderColor: tint }}
    />
  ) : (
    <span
      aria-hidden
      className="h-[7px] w-[7px] shrink-0 rounded-full border border-[var(--cf-text-muted)]/40"
    />
  );
  if (!busy) return dot;
  return (
    <span className="relative flex h-[7px] w-[7px] shrink-0 items-center justify-center">
      <span
        aria-hidden
        className="absolute inset-0 animate-ping rounded-full opacity-75 motion-reduce:animate-none motion-reduce:animate-pulse"
        style={{ backgroundColor: tint }}
      />
      {dot}
    </span>
  );
}

/** The toolbar button shape the database explorer uses, so both sidebars' headers match. */
export function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  title,
}: {
  icon: LucideIcon;
  label: string;
  /** The event is passed so a button that opens a menu can anchor it to itself — the (+) drops its
   *  list under the button rather than at wherever the pointer happened to be. */
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  /**
   * The hover, when it is not the name.
   *
   * For the button whose *consequence* is worth a sentence and whose accessible name is not — Receive
   * takes messages off a live queue for a visibility window, and that is what a tooltip is for, while
   * "Receive" is what a screen reader should say. Collapsing the two would make the accessible name a
   * paragraph, which is how an icon-only toolbar becomes unusable to the people who need the label
   * most. Defaults to the label, which is what every other button wants.
   */
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
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

/**
 * One bar for the whole transfer, wherever the transfer was started from.
 *
 * Shared by the two file browsers because it is the same statement in both: a transfer is a
 * transfer, and two bars that drew progress differently would be two things for the user to learn.
 *
 * The count is only shown for more than one file: on a single file "1 of 1" is noise, and on a
 * folder it is the only thing that says how much is left to start.
 */
export function TransferBar({ progress }: { progress: RemoteTransferEvent }) {
  const percent = progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  return (
    <div className="shrink-0 border-t border-[var(--cf-border)] px-3 py-1.5">
      <div className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
        <span className="min-w-0 flex-1 truncate font-mono">{progress.name}</span>
        {progress.files > 1 && (
          <span className="shrink-0 tabular-nums">
            {progress.file_index}/{progress.files}
          </span>
        )}
        <span className="shrink-0 tabular-nums">{Math.round(percent)}%</span>
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
        <div
          className="h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-150"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * One line for a long-running *loop* — an import of 900 rows, a count over a whole table, a delete
 * of forty blobs — as opposed to `TransferBar`, which reports one transfer's bytes.
 *
 * Here for the same reason `TransferBar` is: three panels had already written it, and the piece that
 * would have gone missing from the fourth copy is the Stop. A loop of round trips is the one kind of
 * work in this app the user cannot get out of any other way — no request is slow enough to cancel,
 * and the hundredth is as far away as the first — so the bar and the way out of it are one component.
 *
 * Determinate where a total is known and a running tally where it is not, because "how many so far"
 * is the only honest answer to a scan whose length nobody knows in advance. A percentage over a
 * total of zero would be a number the code invented.
 */
export function WorkBar({
  label,
  done,
  total,
  onStop,
  compact = false,
}: {
  label: string;
  done: number;
  /** 0 means "nobody knows how many" — a bare tally and a pulsing bar rather than a lying
   *  percentage. */
  total: number;
  onStop?: () => void;
  /** The 10px variant, for the 224px rail. */
  compact?: boolean;
}) {
  const t = useT();
  return (
    <div
      className={`shrink-0 border-b border-[var(--cf-border)] py-1.5 ${compact ? "px-2" : "px-3"}`}
    >
      <div
        className={`flex items-center text-[var(--cf-text-muted)] ${
          compact ? "gap-1.5 text-[10px]" : "gap-2 text-[11px]"
        }`}
      >
        <Loader2 size={compact ? 10 : 11} className="shrink-0 animate-spin" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {/* The spaces go with the roomy variant only: in a rail this narrow the label is the thing
            worth the width, and `12 / 40` costs two characters of it to say what `12/40` says. */}
        <span className="shrink-0 tabular-nums">
          {total > 0 ? (compact ? `${done}/${total}` : `${done} / ${total}`) : done}
        </span>
        {onStop && (
          <button
            type="button"
            onClick={onStop}
            title={t("remote.gridStop")}
            aria-label={t("remote.gridStop")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
        <div
          className={`h-full rounded-full bg-[var(--cf-accent)] ${
            total > 0 ? "transition-[width] duration-150" : "animate-pulse"
          }`}
          style={{ width: total > 0 ? `${(done / total) * 100}%` : "100%" }}
        />
      </div>
    </div>
  );
}

/** `1.2 MB`. Binary units, because that is what every file browser on every platform shows. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * An epoch-seconds stamp as a date somebody can read, in their own locale.
 *
 * Here rather than in either panel that wants it because "0 is not 1970" is the shared half: every
 * remote listing in this app reports a missing timestamp as a zero — a `BlobPrefix` row has no
 * modified date, a peeked message may carry no expiry — and a formatter that answered
 * `1 Jan 1970, 00:00` would put a wrong fact in a column instead of leaving it empty. Short month and
 * no seconds because these are columns, and a listing whose dates are 24 characters wide is a listing
 * with room for two columns.
 */
export function formatWhen(epochSeconds: number, language: string): string {
  if (!epochSeconds) return "";
  return new Date(epochSeconds * 1000).toLocaleString(language, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Remote paths are always `/`-separated, even when the server is Windows. */
export function joinRemote(dir: string, name: string): string {
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

export function parentRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}
