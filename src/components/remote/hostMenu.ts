import {
  Copy,
  FolderOpen,
  Inbox,
  Monitor,
  MonitorSmartphone,
  Pencil,
  Settings2,
  Table2,
  Terminal,
  Trash2,
  Unplug,
  Waypoints,
  type LucideIcon,
} from "lucide-react";
import type { MenuItem } from "../api/CollectionTree";
import { kindIcon } from "./remoteChrome";
import { disconnectHost, useRemoteStore, type RemoteDetailsTab } from "../../state/remoteStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  capabilities,
  defaultHostSpec,
  hasAddress,
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
  const openQueues = useRemoteStore((s) => s.openQueues);
  const openTables = useRemoteStore((s) => s.openTables);
  const openDetails = useRemoteStore((s) => s.openDetails);
  const duplicateHost = useRemoteStore((s) => s.duplicateHost);
  const deleteHost = useRemoteStore((s) => s.deleteHost);
  const tabs = useRemoteStore((s) => s.tabs);
  const forwards = useRemoteStore((s) => s.forwards);
  const t = useT();

  return (host: RemoteHostRow, options: { onRename?: () => void } = {}): MenuItem[] => {
    const spec = parseHostSpec(host);
    // What this host *can* do, by kind. An FTP host has files and nothing else, a jailed SFTP
    // account has no shell, and a screen host has neither — so the menu doesn't offer any of them.
    // The backend refuses each independently; this is what keeps the user from ever meeting that
    // refusal.
    const can = capabilities(spec);
    const incomplete = !hasAddress(spec);
    const live =
      tabs.some((tab) => tab.kind === "session" && tab.hostId === host.id && !tab.exited) ||
      forwards.some((forward) => forward.host_id === host.id);

    // A host with no address can do none of it, and the useful response is not an error saying so —
    // it is the editor, open, on the field that is missing.
    const act = (run: () => void) => () => (incomplete ? openDetails(host.id) : run());

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
      ...(can.files
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
      // Neither is a file, so neither is in the capability table's `files` column — each is its own
      // one-action kind, and that action is the only thing the row can do.
      ...(spec.kind === "azure_queue"
        ? [{ label: t("remote.queues"), icon: Inbox, onClick: act(() => openQueues(host.id)) }]
        : []),
      ...(spec.kind === "azure_table"
        ? [{ label: t("remote.tables"), icon: Table2, onClick: act(() => openTables(host.id)) }]
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
      ...(live
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
  {
    id: "azure_blob",
    labelKey: "remote.newAzureBlob",
    icon: kindIcon("azure_blob"),
    suffix: "Blob",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "azure_blob" }),
  },
  {
    id: "azure_files",
    labelKey: "remote.newAzureFiles",
    icon: kindIcon("azure_files"),
    suffix: "Files",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "azure_files" }),
  },
  {
    id: "azure_queue",
    labelKey: "remote.newAzureQueue",
    icon: kindIcon("azure_queue"),
    suffix: "Queue",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "azure_queue" }),
  },
  {
    id: "azure_table",
    labelKey: "remote.newAzureTable",
    icon: kindIcon("azure_table"),
    suffix: "Table",
    tab: "connection",
    spec: () => ({ ...defaultHostSpec(), kind: "azure_table" }),
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
