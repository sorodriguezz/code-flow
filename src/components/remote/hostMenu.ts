import {
  Copy,
  FolderOpen,
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
  const openDetails = useRemoteStore((s) => s.openDetails);
  const duplicateHost = useRemoteStore((s) => s.duplicateHost);
  const deleteHost = useRemoteStore((s) => s.deleteHost);
  const tabs = useRemoteStore((s) => s.tabs);
  const forwards = useRemoteStore((s) => s.forwards);
  const t = useT();

  return (host: RemoteHostRow, options: { onRename?: () => void } = {}): MenuItem[] => {
    const spec = parseHostSpec(host);
    // What this host *can* do, by kind. An FTP host has files and nothing else, and a jailed SFTP
    // account has no shell — so the menu doesn't offer either. The backend refuses the same three
    // independently; this is what keeps the user from ever meeting that refusal.
    const can = capabilities(spec);
    const hasScreen = can.screen && spec.screen.protocol !== "none";
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
      { label: t("remote.files"), icon: FolderOpen, onClick: act(() => openSftp(host.id)) },
      ...(can.forwards
        ? [
            {
              label: t("remote.portForwards"),
              icon: Waypoints,
              onClick: act(() => openForwards(host.id)),
            },
          ]
        : []),
      ...(hasScreen
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
 * set up — a screen has a protocol and a viewer and no shell to speak of, an FTP host has no
 * `~/.ssh/config` behind it, and SSH is the only one of the three that has all of it — and picking
 * the family *first* is what lets the editor open on the page that matters and with the fields that
 * don't apply already gone.
 *
 * Each entry is a whole spec rather than a `kind` patch, because "remote desktop" is not a kind:
 * `RemoteKind` has no screen member, and a screen host is an SSH row whose `screen.protocol` is
 * set. That is the data model (see `types/remote`), and this menu is where the user meets it.
 */
export interface NewConnection {
  id: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
  /** Tacked onto the default name, so four fresh rows don't all read "New host". */
  suffix: string;
  /** A hairline above this entry — what separates the three families. */
  separated?: boolean;
  /** Which page of the editor to open on: the field that defines this kind isn't always on
   *  Connection. */
  tab: RemoteDetailsTab;
  spec: () => RemoteHostSpec;
}

export const NEW_CONNECTIONS: NewConnection[] = [
  {
    id: "vnc",
    labelKey: "remote.newScreenVnc",
    icon: Monitor,
    suffix: "VNC",
    tab: "screen",
    spec: () => {
      const base = defaultHostSpec();
      return { ...base, screen: { ...base.screen, protocol: "vnc", embedded: true } };
    },
  },
  {
    id: "rdp",
    labelKey: "remote.newScreenRdp",
    icon: MonitorSmartphone,
    suffix: "RDP",
    tab: "screen",
    spec: () => {
      const base = defaultHostSpec();
      // Windows by default — RDP is that machine, and it is the OS glyph the row will draw. Nothing
      // stops the user changing it; it is a default, not a rule.
      return { ...base, os: "windows", screen: { ...base.screen, protocol: "rdp" } };
    },
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
