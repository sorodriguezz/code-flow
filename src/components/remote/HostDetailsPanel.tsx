import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Eye,
  Loader2,
  EyeOff,
  FolderPlus,
  Monitor,
  Plus,
  Server,
  Terminal,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { Field, Row } from "../api/ApiModal";
import { ResizeHandle } from "../common/ResizeHandle";
import { ForwardDiagram } from "./ForwardDiagram";
import { Select } from "../common/Select";
import { Checkbox } from "../common/Checkbox";
import { CARD, HOST_COLORS, KindGlyph, OsGlyph, Pill, kindIcon } from "./remoteChrome";
import { useOpenPrimary } from "./hostMenu";
import { useRemoteStore, type RemoteDetailsTab } from "../../state/remoteStore";
import { useLayoutStore } from "../../state/layoutStore";
import {
  remoteGetPassword,
  remoteListKeys,
  remoteParseAzureConnection,
  remoteSetPassword,
} from "../../lib/tauri/remoteCommands";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  KIND_LABEL,
  azureEndpoint,
  capabilities,
  defaultPortFor,
  isAzureKind,
  isCloudKind,
  describeForward,
  effectivePort,
  hasAddress,
  kindOptions,
  parseHostSpec,
  type ForwardKind,
  type ForwardSpec,
  type RemoteAuth,
  type RemoteHostRow,
  type RemoteHostSpec,
  type RemoteKind,
  type AzureAuth,
  type ParsedAzureConnection,
  type RemoteOs,
  type S3Auth,
  type SshKey,
} from "../../types/remote";

/** Owned by the store, because the caller that opens the panel is what knows which page to land on
 *  — see `RemoteDetailsTab`. */
type Tab = RemoteDetailsTab;

/**
 * The host editor, as a persistent right-hand panel.
 *
 * **Why a drawer and not a modal.** A modal is a question with an answer: you open it, decide, and
 * it goes away. Host settings are not that — you fill in an address, connect, watch it fail, change
 * the port, connect again. A modal makes every one of those a round trip through open/save/close,
 * and it covers the tree you are comparing against. The panel stays, the session stays visible
 * beside it, and Connect sits at the bottom where the loop closes.
 *
 * **Which means it has to save itself.** A persistent panel has no "OK" moment, so an explicit Save
 * would eventually be the thing someone forgets before clicking another host. Edits are written
 * after a short pause, and any pending write is flushed the instant the panel switches host or
 * closes — see `flush`.
 *
 * Four tabs, split by what a host *is* rather than by how many fields fit: Connection is the `ssh`
 * destination, Forwards is what rides on it, Screen is a different endpoint that happens to live on
 * the same machine, and Advanced is the escape hatch for everything this form doesn't model.
 *
 * **Almost every field may be left empty, and that is the design.** An empty user, port or key is
 * not a missing value — it is a deliberate deferral to `~/.ssh/config`, which `ssh` reads and this
 * app does not. A form that helpfully filled in `22` and the local username would silently override
 * a working config, so the placeholders say what will happen instead.
 */
const SAVE_DEBOUNCE_MS = 600;
/** Longer: every write here is an OS keychain call, and on an ad-hoc-signed build possibly a
 *  prompt. Typing a password should cost one write, not one per character. */
const PASSWORD_DEBOUNCE_MS = 1500;

const WIDTH_MIN = 280;
const WIDTH_MAX = 560;

export function HostDetailsPanel() {
  const hostId = useRemoteStore((s) => s.detailsHostId);
  const requestedTab = useRemoteStore((s) => s.detailsTab);
  const host = useRemoteStore((s) => s.hosts.find((entry) => entry.id === hostId) ?? null);
  const saveHost = useRemoteStore((s) => s.saveHost);
  const closeDetails = useRemoteStore((s) => s.closeDetails);
  const width = useLayoutStore((s) => s.sizes.remoteDetailsWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const t = useT();

  const openPrimary = useOpenPrimary();
  const checkCloud = useRemoteStore((s) => s.checkCloud);
  const cloudStatus = useRemoteStore((s) => (hostId ? s.cloudStatus[hostId] : undefined));
  const closeTab = useRemoteStore((s) => s.closeTab);
  /**
   * This host's live connections — what "connected" is allowed to mean here.
   *
   * Only three of the seven tab kinds hold anything open. A `session` is a pty and stops being live
   * the moment it reports `exited`; a `screen` owns the SSH tunnel under the viewer window, which
   * is why closing it closes that tunnel; an `sftp` tab is an `ssh -s … sftp` child kept alive for
   * the pair of file panes. The rest are views: `forwards` lists forwards without being one,
   * `azure` talks to an HTTP API per request, and `log` and `all-forwards` belong to no host at
   * all — counting any of them would light up "Disconnect" for a panel that has nothing to close.
   *
   * Derived with `useMemo` from the whole list rather than filtered inside the selector: a selector
   * that builds an array returns a new reference every time *any* part of the store moves, and
   * under `useSyncExternalStore` that is a re-render on every keystroke in the workspace.
   */
  const tabs = useRemoteStore((s) => s.tabs);
  const liveTabs = useMemo(
    () =>
      tabs.filter(
        (entry) =>
          entry.hostId === hostId &&
          (entry.kind === "screen" ||
            entry.kind === "sftp" ||
            (entry.kind === "session" && !entry.exited)),
      ),
    [tabs, hostId],
  );
  /**
   * Whether the button says Connect or Disconnect.
   *
   * No cloud check is needed and none is written: a storage account only ever opens an `azure` tab,
   * which the filter above already excludes, so a cloud row can never reach a non-empty list. That
   * falls out of what a live connection *is* rather than out of a second rule that could drift away
   * from the first one.
   */
  const connected = liveTabs.length > 0;

  const [tab, setTab] = useState<Tab>("connection");
  const [spec, setSpec] = useState<RemoteHostSpec | null>(null);
  const [name, setName] = useState("");
  const [group, setGroup] = useState("");
  const [color, setColor] = useState("");
  const [password, setPassword] = useState("");
  const [passwordLoaded, setPasswordLoaded] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  /** What a flush would write. A ref so the flush on unmount sees the last edit rather than the
   *  values captured when the effect was set up. */
  const latest = useRef<{ row: RemoteHostRow; spec: RemoteHostSpec } | null>(null);
  const dirty = useRef(false);
  const passwordDirty = useRef(false);

  /**
   * Which of the three row fields the *user* has touched since the last write.
   *
   * **The panel does not own the row — it owns the edits.** Name, group and colour are all editable
   * from outside this panel as well: F2 in the tree renames, dragging onto a folder regroups,
   * renaming or deleting a folder rewrites `group_name` on every host in it, and the row's context
   * menu sets the colour. The panel loads those three into local state exactly once, so the moment
   * any of that happens the boxes here hold values that are no longer true — and the next edit to
   * *anything*, a checkbox on the Advanced page included, wrote all three back. A host renamed in
   * the tree and dragged into a folder would silently take its old name and jump back out of the
   * folder as soon as you changed its port.
   *
   * So a write carries a field only if this panel is what changed it. Everything else is taken from
   * the row as it stands, which is the value the rest of the app just set.
   */
  const touched = useRef({ name: false, group: false, color: false });

  /**
   * The row's three values as this panel last saw them — which is not the same as what it last
   * *showed*.
   *
   * It is what lets "the tree renamed this host" be told apart from "our own write came back". Both
   * arrive as a changed `host` object, and only the first should pull the value into the boxes: a
   * name field the user has just emptied in order to retype must not refill itself half a second
   * later with the name the row still carries.
   */
  const seen = useRef({ name: "", group: "", color: "" });

  /** What the three boxes hold right now, for the callbacks that run an IPC round trip later. */
  const live = useRef({ name: "", group: "", color: "" });
  live.current = { name, group, color };

  /** Adopts a row as the baseline, and hands ownership of all three fields back to it. Used when a
   *  host is loaded, where there are by definition no edits to protect. */
  const adopt = (from: RemoteHostRow) => {
    seen.current = { name: from.name, group: from.group_name, color: from.color };
    touched.current = { name: false, group: false, color: false };
  };

  /**
   * A write landed. Records what is now on the row, and hands back only the fields it settled.
   *
   * Both halves matter, and both are about the round trip in the middle.
   *
   * **A field the user has kept typing into is still theirs.** Type "prod-", let the debounce fire,
   * add a "1" while the request is in the air: releasing `name` when the answer comes back would
   * make the very next render rebuild the row from `host` — reverting the box's own value to
   * "prod-" and losing the character for good, since nothing would ever write it again.
   *
   * **And a write for another host settles nothing here.** By the time a save for host A resolves
   * the panel may be showing host B, whose load has already set both of these; writing A's values
   * over them leaves `seen` describing a row that isn't on screen, and the next external change to
   * B would then read as "somebody renamed this" and wipe what is being typed into it.
   */
  const settled = (row: RemoteHostRow) => {
    if (loadedId.current !== row.id) return;
    seen.current = { name: row.name, group: row.group_name, color: row.color };
    // `|| row.name` mirrors how the row is built: an emptied Name box writes the existing name, so
    // an empty box after that write is settled, not pending.
    if ((live.current.name.trim() || row.name) === row.name) touched.current.name = false;
    if (live.current.group.trim() === row.group_name) touched.current.group = false;
    if (live.current.color === row.color) touched.current.color = false;
  };

  const flush = () => {
    const pending = latest.current;
    if (dirty.current && pending) {
      dirty.current = false;
      void saveHost(pending.row, pending.spec).then((ok) => {
        // Only on success: a write that failed still has an edit in it, and forgetting which field
        // it was would drop it from the retry.
        if (ok) settled(pending.row);
      });
    }
    if (passwordDirty.current && pending) {
      passwordDirty.current = false;
      void remoteSetPassword(pending.row.id, passwordRef.current).catch((error) =>
        pushErrorToast(String(error)),
      );
    }
  };
  const passwordRef = useRef("");
  passwordRef.current = password;

  // Switching host: write out whatever the last one had pending *before* adopting the new one, or
  // the edit would be lost to a debounce that never fired.
  const loadedId = useRef<string | null>(null);
  useEffect(() => {
    if (!host || loadedId.current === host.id) return;
    if (loadedId.current !== null) flush();
    loadedId.current = host.id;
    dirty.current = false;
    passwordDirty.current = false;
    adopt(host);
    setSpec(parseHostSpec(host));
    setName(host.name);
    setGroup(host.group_name);
    setColor(host.color);
    setPassword("");
    setPasswordLoaded(false);
    setTab("connection");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.id]);

  // The other half of `touched`: when somebody *else* changes one of the three, the box follows and
  // this panel stops claiming it. Without this the panel would keep showing the stale name it no
  // longer writes, which is the same lie one screen earlier.
  //
  // Gated on the value having moved away from `seen` rather than on the object changing, because
  // the object changes on our own save too — and re-adopting there would undo an edit still being
  // typed.
  useEffect(() => {
    if (!host || loadedId.current !== host.id) return;
    if (host.name !== seen.current.name) {
      seen.current.name = host.name;
      touched.current.name = false;
      setName(host.name);
    }
    if (host.group_name !== seen.current.group) {
      seen.current.group = host.group_name;
      touched.current.group = false;
      setGroup(host.group_name);
    }
    if (host.color !== seen.current.color) {
      seen.current.color = host.color;
      touched.current.color = false;
      setColor(host.color);
    }
  }, [host, host?.name, host?.group_name, host?.color]);

  // After the effect above, and that ordering is the whole point: adopting a host resets the panel
  // to Connection, so a caller that asked for a page — the (+)'s VNC entry wants Screen — has to
  // get the last word. Effects run in declaration order, so this one does.
  useEffect(() => {
    if (requestedTab) setTab(requestedTab);
  }, [requestedTab, hostId]);

  // Flush on the way out — closing the panel is the other way an edit can be left in the air.
  useEffect(() => () => flush(), []);

  // The stored credential is read once, on open, rather than with the row: it is a keychain hit
  // (and on an ad-hoc-signed build, possibly an OS prompt), and paying that to render a tree of
  // twenty hosts would be twenty prompts for a value nineteen of them don't show.
  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    void remoteGetPassword(host.id)
      .then((value) => {
        if (!cancelled) {
          setPassword(value ?? "");
          setPasswordLoaded(true);
        }
      })
      .catch(() => setPasswordLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [host?.id]);

  const row: RemoteHostRow | null = host
    ? {
        ...host,
        // Only what this panel changed — see `touched`.
        name: touched.current.name ? name.trim() || host.name : host.name,
        group_name: touched.current.group ? group.trim() : host.group_name,
        color: touched.current.color ? color : host.color,
      }
    : null;
  // Only while the panel is still *showing* the host it loaded. On the render where `detailsHostId`
  // moves to another host, `host` is already the new one while `name`/`group`/`spec` are still the
  // old one's — and the very next effect calls `flush()`. Latching that render would write host A's
  // edits onto host B's row, which is the same clobber one level up.
  if (row && spec && host && loadedId.current === host.id) latest.current = { row, spec };

  useEffect(() => {
    if (!dirty.current || !row || !spec) return;
    const timer = window.setTimeout(() => {
      // Read at fire time rather than from the closure: 600ms is long enough for the tree to have
      // regrouped or recoloured this host, and the row captured when the timer was set would put
      // that back the way it was.
      // Re-checked at fire time as well: `flush()` disarms nothing, so a Connect or a host switch
      // inside the window would otherwise write the same edit a second time.
      const pending = latest.current;
      if (!pending || !dirty.current) return;
      dirty.current = false;
      void saveHost(pending.row, pending.spec).then((ok) => {
        if (ok) settled(pending.row);
      });
    }, SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, name, group, color]);

  useEffect(() => {
    if (!passwordDirty.current || !host) return;
    const timer = window.setTimeout(() => {
      passwordDirty.current = false;
      void remoteSetPassword(host.id, password).catch((error) => pushErrorToast(String(error)));
    }, PASSWORD_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [password]);

  // Changing kind can pull the open tab out from under the panel — a host switched from SSH to FTP
  // while Forwards is showing would otherwise render a tab that is no longer in the bar.
  //
  // Above the early return, and deliberately: `spec` is null for the render between opening a host
  // and the effect that parses it, so a hook placed after `return null` is skipped on that render
  // and called on the next one — which is exactly the hook-order change React refuses to accept.
  useEffect(() => {
    if (!spec) return;
    const can = capabilities(spec);
    setTab((current) =>
      (current === "forwards" && !can.forwards) || (current === "screen" && !can.screen)
        ? "connection"
        : current,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec?.kind]);

  if (!host || !spec) return null;

  const patch = (changes: Partial<RemoteHostSpec>) => {
    dirty.current = true;
    setSpec({ ...spec, ...changes });
  };
  /** An edit to one of the three fields the row carries directly. Marks it as this panel's, so the
   *  next write includes it and the resync above stops overwriting it. */
  const editRow =
    (field: "name" | "group" | "color", setter: (value: string) => void) => (value: string) => {
      dirty.current = true;
      touched.current[field] = true;
      setter(value);
    };

  // Forwards and Screen are SSH-only, so an FTP host shows two tabs rather than four. Hidden
  // rather than disabled: a disabled tab is a promise that filling something in will enable it,
  // and nothing about this host ever will — see `KIND_CAPABILITIES`.
  const can = capabilities(spec);
  const TABS: { id: Tab; label: string; icon: typeof Server }[] = [
    { id: "connection", label: t("remote.tabConnection"), icon: Server },
    ...(can.forwards
      ? [{ id: "forwards" as Tab, label: t("remote.tabForwards"), icon: Waypoints }]
      : []),
    ...(can.screen ? [{ id: "screen" as Tab, label: t("remote.tabScreen"), icon: Monitor }] : []),
    { id: "advanced", label: t("remote.tabAdvanced"), icon: Terminal },
  ];

  return (
    <>
      {/* `invert`, because the handle sits to the *left* of what it resizes — dragging toward the
          panel has to grow it, not shrink it. */}
      <ResizeHandle
        axis="x"
        value={width}
        min={WIDTH_MIN}
        max={WIDTH_MAX}
        invert
        onChange={(value) => setSize("remoteDetailsWidth", value)}
        onCommit={(value) => void commitSize("remoteDetailsWidth", value)}
      />
      <div
        style={{ width }}
        className={`flex shrink-0 flex-col overflow-hidden border-l border-[var(--cf-border)] ${CARD}`}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3 py-2">
          <OsGlyph os={spec.os} size={14} />
          <KindGlyph kind={spec.kind} size={14} />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--cf-text)]">
            {name || host.name}
          </span>
          <button
            type="button"
            onClick={closeDetails}
            aria-label={t("common.close")}
            className="shrink-0 rounded p-0.5 text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
          >
            <X size={13} />
          </button>
        </div>

        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-[var(--cf-border)] px-1">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-current={tab === id ? "page" : undefined}
              title={label}
              className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2 text-[12px] font-medium transition-colors ${
                tab === id
                  ? "border-[var(--cf-accent)] text-[var(--cf-accent)]"
                  : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {tab === "connection" && (
            <ConnectionTab
              name={name}
              group={group}
              color={color}
              spec={spec}
              password={password}
              showPassword={showPassword}
              onName={editRow("name", setName)}
              onGroup={editRow("group", setGroup)}
              onColor={editRow("color", setColor)}
              onPatch={patch}
              onPassword={(value) => {
                passwordDirty.current = true;
                setPassword(value);
              }}
              onToggleShowPassword={() => setShowPassword((value) => !value)}
            />
          )}
          {tab === "forwards" && <ForwardsTab spec={spec} onPatch={patch} />}
          {tab === "screen" && <ScreenTab spec={spec} onPatch={patch} />}
          {tab === "advanced" && <AdvancedTab spec={spec} onPatch={patch} />}
        </div>

        {/* Pinned, and the reason the panel beats the modal: the fill-in / connect / fix loop never
            leaves this column. */}
        <div className="shrink-0 border-t border-[var(--cf-border)] p-2">
          {/* The one action a host has, whatever it is: a shell if it has one, a screen if that is
              what it is, files otherwise — every kind matches exactly one, in that order, same as
              double-clicking the row. It reads "Connect" in all three cases, because that is what
              the click *does*: this is the panel's primary action, and a bare noun in that slot
              reads as the name of a place rather than something that happens when pressed. What
              opens is decided by the kind, and the kind is named a few rows up. */}
          <button
            type="button"
            onClick={() => {
              // Connected and closable: this press is the other half of the toggle. Nothing is
              // flushed and nothing is opened — disconnecting is about the sessions that are
              // already running, not about the form's unsaved edits.
              if (connected) {
                void Promise.all(liveTabs.map((entry) => closeTab(entry.id)));
                return;
              }
              // Flushed first, and that ordering is the point: what opens has to be what is on
              // screen, not what the debounce had got round to saving. A cloud account is read from
              // the row by the backend, so an unsaved key would connect as the old one.
              flush();
              if (!isCloudKind(spec.kind)) return openPrimary(host, spec);
              // A cloud account has no session to open, so pressing this used to open a panel and
              // look like nothing happened. It asks the account first, says which it was, and only
              // opens on success — a panel that would show the same failure in smaller type is not
              // a useful place to be sent.
              void checkCloud(host.id).then((ok) => ok && openPrimary(host, spec));
            }}
            // Disconnect needs no address: the sessions it closes are already open, and a host
            // whose address was blanked out while a shell ran would otherwise offer a dead button
            // over a live connection.
            disabled={(!connected && !hasAddress(spec)) || cloudStatus?.checking}
            className={`flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-opacity disabled:opacity-40 ${
              connected
                ? "border border-[var(--cf-border)] text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                : "bg-[var(--cf-accent)] text-white hover:brightness-110"
            }`}
          >
            {cloudStatus?.checking && <Loader2 size={13} className="animate-spin" />}
            {/* Named for what is missing rather than for a field this kind hasn't got: a storage
                account reading "no address" was a button pointing at a box that does not exist. */}
            {connected
              ? liveTabs.length > 1
                ? t("remote.disconnectN", { n: String(liveTabs.length) })
                : t("remote.disconnect")
              : !hasAddress(spec)
                ? t(isCloudKind(spec.kind) ? "remote.needsAccount" : "remote.needsAddress")
                : cloudStatus?.checking
                  ? t("remote.connecting")
                  : t("remote.connect")}
          </button>

          {/* Opening *another* one, offered only while the primary button is busy saying
              "Disconnect".

              A host is not a thing you are either connected to or not — it holds as many shells,
              file panes and screens as you open, which is why the tab list is per host and not per
              connection. So the toggle the primary button now performs would, on its own, have
              taken away the way to open a second shell from the panel you configure the host in.
              This is that way back, and it stays out of the layout entirely when there is nothing
              to disambiguate. */}
          {connected && (
            <button
              type="button"
              onClick={() => {
                flush();
                openPrimary(host, spec);
              }}
              disabled={!hasAddress(spec)}
              className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1 text-[11px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)] disabled:opacity-40"
            >
              <Plus size={12} />
              {t("remote.connectAnother")}
            </button>
          )}

          {/* What the account said, kept under the button until the next attempt. The green line is
              not decoration: an account with no containers opens an empty panel, and "connected, 0
              containers" is the difference between that and a key that was rejected. */}
          {isCloudKind(spec.kind) && cloudStatus && !cloudStatus.checking && (
            <p
              className={`pt-1.5 text-[11px] leading-relaxed ${
                cloudStatus.ok ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"
              }`}
            >
              {cloudStatus.ok
                ? t(spec.kind === "s3" ? "remote.cloudOkS3" : "remote.cloudOk", {
                    n: String(cloudStatus.count),
                  })
                : cloudStatus.error}
            </p>
          )}

          {passwordLoaded && spec.auth === "password" && (
            <p className="pt-1.5 text-center text-[10px] text-[var(--cf-text-muted)]">
              {t("remote.authPasswordHint")}
            </p>
          )}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function ConnectionTab({
  name,
  group,
  color,
  spec,
  password,
  showPassword,
  onName,
  onGroup,
  onColor,
  onPatch,
  onPassword,
  onToggleShowPassword,
}: {
  name: string;
  group: string;
  color: string;
  spec: RemoteHostSpec;
  password: string;
  showPassword: boolean;
  onName: (value: string) => void;
  onGroup: (value: string) => void;
  onColor: (value: string) => void;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
  onPassword: (value: string) => void;
  onToggleShowPassword: () => void;
}) {
  // Selected raw and derived with `useMemo`, never derived *inside* the selector. A zustand
  // selector runs on every store read and is compared by reference, so one that builds a fresh
  // array each time never equals the last — the component re-renders, which re-runs the selector,
  // which returns another new array. React calls that out as "getSnapshot should be cached" and
  // then kills it with "Maximum update depth exceeded".
  const hosts = useRemoteStore((s) => s.hosts);
  // Both halves, and the second one is not optional: a group is a *folder row* plus whichever hosts
  // name it, and those are two different facts. Built from the hosts alone, a group created here
  // and then left — pick another group, and it has no members — vanished from this list while its
  // folder was still sitting in the tree, so the only way back into it was dragging the host onto
  // the folder. `groupHosts` in the tree has always merged the two; this had not.
  const folders = useRemoteStore((s) => s.groups);
  const groups = useMemo(
    () =>
      [
        ...new Set(
          [
            ...folders.map((folder) => folder.name.trim()),
            ...hosts.map((host) => host.group_name.trim()),
          ].filter(Boolean),
        ),
      ].sort(),
    [folders, hosts],
  );
  const t = useT();

  const AUTH: { value: RemoteAuth; label: string; hint: string }[] = [
    { value: "agent", label: t("remote.authAgent"), hint: t("remote.authAgentHint") },
    { value: "key", label: t("remote.authKey"), hint: t("remote.authKeyHint") },
    { value: "password", label: t("remote.authPassword"), hint: t("remote.authPasswordHint") },
  ];

  // Four families of fields, and every kind is in exactly one. SSH and SFTP share a transport and
  // therefore share every flag below; FTP and FTPS share none of them; a screen has neither an
  // authentication scheme this app can carry nor a filesystem to configure — what it has is an
  // address, and a way to reach it. A cloud account has no address at all: it has an account name
  // and a credential, and everything from Host downwards is replaced rather than hidden.
  const isSsh = spec.kind === "ssh" || spec.kind === "sftp";
  const isFtp = spec.kind === "ftp" || spec.kind === "ftps";
  const isScreen = capabilities(spec).screen;
  const isCloud = isCloudKind(spec.kind);

  /** One line under the type selector saying what picking it means — the set reads as one. */
  const KIND_HINT: Record<RemoteKind, string> = {
    ssh: t("remote.kindSshHint"),
    sftp: t("remote.kindSftpHint"),
    ftp: t("remote.kindFtpHint"),
    ftps: t("remote.kindFtpsHint"),
    vnc: t("remote.kindVncHint"),
    rdp: t("remote.kindRdpHint"),
    s3: t("remote.kindS3Hint"),
    azure: t("remote.kindAzureHint"),
    azure_blob: t("remote.kindAzureBlobHint"),
    azure_files: t("remote.kindAzureFilesHint"),
    azure_queue: t("remote.kindAzureQueueHint"),
    azure_table: t("remote.kindAzureTableHint"),
  };

  const OS: { value: RemoteOs; label: string }[] = [
    { value: "linux", label: "Linux" },
    { value: "macos", label: "macOS" },
    { value: "windows", label: "Windows" },
    { value: "other", label: t("remote.osOther") },
  ];

  return (
    <div className="space-y-1">
      <Row label={t("remote.fieldName")}>
        <Field value={name} onChange={onName} />
      </Row>

      {/* First, and above the address: it decides what every field below means — and which of them
          exist at all. */}
      <Row label={t("remote.kind")} hint={KIND_HINT[spec.kind]}>
        <Select
          value={spec.kind}
          onChange={(value) => onPatch({ kind: value as RemoteKind })}
          size="field"
          options={kindOptions(spec.kind).map((kind) => ({
            value: kind,
            label: KIND_LABEL[kind],
            icon: kindIcon(kind),
          }))}
        />
      </Row>

      <GroupPicker group={group} groups={groups} onGroup={onGroup} />

      {/* A cloud account replaces the whole address-and-credential block below, rather than hiding
          field by field: there is no host, no port and no `ssh`, and what takes their place —
          a profile, a bucket region, an account name — has nothing in common with them. */}
      {isCloud && spec.kind === "s3" && (
        <S3Settings
          spec={spec}
          password={password}
          showPassword={showPassword}
          onPatch={onPatch}
          onPassword={onPassword}
          onToggleShowPassword={onToggleShowPassword}
        />
      )}
      {isCloud && isAzureKind(spec.kind) && (
        <AzureSettings
          spec={spec}
          password={password}
          showPassword={showPassword}
          onPatch={onPatch}
          onPassword={onPassword}
          onToggleShowPassword={onToggleShowPassword}
        />
      )}

      {!isCloud && (
        <>
      {/* On a screen row this address is the *screen's* — there is no second one hidden on the
          Screen page for it to disagree with. Which is also why the hint changes: a `~/.ssh/config`
          alias means nothing to a VNC viewer. */}
      <Row
        label={t("remote.fieldHost")}
        hint={isScreen ? t("remote.fieldHostScreenHint") : t("remote.fieldHostHint")}
        wide
      >
        <Field value={spec.host} onChange={(host) => onPatch({ host })} mono placeholder="web-01.example.com" />
      </Row>
      <Row label={t("remote.fieldPort")}>
        {/* The placeholder tracks the kind — 22, 21, 990, 5900 or 3389 — because an empty port means
            "the usual one for this protocol", and a hard-coded 22 under an FTP host would name the
            wrong one. */}
        <Field
          type="number"
          value={spec.port === 0 ? "" : String(spec.port)}
          onChange={(value) => onPatch({ port: Number(value) || 0 })}
          placeholder={String(defaultPortFor(spec))}
        />
      </Row>
      <Row
        label={t("remote.fieldUser")}
        hint={isScreen ? t("remote.fieldUserScreenHint") : t("remote.fieldUserHint")}
      >
        <Field value={spec.user} onChange={(user) => onPatch({ user })} mono placeholder="—" />
      </Row>

      {/* The whole authentication block is SSH's. FTP has exactly one scheme — a username and a
          password on the wire — so offering it "agent" or "key" would be offering it settings the
          protocol cannot carry. Its password field is rendered unconditionally below instead. */}
      {isSsh && (
        <Row label={t("remote.fieldAuth")} hint={AUTH.find((a) => a.value === spec.auth)?.hint}>
          <Select
            value={spec.auth}
            onChange={(value) => onPatch({ auth: value as RemoteAuth })}
            options={AUTH.map(({ value, label }) => ({ value, label }))}
          />
        </Row>
      )}

      {isSsh && spec.auth === "key" && <KeyPicker spec={spec} onPatch={onPatch} />}

      {/* A screen has no password field, and that is not an omission: nothing here would use it.
          The viewer asks for the VNC password or the Windows credentials itself, in its own window,
          and a field that quietly stored one in the keychain for nobody to read would be worse than
          no field at all. */}
      {((isSsh && spec.auth === "password") || (isFtp && !spec.ftp.anonymous)) && (
        <Row label={t("remote.fieldPassword")} hint={t("remote.fieldPasswordHint")} wide>
          <div className="flex w-full items-center gap-1">
            <Field
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={onPassword}
              mono
            />
            <button
              type="button"
              onClick={onToggleShowPassword}
              aria-label={showPassword ? t("remote.hide") : t("remote.show")}
              className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
            </button>
          </div>
        </Row>
      )}

      {/* `ProxyJump` has no FTP equivalent — there is no config file on the other side to read it —
          but a *screen* keeps it, and it is the one SSH flag that survives the split: the tunnel a
          screen raises is an `ssh`, and reaching a machine through a bastion is exactly what this
          field says. Agent forwarding stays behind, since nothing on the far side of a screen
          tunnel would use the socket. */}
      {(isSsh || isScreen) && (
        <Row
          label={t("remote.fieldJump")}
          hint={isScreen ? t("remote.fieldJumpScreenHint") : t("remote.fieldJumpHint")}
          wide
        >
          <Field value={spec.jump} onChange={(jump) => onPatch({ jump })} mono placeholder="bastion.example.com" />
        </Row>
      )}

      {isSsh && (
        <>
          <label className="flex items-start gap-2 py-1">
            <Checkbox
              checked={spec.agent_forward}
              onChange={(agent_forward) => onPatch({ agent_forward })}
              className="mt-px"
            />
            <span className="min-w-0">
              <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.fieldAgentForward")}</span>
              <span className="block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
                {t("remote.fieldAgentForwardHint")}
              </span>
            </span>
          </label>
        </>
      )}

      {isFtp && <FtpSettings spec={spec} onPatch={onPatch} />}
        </>
      )}

      <Row label={t("remote.fieldTags")} hint={t("remote.fieldTagsHint")} wide>
        {/* Edited as text rather than as chips: a comma-separated line is faster to retype than a
            chip editor is to click through, and it is what the user would have written anyway. The
            chips are how tags are *read* — on the cards and in the filter row. */}
        <TagsField tags={spec.tags} onChange={(tags) => onPatch({ tags })} />
      </Row>

      <Row label={t("remote.fieldOs")} hint={t("remote.fieldOsHint")}>
        <Select
          value={spec.os}
          onChange={(value) => onPatch({ os: value as RemoteOs })}
          options={OS.map(({ value, label }) => ({ value, label }))}
        />
      </Row>

      <ColorPicker color={color} onColor={onColor} />
    </div>
  );
}

/**
 * The group field, as a real select over the groups that exist plus a way to make one.
 *
 * It used to be an `<input list>` with a `<datalist>`, which is why it looked like a browser
 * tooltip rather than part of the app: a datalist popup is drawn by the platform, so it ignores the
 * theme, the accent colour and every other menu in this window. `Select` is the app's own element
 * list, already used by every other dropdown here.
 *
 * The one thing the old control did better was let you *type a new name*, and a plain select
 * cannot. So "New group…" is an option: picking it swaps the trigger for a text field, and
 * committing creates the group and moves the host into it in one step.
 */
function GroupPicker({
  group,
  groups,
  onGroup,
}: {
  group: string;
  groups: string[];
  onGroup: (value: string) => void;
}) {
  const createGroup = useRemoteStore((s) => s.createGroup);
  const [creating, setCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const t = useT();

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const commit = (value: string) => {
    const name = value.trim();
    setCreating(false);
    if (!name) return;
    // Both, and in this order: the folder row is what makes the group survive being emptied, and
    // the host's own field is what puts it in there.
    void createGroup(name);
    onGroup(name);
  };

  // A group named on this host but with no row of its own — an import, or a name typed before this
  // panel had a select — still has to appear, or the control would show a blank for a host that
  // plainly has a group.
  const options = [...new Set([...groups, group.trim()].filter(Boolean))].sort();

  return (
    <Row label={t("remote.fieldGroup")} hint={t("remote.fieldGroupHint")}>
      {creating ? (
        <input
          ref={inputRef}
          defaultValue=""
          placeholder={t("remote.newGroup")}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
            if (e.key === "Escape") setCreating(false);
          }}
          className="w-full rounded-md border border-[var(--cf-accent)] bg-transparent px-2 py-1.5 text-[12px] outline-none"
        />
      ) : (
        <Select
          value={group.trim()}
          onChange={(value) => (value === NEW_GROUP ? setCreating(true) : onGroup(value))}
          size="field"
          options={[
            { value: "", label: t("remote.ungrouped") },
            ...options.map((name) => ({ value: name, label: name })),
            { value: NEW_GROUP, label: `${t("remote.newGroup")}…`, icon: FolderPlus },
          ]}
        />
      )}
    </Row>
  );
}

/** The secret field the two cloud editors share — a password input with a reveal, over whichever
 *  credential this host keeps in the keychain. */
function SecretField({
  label,
  hint,
  password,
  showPassword,
  onPassword,
  onToggleShowPassword,
}: {
  label: string;
  hint: string;
  password: string;
  showPassword: boolean;
  onPassword: (value: string) => void;
  onToggleShowPassword: () => void;
}) {
  const t = useT();
  return (
    <Row label={label} hint={hint} wide>
      <div className="flex w-full items-center gap-1">
        <Field type={showPassword ? "text" : "password"} value={password} onChange={onPassword} mono />
        <button
          type="button"
          onClick={onToggleShowPassword}
          aria-label={showPassword ? t("remote.hide") : t("remote.show")}
          className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        >
          {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
        </button>
      </div>
    </Row>
  );
}

/**
 * The S3-only settings.
 *
 * **The profile is the default, and that is the point.** A named `~/.aws` profile is resolved by the
 * AWS CLI at the moment of use, so SSO, MFA, assumed roles and rotation all keep working and this
 * app stores no credential at all. The access-key path is there for a MinIO box or a machine
 * account — a real case, and the one where a secret does end up in the keychain.
 */
function S3Settings({
  spec,
  password,
  showPassword,
  onPatch,
  onPassword,
  onToggleShowPassword,
}: {
  spec: RemoteHostSpec;
  password: string;
  showPassword: boolean;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
  onPassword: (value: string) => void;
  onToggleShowPassword: () => void;
}) {
  const t = useT();
  const patchS3 = (changes: Partial<RemoteHostSpec["s3"]>) =>
    onPatch({ s3: { ...spec.s3, ...changes } });

  const AUTH: { value: S3Auth; label: string; hint: string }[] = [
    { value: "profile", label: t("remote.s3AuthProfile"), hint: t("remote.s3AuthProfileHint") },
    { value: "access_key", label: t("remote.s3AuthKey"), hint: t("remote.s3AuthKeyHint") },
  ];
  // A custom endpoint has no wildcard DNS in front of it, so path style is not a choice there. Shown
  // as forced rather than silently overridden, which would be a toggle that lies about its state.
  const custom = spec.s3.endpoint.trim() !== "";

  return (
    <>
      <Row label={t("remote.fieldAuth")} hint={AUTH.find((a) => a.value === spec.s3.auth)?.hint}>
        <Select
          value={spec.s3.auth}
          onChange={(value) => patchS3({ auth: value as S3Auth })}
          options={AUTH.map(({ value, label }) => ({ value, label }))}
        />
      </Row>

      {spec.s3.auth === "profile" ? (
        <Row label={t("remote.s3Profile")} hint={t("remote.s3ProfileHint")}>
          <Field value={spec.s3.profile} onChange={(profile) => patchS3({ profile })} mono placeholder="default" />
        </Row>
      ) : (
        <>
          <Row label={t("remote.s3AccessKeyId")} wide>
            <Field
              value={spec.s3.access_key_id}
              onChange={(access_key_id) => patchS3({ access_key_id })}
              mono
              placeholder="AKIA…"
            />
          </Row>
          <SecretField
            label={t("remote.s3SecretKey")}
            hint={t("remote.s3SecretKeyHint")}
            password={password}
            showPassword={showPassword}
            onPassword={onPassword}
            onToggleShowPassword={onToggleShowPassword}
          />
        </>
      )}

      <Row label={t("remote.s3Region")} hint={t("remote.s3RegionHint")}>
        <Field value={spec.s3.region} onChange={(region) => patchS3({ region })} mono placeholder="us-east-1" />
      </Row>
      <Row label={t("remote.s3Endpoint")} hint={t("remote.s3EndpointHint")} wide>
        <Field
          value={spec.s3.endpoint}
          onChange={(endpoint) => patchS3({ endpoint })}
          mono
          placeholder="https://minio.internal:9000"
        />
      </Row>

      <label className="flex items-start gap-2 py-1">
        <Checkbox
          checked={spec.s3.path_style || custom}
          onChange={(path_style) => patchS3({ path_style })}
          disabled={custom}
          className="mt-px"
        />
        <span className="min-w-0">
          <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.s3PathStyle")}</span>
          <span className="block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
            {custom ? t("remote.s3PathStyleForced") : t("remote.s3PathStyleHint")}
          </span>
        </span>
      </label>
    </>
  );
}

/**
 * The Azure-only settings.
 *
 * **The connection string comes first, because that is what people have.** Nobody is handed an
 * account name, a key, a suffix and an endpoint as four separate values — they are handed one line
 * off the portal's "Access keys" blade, or a SAS URL from a right-click on a container. Retyping
 * that into four fields is work the app can do, and doing it by hand is where a truncated key comes
 * from. The fields below stay, because a string is not the only way in (Entra ID has no string at
 * all) and because after pasting one you still want to *see* what it set.
 *
 * The rest is one account name and one of three credentials. The three are genuinely different
 * things rather than three spellings of "password" — a key signs every request, a SAS *is* the
 * signature and carries its own scope and expiry, and Entra is a token borrowed from `az login` —
 * so the field under the picker changes with the choice instead of staying a generic secret box.
 */
function AzureSettings({
  spec,
  password,
  showPassword,
  onPatch,
  onPassword,
  onToggleShowPassword,
}: {
  spec: RemoteHostSpec;
  password: string;
  showPassword: boolean;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
  onPassword: (value: string) => void;
  onToggleShowPassword: () => void;
}) {
  const t = useT();
  const patchAzure = (changes: Partial<RemoteHostSpec["azure"]>) =>
    onPatch({ azure: { ...spec.azure, ...changes } });

  const AUTH: { value: AzureAuth; label: string; hint: string }[] = [
    { value: "account_key", label: t("remote.azAuthKey"), hint: t("remote.azAuthKeyHint") },
    { value: "sas", label: t("remote.azAuthSas"), hint: t("remote.azAuthSasHint") },
    { value: "entra", label: t("remote.azAuthEntra"), hint: t("remote.azAuthEntraHint") },
  ];

  return (
    <>
      <ConnectionStringField
        onApply={(parsed) => {
          onPatch({ azure: { ...spec.azure, ...parsed.spec.azure } });
          // Straight to the keychain, by the same debounced path the field below writes on. The
          // key never touches the spec — that is what gets stored as JSON in the workspace.
          if (parsed.secret) onPassword(parsed.secret);
        }}
      />

      <Row label={t("remote.azAccount")} hint={t("remote.azAccountHint")} wide>
        <Field
          value={spec.azure.account}
          onChange={(account) => patchAzure({ account })}
          mono
          placeholder="contoso"
        />
      </Row>

      <Row label={t("remote.fieldAuth")} hint={AUTH.find((a) => a.value === spec.azure.auth)?.hint}>
        <Select
          value={spec.azure.auth}
          onChange={(value) => patchAzure({ auth: value as AzureAuth })}
          options={AUTH.map(({ value, label }) => ({ value, label }))}
        />
      </Row>

      {spec.azure.auth === "account_key" && (
        <SecretField
          label={t("remote.azKey")}
          hint={t("remote.azKeyHint")}
          password={password}
          showPassword={showPassword}
          onPassword={onPassword}
          onToggleShowPassword={onToggleShowPassword}
        />
      )}
      {spec.azure.auth === "sas" && (
        <SecretField
          label={t("remote.azSas")}
          hint={t("remote.azSasHint")}
          password={password}
          showPassword={showPassword}
          onPassword={onPassword}
          onToggleShowPassword={onToggleShowPassword}
        />
      )}

      <Row label={t("remote.azSuffix")} hint={t("remote.azSuffixHint")}>
        <Field
          value={spec.azure.endpoint_suffix}
          onChange={(endpoint_suffix) => patchAzure({ endpoint_suffix })}
          mono
          placeholder="core.windows.net"
        />
      </Row>
      <Row label={t("remote.azEndpoint")} hint={t("remote.azEndpointHint")} wide>
        <Field
          value={spec.azure.endpoint}
          onChange={(endpoint) => patchAzure({ endpoint })}
          mono
          placeholder="http://127.0.0.1:10000/devstoreaccount1"
        />
      </Row>

      <EndpointPreview spec={spec} />
    </>
  );
}

/**
 * Paste one connection string, get an account.
 *
 * **It applies the moment it parses, and then empties itself.** A parse only succeeds on something
 * that names an account, so a half-typed line changes nothing; and a field that kept the text would
 * be an account key sitting in a visible input for the rest of the session. What is left behind is
 * a line saying what it set — which is the confirmation the user needs, without the secret in it.
 *
 * The parse is in Rust (`remotes::cloud::azure::parse_connection_string`) for the same reason the
 * `ssh` one is: three shapes arrive, the differences between them are not obvious, and that is
 * where the tests are.
 */
function ConnectionStringField({ onApply }: { onApply: (parsed: ParsedAzureConnection) => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [applied, setApplied] = useState<ParsedAzureConnection | null>(null);
  const [rejected, setRejected] = useState(false);

  const apply = async (value: string) => {
    setText(value);
    setApplied(null);
    if (!value.trim()) return setRejected(false);
    try {
      const parsed = await remoteParseAzureConnection(value);
      if (!parsed) return setRejected(true);
      setRejected(false);
      setApplied(parsed);
      onApply(parsed);
      // Cleared on success only: a line that didn't parse is one the user is still editing.
      setText("");
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  return (
    <div className="py-1">
      <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.azConnectionString")}</span>
      <span className="block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("remote.azConnectionStringHint")}
      </span>
      <textarea
        value={text}
        rows={2}
        onChange={(e) => void apply(e.target.value)}
        placeholder="DefaultEndpointsProtocol=https;AccountName=…;AccountKey=…"
        spellCheck={false}
        className="mt-1.5 w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
      />
      {applied && (
        <p className="flex items-center gap-1.5 pt-1 text-[11px] text-[var(--cf-success)]">
          <Check size={11} className="shrink-0" />
          {t("remote.azConnectionApplied", {
            account: applied.spec.azure.account || applied.name,
            auth: applied.auth === "sas" ? t("remote.azAuthSas") : t("remote.azAuthKey"),
          })}
        </p>
      )}
      {rejected && text.trim().length > 0 && (
        <p className="pt-1 text-[11px] text-[var(--cf-text-muted)]">{t("remote.azConnectionUnread")}</p>
      )}
    </div>
  );
}

/**
 * The four URLs this account will actually be asked for.
 *
 * Cheap, and the fastest way to catch the two mistakes this form makes possible: a suffix typed for
 * the wrong cloud, and an account name with a typo in it. Both otherwise surface as a DNS failure
 * that names a host the user never typed. It is a preview and never an input — every request is
 * still built in Rust.
 */
function EndpointPreview({ spec }: { spec: RemoteHostSpec }) {
  const t = useT();
  const services: ("blob" | "file" | "queue" | "table")[] = ["blob", "file", "queue", "table"];
  const rows = services
    .map((service) => [service, azureEndpoint(spec, service)] as const)
    .filter(([, url]) => url);
  if (rows.length === 0) return null;

  return (
    <div className="py-1">
      <span className="block text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("remote.azEndpointsTitle")}
      </span>
      <div className="mt-1 space-y-0.5">
        {rows.map(([service, url]) => (
          <p key={service} className="min-w-0 truncate font-mono text-[10px] text-[var(--cf-text-muted)]" title={url}>
            {url}
          </p>
        ))}
      </div>
    </div>
  );
}

/** A value no group can have, so picking it is unambiguously "make a new one". */
const NEW_GROUP = "\u0000new";

/**
 * The FTP-only settings.
 *
 * Four flags, and the ordering is deliberate: the two that decide whether the connection *works*
 * come first, and the one that decides whether it is *safe* comes last with its consequence spelled
 * out rather than a reassuring label.
 */
function FtpSettings({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const t = useT();
  const patchFtp = (changes: Partial<RemoteHostSpec["ftp"]>) =>
    onPatch({ ftp: { ...spec.ftp, ...changes } });

  const flag = (
    checked: boolean,
    onChange: (value: boolean) => void,
    label: string,
    hint: string,
    danger = false,
  ) => (
    <label className="flex items-start gap-2 py-1">
      <Checkbox checked={checked} onChange={onChange} className="mt-px" />
      <span className="min-w-0">
        <span className="block text-[12px] text-[var(--cf-text)]">{label}</span>
        <span
          className={`block text-[11px] leading-relaxed ${
            danger && checked ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"
          }`}
        >
          {hint}
        </span>
      </span>
    </label>
  );

  return (
    <div className="space-y-1 pt-1">
      <p className="pt-1 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("remote.ftpSection")}
      </p>

      {flag(
        spec.ftp.passive,
        (passive) => patchFtp({ passive }),
        t("remote.ftpPassive"),
        t("remote.ftpPassiveHint"),
      )}

      {flag(
        spec.ftp.anonymous,
        (anonymous) => patchFtp({ anonymous }),
        t("remote.ftpAnonymous"),
        t("remote.ftpAnonymousHint"),
      )}

      {/* Both TLS flags are FTPS's alone — on a plain `ftp` host they would be settings with
          nothing to act on. */}
      {spec.kind === "ftps" && (
        <>
          {flag(
            spec.ftp.implicit_tls,
            (implicit_tls) => patchFtp({ implicit_tls }),
            t("remote.ftpImplicitTls"),
            t("remote.ftpImplicitTlsHint"),
          )}
          {flag(
            spec.ftp.accept_invalid_certs,
            (accept_invalid_certs) => patchFtp({ accept_invalid_certs }),
            t("remote.ftpInsecureCerts"),
            t("remote.ftpInsecureCertsHint"),
            true,
          )}
        </>
      )}
    </div>
  );
}

/**
 * The host tint, as the twenty colours it is allowed to be.
 *
 * Not a `Row`: `Row` is a `<label>`, and a label hands its clicks to the first labelable thing
 * inside it — the word "Color" would have set the host to whichever swatch happened to be first.
 * The label sits above the grid instead, which is also the only way ten swatches fit in a panel
 * that can be dragged down to 280px.
 *
 * A colour already stored that is not in the set keeps its own swatch at the front. It arrived from
 * the old free picker, and quietly reassigning it to the nearest allowed hue would be this screen
 * editing data the user never came here to change — the palette governs what can be *chosen*, not
 * what is already true. See `HOST_COLORS` for why the set is fixed at all.
 */
function ColorPicker({ color, onColor }: { color: string; onColor: (value: string) => void }) {
  const t = useT();
  const picked = color.trim().toLowerCase();
  const legacy = picked && !HOST_COLORS.some((hex) => hex === picked) ? picked : "";

  const swatch = (hex: string) => (
    <button
      key={hex}
      type="button"
      title={hex}
      aria-label={hex}
      aria-pressed={hex === picked}
      onClick={() => onColor(hex)}
      style={{ background: hex }}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-[var(--cf-text)]"
    >
      {/* White on a tint whose luminance is pinned near 0.215 is ~4:1 — the check reads on every
          swatch in the set, so the selected one needs no ring competing with the colour. */}
      {hex === picked && <Check size={12} className="text-white" strokeWidth={3} />}
    </button>
  );

  return (
    <div className="py-1">
      <span className="block text-[12px] text-[var(--cf-text)]">{t("remote.fieldColor")}</span>
      <span className="block text-[11px] text-[var(--cf-text-muted)]">{t("remote.fieldColorHint")}</span>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {legacy && swatch(legacy)}
        {HOST_COLORS.map(swatch)}
        {picked && (
          <button
            type="button"
            onClick={() => onColor("")}
            className="ml-0.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {t("remote.clear")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The key field, as a list of the keys you actually have.
 *
 * Discovery, not a vault — see `remotes::keys` for why CodeFlow deliberately owns no key store. The
 * field stays free text underneath, because a key outside `~/.ssh` is legitimate and a picker that
 * couldn't express one would be a downgrade from typing the path.
 *
 * `in_agent` is the column worth reading: a key the agent already holds needs no `-i` at all, so
 * choosing it is usually unnecessary — and a key the agent *doesn't* hold is why a connection keeps
 * asking for a passphrase.
 */
function KeyPicker({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const [keys, setKeys] = useState<SshKey[] | null>(null);
  const t = useT();

  useEffect(() => {
    let cancelled = false;
    void remoteListKeys()
      .then((found) => !cancelled && setKeys(found))
      .catch(() => !cancelled && setKeys([]));
    return () => {
      cancelled = true;
    };
  }, []);

  // Only keys with a file can be passed to `-i`; an agent-only identity has nothing to name.
  const usable = (keys ?? []).filter((key) => key.path);

  return (
    <>
      <Row label={t("remote.fieldKeyFile")} wide>
        <Field
          value={spec.key_file}
          onChange={(key_file) => onPatch({ key_file })}
          mono
          placeholder="~/.ssh/id_ed25519"
        />
      </Row>
      {usable.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 py-1 pl-1">
          <span className="text-[11px] text-[var(--cf-text-muted)]">{t("remote.keysFound")}</span>
          {usable.map((key) => (
            <button
              key={key.path}
              type="button"
              title={`${key.kind}${key.comment ? ` · ${key.comment}` : ""}`}
              onClick={() => onPatch({ key_file: key.path })}
              className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[11px] transition-colors ${
                spec.key_file === key.path
                  ? "bg-[var(--cf-accent)] text-white"
                  : "bg-black/[0.05] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] dark:bg-white/[0.07]"
              }`}
            >
              {key.in_agent && (
                <span
                  aria-label={t("remote.keyInAgent")}
                  title={t("remote.keyInAgent")}
                  className="h-[5px] w-[5px] rounded-full bg-[var(--cf-success)]"
                />
              )}
              {key.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Forwards
// ---------------------------------------------------------------------------

function ForwardsTab({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const t = useT();

  const KINDS: { value: ForwardKind; label: string }[] = [
    { value: "local", label: t("remote.forwardLocal") },
    { value: "remote", label: t("remote.forwardRemote") },
    { value: "dynamic", label: t("remote.forwardDynamic") },
  ];

  const update = (id: string, changes: Partial<ForwardSpec>) =>
    onPatch({
      forwards: spec.forwards.map((forward) =>
        forward.id === id ? { ...forward, ...changes } : forward,
      ),
    });

  const add = () =>
    onPatch({
      forwards: [
        ...spec.forwards,
        {
          id: `fwd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          kind: "local",
          listen_port: 0,
          target_host: "",
          target_port: 0,
          auto: false,
          label: "",
        },
      ],
    });

  return (
    <div className="space-y-2">
      <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("remote.forwardsHelp")}
      </p>

      {spec.forwards.length === 0 ? (
        <p className="py-6 text-center text-[12px] text-[var(--cf-text-muted)]">
          {t("remote.noForwards")}
        </p>
      ) : (
        spec.forwards.map((forward) => (
          <div
            key={forward.id}
            className="space-y-2 rounded-md border border-[var(--cf-border)] p-2.5"
          >
            <div className="flex items-center gap-2">
              <div className="w-[150px] shrink-0">
                <Select
                  value={forward.kind}
                  onChange={(value) => update(forward.id, { kind: value as ForwardKind })}
                  options={KINDS.map(({ value, label }) => ({ value, label }))}
                />
              </div>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]">
                {describeForward(forward)}
              </span>
              <button
                type="button"
                onClick={() =>
                  onPatch({ forwards: spec.forwards.filter((entry) => entry.id !== forward.id) })
                }
                aria-label={t("common.delete")}
                className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={13} />
              </button>
            </div>

            {/* Right under the chooser, because the direction is what is being chosen and no
                wording untangles local from remote — see `ForwardDiagram`. */}
            <ForwardDiagram kind={forward.kind} />

            <div className="grid grid-cols-[110px_1fr_110px] gap-2">
              <Field
                type="number"
                value={forward.listen_port === 0 ? "" : String(forward.listen_port)}
                onChange={(value) => update(forward.id, { listen_port: Number(value) || 0 })}
                placeholder={forward.kind === "remote" ? t("remote.required") : t("remote.autoPort")}
                mono
              />
              {forward.kind === "dynamic" ? (
                <span className="flex items-center text-[11px] text-[var(--cf-text-muted)]">
                  {t("remote.dynamicHint")}
                </span>
              ) : (
                <>
                  <Field
                    value={forward.target_host}
                    onChange={(target_host) => update(forward.id, { target_host })}
                    placeholder="localhost"
                    mono
                  />
                  <Field
                    type="number"
                    value={forward.target_port === 0 ? "" : String(forward.target_port)}
                    onChange={(value) => update(forward.id, { target_port: Number(value) || 0 })}
                    placeholder={t("remote.targetPort")}
                    mono
                  />
                </>
              )}
            </div>

            <label className="flex items-start gap-2">
              <Checkbox
                checked={forward.auto}
                onChange={(auto) => update(forward.id, { auto })}
                className="mt-px"
              />
              <span className="min-w-0">
                <span className="block text-[12px] text-[var(--cf-text)]">
                  {t("remote.forwardAuto")}
                </span>
                <span className="block text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
                  {t("remote.forwardAutoHint")}
                </span>
              </span>
            </label>
          </div>
        ))
      )}

      <button
        type="button"
        onClick={add}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      >
        <Plus size={13} />
        {t("remote.addForward")}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/** The tags on the line, as the row stores them. Trailing and repeated commas are what a
 *  half-typed list looks like, so they produce no tag rather than an empty one. */
function parseTags(line: string): string[] {
  return line
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * The tags line, which has to let a comma survive being typed.
 *
 * # The bug this exists to fix
 *
 * This was a `Field` driven straight from `spec.tags.join(", ")`, and the round trip through the
 * row erased the separator as fast as it was pressed. Typing `DESA,` parsed to `["DESA"]` — the
 * empty tail is dropped, correctly — which joined back to `DESA`, so the comma vanished on the same
 * keystroke that made it. The second tag was unreachable by the exact gesture the hint tells you to
 * use, which is why the field looked like it ignored commas altogether.
 *
 * So the text being edited is held here, as text, and the row is told about tags. Those are two
 * different things and conflating them is what broke: `DESA, ` and `DESA,` and `DESA` are three
 * states of one edit and only one list of tags.
 *
 * # Why the resync is conditional
 *
 * Name, group and colour are editable from outside this panel, and tags may be too one day — so the
 * draft still has to follow the row when the row moves on its own. But an unconditional sync would
 * reintroduce the bug through the back door: every keystroke patches the row, the row comes back,
 * and the normalised string overwrites what is being typed. Comparing the *parsed* draft against
 * the row tells the two apart — while a comma is mid-word both sides agree, so nothing is touched,
 * and a change that did not come from this box disagrees and wins.
 */
function TagsField({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState(() => tags.join(", "));

  useEffect(() => {
    // Compared element by element rather than by joining on a separator. Any separator
    // would have to be a character no tag can contain, and the only one the parse takes
    // away is the comma — `prod db` is a legal tag — so joining on a space would let
    // `["prod db"]` and `["prod", "db"]` compare equal and skip a resync that was needed.
    const typed = parseTags(draft);
    const same = typed.length === tags.length && typed.every((tag, at) => tag === tags[at]);
    if (!same) setDraft(tags.join(", "));
    // `draft` is deliberately not a dependency: this watches the *row*, and re-running it on every
    // keystroke is precisely the overwrite described above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags]);

  return (
    <Field
      value={draft}
      onChange={(value) => {
        setDraft(value);
        onChange(parseTags(value));
      }}
      placeholder="postgres, prod"
    />
  );
}

function ScreenTab({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const t = useT();
  const screen = spec.screen;
  const patchScreen = (changes: Partial<RemoteHostSpec["screen"]>) =>
    onPatch({ screen: { ...screen, ...changes } });

  // The three things left once the kind has said the protocol and Connection has said the address:
  // whether to reach it through `ssh`, whether to draw it here, and what to open it with. There is
  // no protocol select and no second address, because a screen row *is* the screen.
  const target = useMemo(() => `${spec.host.trim() || "—"}:${effectivePort(spec)}`, [spec]);
  const via = spec.jump.trim();

  return (
    <div className="space-y-1">
      <p className="pb-2 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
        {t("remote.screenHelp")}
      </p>

      <div className="my-2 rounded-md border border-[var(--cf-border)] p-2.5">
        <label className="flex items-center gap-2">
          <Checkbox checked={screen.tunnel} onChange={(tunnel) => patchScreen({ tunnel })} />
          <span className="text-[12px] text-[var(--cf-text)]">{t("remote.screenTunnel")}</span>
        </label>
        <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("remote.screenTunnelHint")}
        </p>
        {screen.tunnel && (
          // The command as it will actually run, jump host and all — the one line that answers
          // "so what am I connecting to" without opening a terminal to find out.
          <p className="mt-1.5 flex items-center gap-1.5 pl-6 font-mono text-[11px] text-[var(--cf-text-muted)]">
            <Pill tone="accent">{via ? `ssh -J ${via} -L` : "ssh -L"}</Pill>
            127.0.0.1:auto → {target}
          </p>
        )}
      </div>

      {spec.kind === "vnc" && (
        <div className="my-2 rounded-md border border-[var(--cf-border)] p-2.5">
          <label className="flex items-center gap-2">
            <Checkbox checked={screen.embedded} onChange={(embedded) => patchScreen({ embedded })} />
            <span className="text-[12px] text-[var(--cf-text)]">{t("remote.screenEmbedded")}</span>
          </label>
          <p className="mt-1.5 pl-6 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
            {t("remote.screenEmbeddedHint")}
          </p>
        </div>
      )}

      <Row label={t("remote.fieldViewer")} hint={t("remote.fieldViewerHint")} wide>
        <Field
          value={screen.viewer}
          onChange={(viewer) => patchScreen({ viewer })}
          mono
          placeholder={t("remote.viewerPlaceholder")}
        />
      </Row>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Advanced
// ---------------------------------------------------------------------------

function AdvancedTab({
  spec,
  onPatch,
}: {
  spec: RemoteHostSpec;
  onPatch: (changes: Partial<RemoteHostSpec>) => void;
}) {
  const snippets = useRemoteStore((s) => s.snippets);
  const t = useT();

  // All three are things to do *with a shell* — what to run instead of one, what to run inside one,
  // where to start it. A host with no shell has nowhere to put any of them, so it doesn't get them.
  // The `-o` options below are a different matter: they reach every `ssh` this app spawns for the
  // host, and a screen host spawns one for its tunnel.
  const canShell = capabilities(spec).shell;

  return (
    <div className="space-y-1">
      {canShell && (
        <>
          <Row label={t("remote.fieldCommand")} hint={t("remote.fieldCommandHint")} wide>
            <Field
              value={spec.command}
              onChange={(command) => onPatch({ command })}
              mono
              placeholder="docker compose logs -f"
            />
          </Row>
          <Row label={t("remote.fieldStartupSnippet")} hint={t("remote.fieldStartupSnippetHint")} wide>
            <Select
              value={spec.startup_snippet_id}
              onChange={(startup_snippet_id) => onPatch({ startup_snippet_id })}
              options={[
                { value: "", label: t("remote.screenNone") },
                ...snippets.map((snippet) => ({ value: snippet.id, label: snippet.name })),
              ]}
            />
          </Row>

          <Row label={t("remote.fieldDirectory")} hint={t("remote.fieldDirectoryHint")} wide>
            <Field
              value={spec.directory}
              onChange={(directory) => onPatch({ directory })}
              mono
              placeholder="/srv/app"
            />
          </Row>
        </>
      )}

      <div className="pt-3">
        <p className="text-[12px] text-[var(--cf-text)]">{t("remote.fieldOptions")}</p>
        <p className="pb-1.5 text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("remote.fieldOptionsHint")}
        </p>
        <textarea
          value={spec.options.join("\n")}
          rows={5}
          onChange={(e) =>
            onPatch({ options: e.target.value.split("\n").map((line) => line.trim()).filter(Boolean) })
          }
          placeholder={"Compression=yes\nPreferredAuthentications=publickey"}
          className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 font-mono text-[11px] outline-none focus:border-[var(--cf-accent)]"
        />
      </div>

      <div className="pt-3">
        <p className="pb-1.5 text-[12px] text-[var(--cf-text)]">{t("remote.fieldNotes")}</p>
        <textarea
          value={spec.notes}
          rows={4}
          onChange={(e) => onPatch({ notes: e.target.value })}
          placeholder={t("remote.notesPlaceholder")}
          className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
        />
      </div>
    </div>
  );
}
