import {
  Copy,
  FolderOpen,
  Loader2,
  Monitor,
  MonitorSmartphone,
  Pencil,
  Settings2,
  Terminal,
  Trash2,
  Unplug,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { MenuItem } from "../api/CollectionTree";
import { AZURE_SERVICE_ICON, AZURE_SERVICE_LABEL, kindIcon } from "./remoteChrome";
import {
  disconnectHost,
  hostIsHolding,
  useRemoteStore,
  type RemoteDetailsTab,
} from "../../state/remoteStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  AZURE_SERVICES,
  capabilities,
  defaultHostSpec,
  hasAddress,
  isAzureKind,
  parseHostSpec,
  type RemoteHostRow,
  type RemoteHostSpec,
  type RemoteKind,
} from "../../types/remote";

/**
 * The two menus the Remote workspace opens on a right-click, defined once.
 *
 * They were written twice before — the tree had them and the gallery had none — which is the shape
 * of bug that ends with a host you can delete from one view and not the other. The tree and the
 * gallery are two drawings of the same object, so the actions on it are built here and both call in.
 */

// ---------------------------------------------------------------------------
// What a host can be asked to do
// ---------------------------------------------------------------------------

/**
 * Everything a host row offers, in the order the row's own buttons are in.
 *
 * `onRename` is optional because inline rename is a *tree* affordance: the gallery has no editable
 * cell to put a caret in, so there the entry is simply absent and "Host settings" — whose first
 * field is the name — is the way. An entry that opened a whole panel and called itself "Rename"
 * would be the worse answer.
 */
export function useHostMenu() {
  const openSession = useRemoteStore((s) => s.openSession);
  const openForwards = useRemoteStore((s) => s.openForwards);
  const openScreen = useRemoteStore((s) => s.openScreen);
  const openSftp = useRemoteStore((s) => s.openSftp);
  const openAzure = useRemoteStore((s) => s.openAzure);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const duplicateHost = useRemoteStore((s) => s.duplicateHost);
  const deleteHost = useRemoteStore((s) => s.deleteHost);
  const tabs = useRemoteStore((s) => s.tabs);
  // `holds` rather than `forwards`: it carries the forward count *and* the two things the old
  // predicate could not see, so this is one subscription where there were two.
  const holds = useRemoteStore((s) => s.holds);
  const disconnecting = useRemoteStore((s) => s.disconnecting);
  const t = useT();

  return (host: RemoteHostRow, options: { onRename?: () => void } = {}): MenuItem[] => {
    const spec = parseHostSpec(host);
    // What this host *can* do, by kind. An FTP host has files and nothing else, a jailed SFTP
    // account has no shell, and a screen host has neither — so the menu doesn't offer any of them.
    // The backend refuses each independently; this is what keeps the user from ever meeting that
    // refusal.
    const can = capabilities(spec);
    const incomplete = !hasAddress(spec);
    // What Disconnect would actually release, which is not what "live" used to mean. The two it
    // missed are the expensive ones: a file session is an `ssh -s … sftp` child (or a logged-in FTP
    // control socket) held per host until something closes it, and a screen's tunnel and bridge route
    // outlive the viewer window. A session whose pty exited counts too — `exited` says the far side
    // hung up, not that this machine let go of the pty.
    const held = hostIsHolding(host.id, tabs, holds);
    const busy = disconnecting.includes(host.id);

    // A host with no address can do none of it, and the useful response is not an error saying so —
    // it is the editor, open, on the field that is missing.
    const act = (run: () => void) => () => (incomplete ? openDetails(host.id) : run());

    // An Azure row is an account, so its entries are its four services rather than "Files" — each
    // one opens the account panel on that page, in the tab that is already open if there is one.
    // The legacy single-service kinds get the same four: the row still says which service it was
    // made for (that is where it opens), and there is no reason to hide the other three.
    const azure = isAzureKind(spec.kind);

    return [
      ...(can.shell
        ? [
            {
              label: t("remote.openShell"),
              icon: Terminal,
              onClick: act(() => void openSession(host.id)),
            },
          ]
        : []),
      ...(azure
        ? AZURE_SERVICES.map((service) => ({
            label: t(AZURE_SERVICE_LABEL[service]),
            icon: AZURE_SERVICE_ICON[service],
            onClick: act(() => openAzure(host.id, service)),
          }))
        : []),
      ...(can.files && !azure
        ? [{ label: t("remote.files"), icon: FolderOpen, onClick: act(() => openSftp(host.id)) }]
        : []),
      ...(can.forwards
        ? [
            {
              label: t("remote.portForwards"),
              icon: Waypoints,
              onClick: act(() => openForwards(host.id)),
            },
          ]
        : []),
      ...(can.screen
        ? [
            {
              label: t("remote.openScreen"),
              icon: Monitor,
              onClick: act(() => void openScreen(host.id)),
            },
          ]
        : []),
      {
        label: t("remote.editHost"),
        icon: Settings2,
        onClick: () => openDetails(host.id),
        separated: true,
      },
      ...(options.onRename
        ? [{ label: t("remote.rename"), icon: Pencil, onClick: options.onRename }]
        : []),
      { label: t("remote.duplicate"), icon: Copy, onClick: () => void duplicateHost(host.id) },
      // Shown-but-disabled only while the release is in flight, never when nothing is held: removing
      // the entry mid-flight would make the menu change length between two right-clicks, and leaving
      // it live would let a second click re-run a teardown that is already running. A permanently
      // greyed Disconnect on twenty idle hosts would be twenty dead entries, and unlike a database
      // row there is no Connect to pair it with — "connect" here is already spelled Open shell /
      // Files / Open screen, three entries up.
      ...(busy
        ? [
            {
              label: t("remote.disconnecting"),
              icon: Loader2,
              disabled: true,
              onClick: () => {},
              separated: true,
            },
          ]
        : held
          ? [
              {
                label: t("remote.disconnect"),
                icon: Unplug,
                onClick: () => void disconnectHost(host.id),
                separated: true,
              },
            ]
          : []),
      {
        label: t("common.delete"),
        icon: Trash2,
        danger: true,
        separated: true,
        onClick: () => {
          void confirmAction(t("remote.confirmDeleteHost", { name: host.name })).then(
            (ok) => ok && void deleteHost(host.id),
          );
        },
      },
    ];
  };
}

/**
 * What activating a host opens — double-click, Enter, or the editor's Connect button.
 *
 * Defined once and called from all three, because they are three gestures meaning one thing ("show
 * me this"), and they used to disagree: the tree opened a file browser for a VNC host, which has no
 * files at all. In capability order, which is also "the biggest thing this host is": an account if
 * it is one, then a shell, then a screen, then files. Every kind matches exactly one.
 *
 * A host with no address opens its editor instead. That is not an error path — a newly created host
 * is exactly this case, and an error toast saying "fill in the address" is worse than the field.
 */
export function useOpenPrimary() {
  const openSession = useRemoteStore((s) => s.openSession);
  const openSftp = useRemoteStore((s) => s.openSftp);
  const openScreen = useRemoteStore((s) => s.openScreen);
  const openAzure = useRemoteStore((s) => s.openAzure);
  const openDetails = useRemoteStore((s) => s.openDetails);

  return (host: RemoteHostRow, spec: RemoteHostSpec = parseHostSpec(host)) => {
    if (!hasAddress(spec)) return openDetails(host.id);
    if (isAzureKind(spec.kind)) return openAzure(host.id);
    const can = capabilities(spec);
    if (can.shell) void openSession(host.id);
    else if (can.screen) void openScreen(host.id);
    else openSftp(host.id);
  };
}

// ---------------------------------------------------------------------------
// What a host can be created as
// ---------------------------------------------------------------------------

/**
 * The kinds of connection the (+) offers, as three families.
 *
 * One "New host" button could not say this. The three families are genuinely different machines to
 * set up — a screen has a viewer and no shell to speak of, an FTP host has no `~/.ssh/config`
 * behind it, and SSH is the only one of the three that has a command line — and picking the family
 * *first* is what lets the editor open with the fields that don't apply already gone.
 *
 * Every entry is now a plain `kind`, which it did not use to be: a screen used to be an SSH row
 * with `screen.protocol` set, so this menu had to hand-build a spec that the Type select could not
 * name. The kind *is* the protocol now (see `types/remote`), so the menu offers exactly the six
 * things that select offers, and a row created here reads back as what it was created as.
 */
export interface NewConnection {
  id: RemoteKind;
  labelKey: TranslationKey;
  icon: LucideIcon;
  /** Tacked onto the default name, so six fresh rows don't all read "New host". */
  suffix: string;
  /** A hairline above this entry — what separates the three families. */
  separated?: boolean;
  /** Which page of the editor to open on. Connection for all of them: a screen row's address is
   *  its screen's, so there is nothing left on the Screen page that has to be filled in first. */
  tab: RemoteDetailsTab;
  spec: () => RemoteHostSpec;
}

export const NEW_CONNECTIONS: NewConnection[] = [
  {
    id: "vnc",
    labelKey: "remote.newScreenVnc",
    icon: Monitor,
    suffix: "VNC",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "vnc" }),
  },
  {
    id: "rdp",
    labelKey: "remote.newScreenRdp",
    icon: MonitorSmartphone,
    suffix: "RDP",
    tab: "connection",
    // Windows by default — RDP is that machine, and it is the OS glyph the row will draw. Nothing
    // stops the user changing it; it is a default, not a rule.
    spec: () => ({ ...defaultHostSpec(), kind: "rdp", os: "windows" }),
  },
  {
    id: "ssh",
    labelKey: "remote.newSsh",
    icon: kindIcon("ssh"),
    suffix: "SSH",
    separated: true,
    tab: "connection",
    spec: () => defaultHostSpec(),
  },
  {
    id: "sftp",
    labelKey: "remote.newSftp",
    icon: kindIcon("sftp"),
    suffix: "SFTP",
    separated: true,
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "sftp" }),
  },
  {
    id: "ftp",
    labelKey: "remote.newFtp",
    icon: kindIcon("ftp"),
    suffix: "FTP",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "ftp" }),
  },
  {
    id: "ftps",
    labelKey: "remote.newFtps",
    icon: kindIcon("ftps"),
    suffix: "FTPS",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "ftps" }),
  },
  // The fourth family: an account in somebody's cloud rather than a machine. Separated from the
  // file protocols above because what you fill in is not an address and a password — it is an
  // account and a credential, and the editor swaps the whole block.
  {
    id: "s3",
    labelKey: "remote.newS3",
    icon: kindIcon("s3"),
    suffix: "S3",
    separated: true,
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "s3" }),
  },
  // One entry for the whole of Azure Storage, where there used to be four. An account is one name
  // and one key with four services behind it — offering "Azure Blob" and "Azure Queue" as separate
  // things to create was offering four rows for one account, four copies of the key, and four
  // things to fix when it rotated.
  {
    id: "azure",
    labelKey: "remote.newAzure",
    icon: kindIcon("azure"),
    suffix: "Azure",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "azure" }),
  },
];

/**
 * The (+) menu, for whichever group it was opened over.
 *
 * Straight into the editor rather than into inline rename: a new host needs an address before it is
 * anything, and the editor's first field is the name anyway — so this is one step that asks for
 * everything instead of two that ask for the least useful part first.
 */
export function useNewConnectionMenu() {
  const createHost = useRemoteStore((s) => s.createHost);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const t = useT();

  return (group = ""): MenuItem[] =>
    NEW_CONNECTIONS.map((entry) => ({
      label: t(entry.labelKey),
      icon: entry.icon,
      separated: entry.separated,
      onClick: () => {
        void createHost(`${t("remote.newHostName")} ${entry.suffix}`, group, entry.spec()).then(
          (row) => row && openDetails(row.id, entry.tab),
        );
      },
    }));
}
