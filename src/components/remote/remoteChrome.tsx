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
  Network,
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
import { iconButtonClass, type IconButtonSize } from "../common/Button";
import { chipClass, fieldClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";

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
 * A search box with its glyph inside it — the text field recipe worn by a wrapper, so the icon sits
 * in the field rather than beside it. `focus-within` rather than `focus`, because the element that
 * takes focus is the `<input>` inside; the input itself is `SEARCH_INPUT`.
 */
export const SEARCH_WRAP = fieldClass({
  size: "sm",
  className:
    "flex items-center gap-1.5 focus-within:border-[var(--cf-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]",
});

export const SEARCH_INPUT =
  "min-w-0 flex-1 bg-transparent outline-none placeholder:text-[var(--cf-text-faint)]";

/** An icon button whose act is a deletion: the muted glyph turns danger under the pointer. */
export const DANGER_ICON_BUTTON =
  "inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] transition-colors duration-100 hover:bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] hover:text-[var(--cf-danger)] disabled:pointer-events-none disabled:opacity-40";

/** A multi-line field: the text field recipe's fill, hairline and focus halo, at its own height. */
export const TEXTAREA =
  "block w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:opacity-50";

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
    // The glyph Explorer and Finder both put on a shared folder.
    case "smb":
      return Network;
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
 * A tint per kind, on a "quiet enough not to compete with the host's own colour" budget — with one
 * deliberate exception. Plain FTP is drawn in the theme's warning ink because it is the one kind
 * whose defining property is that it is *unencrypted*, and that is worth a glance costing something.
 * The token rather than a hex, so it is the same amber every other warning in the app wears, in
 * every theme — and the glyph carries a tooltip saying why, so the colour is never the only word.
 */
export function kindColor(kind: RemoteKind): string {
  switch (kind) {
    case "sftp":
      return "#2a9071";
    case "ftp":
      return "var(--cf-warning)";
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
  const t = useT();
  const Icon = kindIcon(kind);
  const glyph = (
    <Icon size={size} style={{ color: kindColor(kind) }} aria-label={KIND_LABEL[kind] ?? "SSH"} />
  );
  // The amber says "careful"; the tooltip says what about. Only FTP gets one: it is the only kind
  // whose tint is a warning rather than a category.
  if (kind !== "ftp") return glyph;
  return (
    <Tooltip label={KIND_LABEL.ftp} description={t("remote.kindFtpHint")}>
      {glyph}
    </Tooltip>
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
 * The ink an operating-system glyph is drawn in: the theme's faint one, whatever the OS.
 *
 * The colour that carries meaning in this tree is the *host's own* — the one the user sets to mark
 * production — so the OS glyph must not compete with it. It used to be a tint per OS on a "muted
 * enough" budget, and one of them did not survive the FTP rule in [`kindColor`]: Linux was amber, so
 * every Linux box wore the same colour that says "this connection is not encrypted", and the one
 * warning in the tree turned into wallpaper. The glyph's *shape* already says which OS it is.
 */
export function osColor(_os: RemoteOs): string {
  return "var(--cf-text-faint)";
}

export function OsGlyph({ os, size = 14 }: { os: RemoteOs; size?: number }) {
  const Icon = osIcon(os);
  return <Icon size={size} style={{ color: osColor(os) }} />;
}

/**
 * The colours a host may be tinted with.
 *
 * A fixed set rather than a colour wheel, because this tint is not decoration: it is drawn as the
 * glyph of the host's session tabs, as the edge of its row over `--cf-accent-soft` when selected,
 * and as a dot on the surface — in both themes, from the one hex that was stored. A free picker
 * offers thousands of values that fail at least one of those four backgrounds, and the failure is
 * invisible at the moment of choosing: a yellow picked while the light theme is on is an unreadable
 * tab glyph the next time the user opens the dark one.
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
 * it: at eight pixels a spinner is a grey smudge, and the halo keeps the dot itself — which carries
 * the host's colour and the actual state — legible underneath. It sits in an overlay, so nothing in
 * the row moves when it appears.
 *
 * The three resting states differ by *shape* before colour — full, a 2px ring, a hairline ring in
 * the faint ink — so the state still reads on a host with no colour of its own, and to anyone who
 * cannot tell the host's tint from the accent.
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
    <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: tint }} />
  ) : active ? (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ boxShadow: `inset 0 0 0 2px ${tint}` }}
    />
  ) : (
    <span
      aria-hidden
      className="h-2 w-2 shrink-0 rounded-full shadow-[inset_0_0_0_1.5px_var(--cf-text-faint)]"
    />
  );
  if (!busy) return dot;
  return (
    <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
      <span
        aria-hidden
        className="absolute inset-0 animate-ping rounded-full opacity-75 motion-reduce:animate-none motion-reduce:animate-pulse"
        style={{ backgroundColor: tint }}
      />
      {dot}
    </span>
  );
}

/**
 * An icon-only toolbar button: the shared recipe, labelled by the app's own tooltip rather than the
 * browser's `title` — so the name lands before the click, in the theme, and a consequence can ride
 * under it as a second line instead of being folded into one string.
 *
 * `xs` (22px) for the dense strips over a grid, where a dozen of these share a row; `sm` (26px) for
 * an explorer's head, where there are four or five and the target can afford to be the easy one.
 */
export function ToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
  title,
  size = "xs",
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
   * most. Shown under the label in the tooltip; without it the label is the whole tooltip, which is
   * what every other button wants.
   */
  title?: string;
  size?: IconButtonSize;
}) {
  return (
    <Tooltip label={label} description={title && title !== label ? title : undefined} side="bottom">
      <button
        type="button"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={iconButtonClass({ size, active })}
      >
        <Icon size={size === "xs" ? 13 : 14} />
      </button>
    </Tooltip>
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
 *
 * The shared chip recipe, and in the case it was typed in: it used to force capitals, which turned a
 * tunnel's `ssh -L` into `SSH -L` — a command nobody can paste — and a tag into a spelling its owner
 * never chose.
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
    <span title={title} className={chipClass(tone === "accent" ? "accent" : "neutral")}>
      {Icon && <Icon size={11} className="shrink-0 opacity-70" />}
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
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-[var(--cf-press)]">
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
          compact ? "gap-1.5 text-[10.5px]" : "gap-2 text-[11px]"
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
          <Tooltip label={t("remote.gridStop")}>
            <button
              type="button"
              onClick={onStop}
              aria-label={t("remote.gridStop")}
              className={DANGER_ICON_BUTTON}
            >
              <X size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      <div className="mt-1 h-[3px] overflow-hidden rounded-full bg-[var(--cf-press)]">
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
