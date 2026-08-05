import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  ExternalLink,
  FolderInput,
  KeyRound,
  Link2,
  Link2Off,
  Pencil,
  Server,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field, GhostButton, Row } from "./ApiModal";
import { Actions, Group, Note, Panel, Status, Tag, relativeTime } from "./settingsChrome";
import { ActiveUnderline } from "../common/ActivePill";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useApiStore } from "../../state/apiStore";
import { useCollabStore } from "../../state/collabStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import {
  apiBackfillShareProjects,
  apiLoadTree,
  supabaseAnonKey,
  supabaseCheck,
  supabaseInstallSql,
  supabaseSetAnonKey,
} from "../../lib/tauri/apiCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { encodeInvite, syncCollection } from "../../lib/api/sync";
import {
  listConnections,
  projectHost,
  projectRef,
  sameProject,
  type Connection,
} from "../../lib/api/projects";
import type { ApiCollection, SupabaseProject } from "../../types/api";

/**
 * Collaboration, as a list of workspaces and the collections shared inside each one.
 *
 * The shape follows the model: what travels is a **collection**, and a collection lives in a
 * workspace. Sharing one is therefore "pick a collection in this workspace", and accepting an
 * invitation is "put this collection in that workspace" — neither is a decision about the workspace
 * itself, which is what made the previous, workspace-shaped version so hard to explain.
 *
 * The Project pane is a **list** of connections, each collapsed to its ref, its verdict and the
 * button that re-checks it. It was one URL field and one key field, which was never what the
 * machine was doing: the credential store files a key per project and every share carries the
 * project it lives on, so pointing that one field somewhere new left the collections created before
 * it syncing quite happily against a project the pane no longer named. A connection with
 * collections hanging off it now has a row of its own, whether or not it is the one you would
 * create the next share on. See `lib/api/projects.ts`.
 *
 * Each verdict is persisted. A check that only lived in component state meant reopening this pane
 * said "not tested yet" about a project that had been syncing for a week, and the only way back to
 * "connected" was pressing a button that changed nothing.
 */

/**
 * The consoles the bring-your-own credentials come from. `project/_/` is Supabase's own placeholder
 * for "whichever project is selected", so these land on the right page without knowing its ref.
 */
const PROJECT_STEPS: { url: string; labelKey: TranslationKey }[] = [
  { url: "https://supabase.com/dashboard/new", labelKey: "api.collab.helpNewProject" },
  {
    url: "https://supabase.com/dashboard/project/_/settings/api",
    labelKey: "api.collab.helpApiKeys",
  },
  { url: "https://supabase.com/dashboard/project/_/sql/new", labelKey: "api.collab.helpSqlEditor" },
];

/** Re-verify on open if the last check is older than this. Cheap, and keeps the dot honest. */
const RECHECK_AFTER_MS = 5 * 60_000;

type CollabTab = "project" | "shares" | "join";

/** A connection and the one fact about it that lives outside `listConnections`. */
export interface UsableConnection extends Connection {
  hasKey: boolean;
}

/**
 * The three panes, in the order the thing happens: the project that hosts collaboration, what you
 * are sharing out of it, and what you are bringing in.
 *
 * They were three groups stacked in one column, and it was the tallest pane in the settings window
 * by some way — the import field sat below three paragraphs of warnings belonging to the group
 * above it, so pasting an invitation code meant scrolling past the whole of somebody else's
 * concern. They are also three different errands: hosting is set up once, sharing is what an owner
 * does, and importing is what a guest does. Almost nobody needs two of them in the same visit.
 */
const TABS: { id: CollabTab; labelKey: TranslationKey; icon: LucideIcon }[] = [
  { id: "project", labelKey: "api.collab.tabProject", icon: Server },
  { id: "shares", labelKey: "api.collab.tabShares", icon: Users },
  { id: "join", labelKey: "api.collab.tabJoin", icon: FolderInput },
];

export function CollaborationPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);
  const pushToast = useToastStore((s) => s.pushToast);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const shares = useCollabStore((s) => s.shares);
  const keys = useCollabStore((s) => s.keys);
  const refresh = useCollabStore((s) => s.refresh);

  const [hosting, setHosting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tab, setTab] = useState<CollabTab>("project");
  /** Every workspace's collections, so a share can be picked without switching workspace first. */
  const [trees, setTrees] = useState<Record<string, ApiCollection[]>>({});

  const ownedShares = shares.filter((share) => share.role === "owner").length;

  /**
   * The projects set up here, plus the ones this machine's own shares still point at. Derived
   * rather than stored — see the module comment in `lib/api/projects.ts` for why the settings list
   * alone is not the truth.
   */
  const connections = useMemo(
    () =>
      listConnections(settings.supabaseProjects, shares).map((connection) => ({
        ...connection,
        hasKey: keys.includes(projectHost(connection.url)),
      })),
    [settings.supabaseProjects, shares, keys],
  );

  /** The ones a new share could actually be created on. */
  const usable = useMemo(
    () => connections.filter((connection) => connection.ready && connection.hasKey),
    [connections],
  );

  useEffect(() => {
    void refresh();
    // Shares created before a project could be recorded per share have an empty `project_url`, and
    // the only place that still knows which project that was is the first entry of the list — the
    // one the single `supabaseUrl` migrated into. Cheap and idempotent: it only ever touches empty
    // columns, so once it has run there is nothing left for it to claim.
    const first = settings.supabaseProjects[0]?.url ?? "";
    if (first.trim() === "") return;
    void apiBackfillShareProjects(first)
      .then((filled) => {
        if (filled > 0) void refresh();
      })
      .catch(() => {});
    // Only the first project matters here, and only until it has run once. Depending on the whole
    // list would re-run the backfill on every verdict written by a connection check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh]);

  // Collections come from the database rather than from `apiStore`, which only ever holds the
  // active workspace's tree — and this panel is a list of *all* of them.
  //
  // Not on `shares`, which used to be in here too: `refresh()` above hands back a freshly
  // deserialised array every time, so every mount ran the whole load twice — one tree read per
  // workspace, then the same reads again the moment the shares landed — and the second round
  // arrived while the settings rail's pill was still sliding over to this pane. Nothing it bought
  // was needed: sharing a collection changes which of these are *pickable*, not which exist, and
  // `shareable` below already recomputes that from `shares` without going back to the database.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      workspaces.map(async (workspace) => {
        const tree = await apiLoadTree(workspace.id).catch(() => null);
        return [workspace.id, tree?.collections ?? []] as const;
      }),
    ).then((entries) => {
      if (!cancelled) setTrees(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [workspaces]);

  /** Writes one project's row, creating it if this is the first thing settings have said about it. */
  const saveProject = async (url: string, patch: Partial<Omit<SupabaseProject, "url">>) => {
    const list = useApiStore.getState().settings.supabaseProjects;
    const index = list.findIndex((project) => sameProject(project.url, url));
    await updateSettings({
      supabaseProjects:
        index === -1
          ? [...list, { url: url.trim(), ready: false, checkedAt: "", ...patch }]
          : list.map((project, at) => (at === index ? { ...project, ...patch } : project)),
    });
  };

  /** Drops the row and the stored key with it. Only ever offered for a connection nothing needs. */
  const forgetProject = async (url: string) => {
    await supabaseSetAnonKey(url, "").catch((e: unknown) => pushErrorToast(String(e)));
    await updateSettings({
      supabaseProjects: useApiStore
        .getState()
        .settings.supabaseProjects.filter((project) => !sameProject(project.url, url)),
    });
    await refresh();
  };

  /**
   * Asks one project whether it answers and carries the schema, and records the verdict.
   *
   * Recording it also adopts a connection that until now was only inferred from a share: if it is
   * worth checking it is worth keeping, and a row that says "connected" and then disappears from
   * settings on the next render is worse than one that was never listed.
   */
  const verify = async (url: string, silent: boolean): Promise<boolean> => {
    if (url.trim() === "") return false;
    try {
      const check = await supabaseCheck(url);
      const ready = check.reachable && check.schema_installed;
      await saveProject(url, { ready, checkedAt: new Date().toISOString() });
      if (!silent && ready) pushToast(t("api.collab.checkPassed"), "success");
      return ready;
    } catch (e) {
      await saveProject(url, { ready: false, checkedAt: new Date().toISOString() });
      if (!silent) pushErrorToast(String(e));
      return false;
    }
  };

  /**
   * Files a key under the project it belongs to and re-checks that project.
   *
   * The URL is passed in rather than read from a field, because the two are only ever written
   * together: a key filed under the URL that happened to be on screen while it was being typed is
   * how the old single-project form left a key against the previous project and asked the new one
   * with credentials it had never issued.
   */
  const connect = async (url: string, anonKey: string): Promise<boolean> => {
    if (anonKey.trim() !== "") {
      await supabaseSetAnonKey(url, anonKey).catch((e: unknown) => pushErrorToast(String(e)));
    }
    // Recorded before anything is asked *about* it, and refreshed only after. `refresh` reads a
    // key per connection it already knows about, so a project that is still only text in a field
    // is one it does not ask about — which is how a key filed a moment ago came back as "no key
    // stored" until something else happened to refresh the pane.
    await saveProject(url, {});
    const ready = await verify(url, false);
    await refresh();
    return ready;
  };

  /** A string that changes only when a project gains or loses a key — see the effect below. */
  const keyFingerprint = keys.join(",");

  // Opening the pane re-verifies quietly whichever verdicts have gone stale, so "connected" never
  // becomes a claim nobody has checked since the project was set up.
  useEffect(() => {
    for (const connection of connections) {
      if (!connection.hasKey) continue;
      const age =
        connection.checkedAt === "" ? Infinity : Date.now() - Date.parse(connection.checkedAt);
      if (age < RECHECK_AFTER_MS) continue;
      void verify(connection.url, true);
    }
    // These are network calls, not a render concern, and `connections` is a fresh array on every
    // share refresh — depending on it would re-check every project every few seconds. The count and
    // the key fingerprint are the two things that actually mean "there is something new to ask".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length, keyFingerprint]);

  const copySql = async () => {
    try {
      await navigator.clipboard.writeText(await supabaseInstallSql());
      pushToast(t("api.collab.sqlCopied"), "success");
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  // Someone who only ever accepted invitations hosts nothing, so a URL field, a key field, an
  // install script and a connection test are four controls they will never touch — and the last
  // thing a guest needs is a settings pane implying they are supposed to run a server. It folds
  // away until they ask for it, or the moment they actually host something.
  const hostsNothing = ownedShares === 0 && connections.length === 0;

  return (
    <Panel>
      {/* Three panes, in the order the thing actually happens: the project that hosts it, what you
          are sharing out of it, and what you are bringing in. They were three groups stacked in one
          column, which is why the last of them sat four screens below the first — and why the
          warnings belonging to sharing were the only thing on screen when you scrolled past it.
          Same underlined strip, and the same equal thirds, as the backup section's sub-tabs.

          They open the pane now, with no paragraph above them. The one that was there described
          collaboration as a whole to someone who had already navigated to Collaboration, and each
          pane says its own half of it anyway. */}
      <div className="mb-3 flex border-b border-[var(--cf-border)]">
        {TABS.map(({ id, labelKey, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-current={tab === id ? "page" : undefined}
            title={t(labelKey)}
            className={`relative -mb-px flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 pb-2.5 pt-1.5 text-[12.5px] ${
              tab === id
                ? "text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {tab === id && <ActiveUnderline layoutId="cf-collab-tab-underline" />}
            <Icon size={13} className="shrink-0" />
            <span className="truncate">{t(labelKey)}</span>
          </button>
        ))}
      </div>

      {tab === "project" &&
        (hostsNothing && !hosting ? (
          <>
            <Note>{t("api.collab.guestNoProject")}</Note>
            {/* Centred, and out of the `Actions` row it shared with nothing. It is the only control
                in an otherwise empty pane, and pinned to the left edge a lone button reads as the
                leftovers of a form rather than as the one thing there is to do here. */}
            <div className="mt-4 flex justify-center">
              {/* Straight into the form. Landing on an empty list and a second button to press is
                  one more click for the one thing this button can possibly have meant. */}
              <GhostButton
                onClick={() => {
                  setHosting(true);
                  setAdding(true);
                }}
              >
                <Server size={12} />
                {t("api.collab.setUpHosting")}
              </GhostButton>
            </div>
          </>
        ) : (
          <>
            {/* One row per connection, collapsed to the three things you came to look at: which
                project, whether it works, and the button that re-asks. Everything else — the URL,
                the key, the install script — is setup, and setup done once does not deserve to be
                the whole pane forever. */}
            {connections.length === 0 && !adding && (
              <Note>{t("api.collab.noConnections")}</Note>
            )}
            <div className="flex flex-col gap-1">
              {connections.map((connection) => (
                <ConnectionRow
                  key={projectHost(connection.url)}
                  connection={connection}
                  onCheck={(silent) => verify(connection.url, silent)}
                  onConnect={(url, key) => connect(url, key)}
                  onForget={() => forgetProject(connection.url)}
                  onCopySql={copySql}
                />
              ))}
            </div>

            {adding ? (
              <NewConnection
                taken={connections.map((connection) => projectHost(connection.url))}
                onConnect={connect}
                onCopySql={copySql}
                onDone={() => setAdding(false)}
              />
            ) : (
              <div className="mt-2 flex justify-end">
                <GhostButton onClick={() => setAdding(true)}>
                  <Plus size={12} />
                  {t("api.collab.addConnection")}
                </GhostButton>
              </div>
            )}

            {/* The setup and the standing facts, folded away under the form they are about.
                Open, they were three paragraphs and a row of links above the two fields — read once
                while creating the project, in the way on every visit after that. */}
            <Group title={t("api.collab.moreInfo")} collapsible defaultOpen={false}>
              {/* The three steps, as the numbered track the backup wizard uses — same shape,
                  different job: those move between panes of a form, these each open a page in the
                  browser. Independent rather than sequential, because the console remembers where
                  you were and step two is where you go back to when you mislay the key. */}
              <ol className="mb-2 flex items-stretch gap-1">
                {PROJECT_STEPS.map(({ url, labelKey }, index) => (
                  <li key={url} className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() =>
                        void openExternalUrl(url).catch((e: unknown) => pushErrorToast(String(e)))
                      }
                      title={url}
                      className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:border-[color-mix(in_oklab,var(--cf-accent)_50%,transparent)] hover:text-[var(--cf-accent)]"
                    >
                      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--cf-border)] text-[10px] font-medium">
                        {index + 1}
                      </span>
                      <span className="truncate">{t(labelKey)}</span>
                      <ExternalLink size={10} className="shrink-0" />
                    </button>
                  </li>
                ))}
              </ol>
              <Note>{t("api.collab.connectionsAbout")}</Note>
              {/* Replaces a warning that said pointing the panel at another project would stop
                  every share syncing. It never did — a share carries the project it lives on, and
                  goes on talking to it — and a warning that overstates the damage is what makes
                  someone re-share a collection that was working. What is true is the half nobody
                  said: nothing moves, so the old connection stays responsible for the collections
                  already on it, and it is in this list because of them. */}
              {connections.length > 1 && <Note>{t("api.collab.severalConnections")}</Note>}
            </Group>
          </>
        ))}

      {tab === "shares" && (
        <>
          {workspaces.map((workspace) => (
            <WorkspaceShares
              key={workspace.id}
              workspaceId={workspace.id}
              workspaceName={workspace.name}
              active={workspace.id === activeWorkspaceId}
              collections={trees[workspace.id] ?? []}
              connections={usable}
            />
          ))}
          {!settings.syncAuto && shares.length > 0 && (
            <Note tone="warning">{t("api.collab.pausedHint")}</Note>
          )}
          <Row label={t("api.collab.auto")} hint={t("api.collab.autoHint")}>
            <Checkbox
              checked={settings.syncAuto}
              onChange={(syncAuto) => void updateSettings({ syncAuto })}
            />
          </Row>
          {/* The four standing facts about sharing, folded away behind one line.
              They are true whether or not you are sharing anything, and they do not change — which
              is exactly what makes four of them stacked under the controls a wall you read past
              once and never again. Collapsed, the pane is the workspaces and the switch; the wall
              is a click away on the visit where you want it. `pausedHint` above deliberately stays
              out of here: it is about the state right now, not about how sharing works. */}
          <Group title={t("api.collab.moreInfo")} collapsible defaultOpen={false}>
            <Note>{t("api.collab.sharesAbout")}</Note>
            <Note tone="warning">{t("api.collab.tokenIsACredential")}</Note>
            <Note>{t("api.collab.secretsNote")}</Note>
            <Note>{t("api.collab.conflictNote")}</Note>
          </Group>
        </>
      )}

      {tab === "join" && (
        <>
          <JoinBlock />
          <ImportedShares />
        </>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

/**
 * A Supabase project, collapsed to its ref.
 *
 * The ref — `abcd` out of `https://abcd.supabase.co` — rather than the URL, because that is what
 * the Supabase dashboard calls a project and the only part of the URL that differs between two of
 * them. A list titled by full URLs is a column of identical prefixes with the distinguishing eight
 * characters buried in the middle of each.
 *
 * What is on the collapsed row is what you came to find out: which project, whether it works, and
 * how many collections are riding on it. The URL, the key and the install script are underneath,
 * because they are setup — done once, then in the way.
 */
function ConnectionRow({
  connection,
  onCheck,
  onConnect,
  onForget,
  onCopySql,
}: {
  connection: UsableConnection;
  onCheck: (silent: boolean) => Promise<boolean>;
  onConnect: (url: string, anonKey: string) => Promise<boolean>;
  onForget: () => Promise<void>;
  onCopySql: () => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  /** Only ever what has been typed *now*. Empty means "leave the stored one alone". */
  const [anonKey, setAnonKey] = useState("");

  /**
   * Once the project answers, the key field stops being a form and becomes the record of a working
   * connection — one every share on it points at. Left editable it is two keystrokes away from
   * breaking all of them at once: an emptied field files an *empty* key, which deletes the stored
   * one for this project and leaves every collection on it failing to authenticate. Locked, with
   * the way back one deliberate click away.
   */
  const locked = connection.hasKey && connection.ready && !editing;

  /**
   * A connection with collections on it cannot be dropped.
   *
   * Not caution — arithmetic. Removing it deletes the stored key, and the key is what every share
   * on that project authenticates with; the row would go away and take all of them down with it.
   * The way to end a connection is to stop sharing what is on it, which is also the one action
   * that tells the people on the other side.
   *
   * The URL is not editable on any row, with or without collections: a different URL is a different
   * project, so an edit here would be a rename that moves neither the key nor the shares, and
   * silently orphans whatever was on the old one. Another project is Add; letting go of this one is
   * Remove; between them there is nothing an editable URL would express.
   */
  const pinned = connection.shares > 0;

  const guard = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    guard(async () => {
      if (await onConnect(connection.url, anonKey)) {
        setAnonKey("");
        setEditing(false);
      }
    });

  const forget = () =>
    guard(async () => {
      if (!(await confirmAction(t("api.collab.forgetConfirm", { ref: projectRef(connection.url) }))))
        return;
      await onForget();
    });

  const checkedAgo = relativeTime(connection.checkedAt, {
    now: t("api.collab.justNow"),
    minutes: t("api.collab.minutesAgo"),
    hours: t("api.collab.hoursAgo"),
    days: t("api.collab.daysAgo"),
  });

  return (
    <div className="rounded-md bg-black/[0.02] px-2 py-1.5 dark:bg-white/[0.03]">
      {/* The disclosure and the check button are siblings rather than one inside the other: a
          button nested in a button is invalid, and making the whole row toggle would mean the
          row's own action also collapses it. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          title={projectHost(connection.url)}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          <span className="truncate font-mono text-[12px] text-[var(--cf-text)]">
            {projectRef(connection.url)}
          </span>
          {/* Two keys rather than one with a count, because this i18n has no plural rules and
              "1 collections" under every freshly shared project is the kind of wrong that gets
              noticed every single time. */}
          {connection.shares > 0 && (
            <Tag icon={Users}>
              {connection.shares === 1
                ? t("api.collab.oneCollection")
                : t("api.collab.nCollections", { n: String(connection.shares) })}
            </Tag>
          )}
        </button>
        {busy ? (
          <Status tone="accent" pulse>
            {t("api.collab.checking")}
          </Status>
        ) : !connection.hasKey ? (
          <Status tone="warning">{t("api.collab.noKey")}</Status>
        ) : connection.ready ? (
          <Status tone="success">
            {checkedAgo
              ? t("api.collab.connectedAgo", { ago: checkedAgo })
              : t("api.collab.connected")}
          </Status>
        ) : (
          <Status tone="warning">
            {connection.checkedAt === "" ? t("api.collab.untested") : t("api.collab.notReachable")}
          </Status>
        )}
        <GhostButton onClick={() => void guard(() => onCheck(false))} disabled={busy}>
          <RefreshCw size={12} />
          {t("api.collab.test")}
        </GhostButton>
      </div>

      {open && (
        // Indented to the ref rather than the chevron, so what unfolds reads as belonging to the
        // row above it instead of starting a new one.
        <div className="mt-1 pl-[18px]">
          {/* Text, not a disabled field. It is never editable on this row, and a greyed-out input
              says "you may not touch this yet" — which invites looking for the button that unlocks
              it. There isn't one, and there is nothing here to type. */}
          <Row label={t("api.collab.projectUrl")} wide>
            <span
              title={connection.url}
              className="block select-text truncate font-mono text-[12px] text-[var(--cf-text-muted)]"
            >
              {connection.url}
            </span>
          </Row>
          <Row label={t("api.collab.anonKey")} wide>
            <Field
              type="password"
              disabled={locked}
              value={anonKey}
              placeholder={connection.hasKey ? t("api.collab.keyStored") : ""}
              onChange={setAnonKey}
            />
          </Row>
          {/* The reassurance about pasting a key, where the panel is asking for one. */}
          {!connection.hasKey && <Note>{t("api.collab.needsCredentials")}</Note>}
          {editing && <Note>{t("api.collab.urlPinned")}</Note>}

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <GhostButton onClick={() => void onCopySql()} disabled={busy}>
              <ClipboardCopy size={12} />
              {t("api.collab.copySql")}
            </GhostButton>
            {/* The two are mutually exclusive by construction: locked, the key field is disabled,
                so there is never anything for "Connect" to send — it would sit there greyed out
                under a working connection, which reads as something being wrong. Re-checking a
                connection that holds is the button on the row above. */}
            {locked ? (
              <GhostButton onClick={() => setEditing(true)} title={t("api.collab.editHint")}>
                <Pencil size={12} />
                {t("api.collab.replaceKey")}
              </GhostButton>
            ) : (
              <GhostButton onClick={save} disabled={busy || anonKey.trim() === ""}>
                <Link2 size={12} />
                {t("api.collab.connect")}
              </GhostButton>
            )}
            {/* `ml-auto`, so it sits at the far end of whichever line it lands on rather than
                beside the ones it is not one of. Those set the connection up; this one ends it. */}
            <span className="ml-auto">
              <GhostButton
                onClick={forget}
                disabled={busy || pinned}
                title={pinned ? t("api.collab.forgetBlocked") : undefined}
              >
                <Trash2 size={12} />
                {t("api.collab.forget")}
              </GhostButton>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The form for a project that is not in the list yet.
 *
 * Its own component rather than an empty `ConnectionRow`, because the two are different shapes: a
 * row is collapsed by default and titled by a ref, and a project with no URL yet has neither.
 */
function NewConnection({
  taken,
  onConnect,
  onCopySql,
  onDone,
}: {
  taken: string[];
  onConnect: (url: string, anonKey: string) => Promise<boolean>;
  onCopySql: () => Promise<void>;
  onDone: () => void;
}) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [busy, setBusy] = useState(false);

  const duplicate = url.trim() !== "" && taken.includes(projectHost(url));

  // Closed whatever the verdict. A project that answered and one that did not are both in the list
  // by now, each with a row that says which it was and its own button to re-ask — leaving the form
  // open on a failure would put the same two fields on screen twice, saying different things.
  const submit = async () => {
    setBusy(true);
    try {
      await onConnect(url, anonKey);
      onDone();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md border border-dashed border-[var(--cf-border)] px-2 py-1.5">
      <Row label={t("api.collab.projectUrl")} wide>
        <Field mono value={url} placeholder="https://xxxx.supabase.co" onChange={setUrl} />
      </Row>
      <Row label={t("api.collab.anonKey")} wide>
        <Field type="password" value={anonKey} onChange={setAnonKey} />
      </Row>
      {duplicate ? (
        <Note tone="warning">{t("api.collab.alreadyConnected")}</Note>
      ) : (
        <Note>{t("api.collab.needsCredentials")}</Note>
      )}
      <Actions>
        <GhostButton onClick={() => void onCopySql()} disabled={busy}>
          <ClipboardCopy size={12} />
          {t("api.collab.copySql")}
        </GhostButton>
        <GhostButton
          onClick={() => void submit()}
          disabled={busy || duplicate || url.trim() === "" || anonKey.trim() === ""}
        >
          <Link2 size={12} />
          {t("api.collab.connect")}
        </GhostButton>
        <span className="ml-auto">
          <GhostButton onClick={onDone} disabled={busy}>
            {t("api.collab.cancel")}
          </GhostButton>
        </span>
      </Actions>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One workspace's shares
// ---------------------------------------------------------------------------

function WorkspaceShares({
  workspaceId,
  workspaceName,
  active,
  collections,
  connections,
}: {
  workspaceId: string;
  workspaceName: string;
  active: boolean;
  collections: ApiCollection[];
  /** The connections a new share could be created on — checked, and with a key stored. */
  connections: UsableConnection[];
}) {
  const t = useT();
  // Selected as the whole list and filtered here: a selector that returns a fresh array on every
  // call never matches its own previous snapshot, and `useSyncExternalStore` re-renders forever.
  const allShares = useCollabStore((s) => s.shares);
  // Owned only. The ones you were invited into are listed under Import, where you brought them
  // in: you host none of them, cannot hand out their invitation and cannot rotate their code, so
  // among the ones you own they were the same thing wearing a different badge.
  const shares = useMemo(
    () => allShares.filter((share) => share.workspace_id === workspaceId && share.role === "owner"),
    [allShares, workspaceId],
  );
  const startSharing = useCollabStore((s) => s.startSharing);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const pushToast = useToastStore((s) => s.pushToast);

  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState("");
  /**
   * Which project the new share lands on, once there is more than one it could.
   *
   * Empty until the user picks, and never pre-filled from the list: with two connections there is
   * no default that is right more often than the other, and a silent one is how a collection ends
   * up hosted on last month's project. With exactly one connection this is not asked at all — see
   * `target` below.
   */
  const [project, setProject] = useState("");

  const shareable = useMemo(() => {
    const already = new Set(shares.map((share) => share.collection_id));
    return collections.filter((collection) => !already.has(collection.id));
  }, [collections, shares]);

  /** The one connection there is, or the one that was picked. */
  const target = connections.length === 1 ? connections[0].url : project;

  /**
   * Why the button is off, or `null` when it isn't — asked in the order the answers apply.
   *
   * "Everything here is already shared" was the tooltip for every one of these, and it is only true
   * when there *was* something to share: on a machine with no project connected and a workspace
   * holding no collections at all, it describes a situation that does not exist, and reads as the
   * app being confused about its own state.
   */
  const blocked: TranslationKey | null =
    connections.length === 0
      ? "api.collab.needsProjectToShare"
      : collections.length === 0
        ? "api.collab.workspaceHasNoCollections"
        : shareable.length === 0
          ? "api.collab.nothingLeftToShare"
          : null;

  const confirmShare = async () => {
    const collection = collections.find((c) => c.id === choice);
    if (!collection || target === "") return;
    // Sharing writes against the *active* workspace's collection ids on the backend, and the first
    // upload has to be able to read the tree — switching first is what makes both true.
    if (!active) setActiveWorkspace(workspaceId);
    const token = await startSharing(collection.id, collection.name, target);
    if (token === null) return;
    setPicking(false);
    setChoice("");
    setProject("");
    // A guest joining an empty share would see nothing and reasonably conclude it was broken.
    await syncCollection(collection.id).catch((e: unknown) => pushErrorToast(String(e)));
    pushToast(t("api.collab.sharingStarted", { name: collection.name }), "success");
  };

  return (
    <div className="mb-2 rounded-lg border border-[var(--cf-border)] px-2 py-1.5 last:mb-0">
      <div className="flex items-center gap-2">
        <Users size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
          {workspaceName}
        </span>
        {active && <Tag tone="accent">{t("api.collab.activeWorkspace")}</Tag>}
        <GhostButton
          onClick={() => setPicking((open) => !open)}
          disabled={blocked !== null}
          title={blocked ? t(blocked) : undefined}
        >
          <Plus size={12} />
          {t("api.collab.addCollection")}
        </GhostButton>
      </div>

      {picking && (
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t("api.collab.shareHint")}
        </p>
      )}
      {picking && (
        <div className="mt-1.5 flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <Select
              value={choice}
              onChange={setChoice}
              placeholder={t("api.collab.pickCollection")}
              options={shareable.map((collection) => ({
                value: collection.id,
                label: collection.name,
              }))}
            />
          </div>
          {/* Only when there is a decision to make. With one connection the second control would
              be a dropdown of one, asked every time, whose answer was never in doubt — and the
              single-project setup this pane came from is still the common case. */}
          {connections.length > 1 && (
            <div className="w-[130px] shrink-0">
              <Select
                value={project}
                onChange={setProject}
                placeholder={t("api.collab.pickProject")}
                options={connections.map((connection) => ({
                  value: connection.url,
                  label: projectRef(connection.url),
                }))}
              />
            </div>
          )}
          <GhostButton
            onClick={() => void confirmShare()}
            disabled={choice === "" || target === ""}
          >
            <Link2 size={12} />
            {t("api.collab.share")}
          </GhostButton>
        </div>
      )}

      {shares.length === 0 ? (
        <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{t("api.collab.noneShared")}</p>
      ) : (
        <div className="mt-1.5 flex flex-col gap-1">
          {shares.map((share) => (
            <ShareRow key={share.collection_id} collectionId={share.collection_id} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The collections you were invited into
// ---------------------------------------------------------------------------

/**
 * What you have joined, listed under the field that joins things.
 *
 * They used to sit among the collections you own, told apart by a badge. That put two different
 * relationships in one list: an owned share is something you host, hand out and can revoke, while
 * one of these is somebody else's, on somebody else's project, and the whole of what you can do
 * with it is sync it and walk away. Under Import it is also the answer to the question the tab
 * raises — "what have I brought in?" — which nothing was answering before.
 *
 * Flat rather than grouped by workspace: the workspace was a choice made once, at import, and it
 * rides along as a tag on the row instead of as a heading over a list of one.
 */
function ImportedShares() {
  const t = useT();
  const allShares = useCollabStore((s) => s.shares);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const joined = useMemo(
    () => allShares.filter((share) => share.role !== "owner"),
    [allShares],
  );
  if (joined.length === 0) return null;
  return (
    <Group title={t("api.collab.imported")}>
      <div className="flex flex-col gap-1">
        {joined.map((share) => (
          <ShareRow
            key={share.collection_id}
            collectionId={share.collection_id}
            workspaceName={
              workspaces.find((workspace) => workspace.id === share.workspace_id)?.name ?? ""
            }
          />
        ))}
      </div>
    </Group>
  );
}

// ---------------------------------------------------------------------------
// One shared collection
// ---------------------------------------------------------------------------

function ShareRow({
  collectionId,
  workspaceName,
}: {
  collectionId: string;
  /** Set in the imported list, which is flat: it is the one fact a row there is missing. */
  workspaceName?: string;
}) {
  const t = useT();
  const share = useCollabStore((s) => s.shareFor(collectionId));
  const health = useCollabStore((s) => s.health(collectionId));
  const tokenFor = useCollabStore((s) => s.tokenFor);
  const rotate = useCollabStore((s) => s.rotate);
  const leave = useCollabStore((s) => s.leave);
  const allShares = useCollabStore((s) => s.shares);
  const pushToast = useToastStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  /**
   * Whether this machine hosts on more than one project — the only case in which naming a share's
   * project on its own row tells anyone anything. With one connection it is the same eight
   * characters under every row, which is how a tag stops being read at all.
   */
  const severalProjects = useMemo(
    () =>
      new Set(
        allShares
          .filter((row) => row.role === "owner" && row.project_url.trim() !== "")
          .map((row) => projectHost(row.project_url)),
      ).size > 1,
    [allShares],
  );

  if (!share) return null;
  const name = share.name || share.remote_name;
  const isOwner = share.role === "owner";

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyInvite = () =>
    guard(async () => {
      const token = await tokenFor(collectionId);
      if (token === null) {
        pushErrorToast(t("api.collab.noTokenHere"));
        return;
      }
      // The share's own project, and only ever that one. There used to be a fallback to whichever
      // project the settings field named, which was the wrong answer in exactly the case it fired:
      // a share with no project recorded is not one that lives on the current project, and an
      // invitation carrying a url and key the token has never existed under is one the guest reads
      // as an invalid key.
      const url = share.project_url.trim();
      if (url === "") throw new Error(t("api.collab.noProjectForInvite"));
      // Read here and nowhere else, so the key is in the renderer for the length of this function
      // and no longer. No fallback: an invitation carrying an empty key is one the guest cannot
      // use, and failing loudly beats handing out a code that silently does not work.
      const key = await supabaseAnonKey(url);
      if (!key) throw new Error(t("api.collab.noKeyForInvite"));
      await navigator.clipboard.writeText(encodeInvite({ url, key, token, name }));
      pushToast(t("api.collab.inviteCopied"), "success");
    });

  const syncOne = () =>
    guard(async () => {
      const result = await syncCollection(collectionId);
      if (result === null) return;
      pushToast(
        result.conflicts > 0
          ? t("api.collab.syncedWithConflicts", { n: String(result.conflicts) })
          : t("api.collab.synced", {
              applied: String(
                result.applied.collections + result.applied.folders + result.applied.requests,
              ),
              deleted: String(result.deleted),
            }),
        result.conflicts > 0 ? "info" : "success",
      );
    });

  const rotateCode = () =>
    guard(async () => {
      if (!(await confirmAction(t("api.collab.rotateConfirm")))) return;
      if ((await rotate(collectionId)) !== null) pushToast(t("api.collab.rotated"), "success");
    });

  const stop = () =>
    guard(async () => {
      const question = isOwner
        ? t("api.collab.leaveConfirm", { name })
        : t("api.collab.disconnectConfirm", { name });
      if (!(await confirmAction(question))) return;
      await leave(collectionId);
    });

  const syncedAgo = relativeTime(share.last_sync_at, {
    now: t("api.collab.justNow"),
    minutes: t("api.collab.minutesAgo"),
    hours: t("api.collab.hoursAgo"),
    days: t("api.collab.daysAgo"),
  });

  const tone =
    health === "conflict" || health === "error" || health === "paused"
      ? "warning"
      : health === "syncing"
        ? "accent"
        : "success";

  const status = (
    <Status tone={tone} pulse={health === "syncing"}>
      {health === "syncing"
        ? t("api.collab.syncing")
        : health === "error"
          ? share.last_error
          : health === "conflict"
            ? t("api.collab.waitingOnYou")
            : health === "paused"
              ? t("api.collab.paused")
              : syncedAgo
                ? t("api.collab.syncedAgo", { ago: syncedAgo })
                : t("api.collab.neverSynced")}
    </Status>
  );

  return (
    <div className="rounded-md bg-black/[0.02] px-2 py-1.5 dark:bg-white/[0.03]">
      {/* Collapsed, a share is the three things you came to look at: which collection, whether it
          is up to date, and the button that makes it up to date. Everything else — the tags, the
          invitation, a new code, walking away — is either a fact you already know or an errand you
          arrived meaning to run, and four shares' worth of it stacked open turned this pane into a
          wall of identical buttons.

          The disclosure and the sync button are siblings rather than one inside the other: a button
          nested in a button is invalid, and making the whole row toggle would mean the row's own
          action also collapses it. The name expands, the button syncs, and neither reaches the
          other. */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-left"
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
          )}
          <span className="truncate text-[12px] text-[var(--cf-text)]">{name}</span>
        </button>
        {status}
        <GhostButton onClick={syncOne} disabled={busy}>
          <RefreshCw size={12} />
          {t("api.collab.syncNow")}
        </GhostButton>
      </div>

      {open && (
        // Indented to the name rather than the chevron, so what unfolds reads as belonging to the
        // row above it instead of starting a new one.
        <div className="mt-1 pl-[18px]">
          <div className="flex flex-wrap items-center gap-1.5">
            {/* The host sees which of their projects a share is on — theirs to know. A member is
                told *how* they are connected, never *where*: the project, its URL and its key
                belong to whoever invited them, and a guest has no business reading them off a
                settings pane. */}
            {isOwner
              ? severalProjects &&
                share.project_url !== "" && (
                  <Tag icon={Server} title={projectHost(share.project_url)}>
                    {projectRef(share.project_url)}
                  </Tag>
                )
              : workspaceName === undefined && <Tag icon={Link2}>{t("api.collab.viaInvitation")}</Tag>}
            {/* No owner/member badge. Which of the two lists a row is in says it already, and a
                tag repeating it on every row was the loudest thing in a card whose actual news is
                whether the collection is up to date. */}
            {workspaceName !== undefined && workspaceName !== "" && (
              <Tag icon={Users}>{workspaceName}</Tag>
            )}
            {share.conflicts > 0 && (
              <Tag tone="warning" icon={ShieldAlert}>
                {t("api.collab.nConflicts", { n: String(share.conflicts) })}
              </Tag>
            )}
          </div>

          {/* A member is a guest on somebody else's project. They can move changes in and out, and
              they can walk away — that is the whole of it. Handing out the invitation would be
              re-sharing a project that is not theirs (the code carries its URL and key), and
              rotating the token would lock out the person whose project it is, along with
              everyone else. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {isOwner && (
              <GhostButton onClick={copyInvite} disabled={busy} title={t("api.collab.copyInviteHint")}>
                <ClipboardCopy size={12} />
                {t("api.collab.copyInvite")}
              </GhostButton>
            )}
            {isOwner && (
              <GhostButton onClick={rotateCode} disabled={busy}>
                <KeyRound size={12} />
                {t("api.collab.rotate")}
              </GhostButton>
            )}
            {/* `ml-auto`, so it sits at the far end of whichever line it lands on rather than
                beside the ones it is not one of. Those maintain the share; this one ends it, and
                being the odd one out is the point. */}
            <span className="ml-auto">
              <GhostButton onClick={stop} disabled={busy}>
                <Link2Off size={12} />
                {isOwner ? t("api.collab.leave") : t("api.collab.disconnect")}
              </GhostButton>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accepting an invitation
// ---------------------------------------------------------------------------

/**
 * Also reachable from the API client's toolbar — the same flow, because "import a collaborative
 * collection" is where someone who was handed a code will look first, and settings is where someone
 * setting the whole thing up will.
 */
export function JoinBlock({ onDone }: { onDone?: () => void } = {}) {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [code, setCode] = useState("");
  const [target, setTarget] = useState(activeWorkspaceId ?? "");
  const [busy, setBusy] = useState(false);
  const importCollaborative = useImportCollaborative();

  return (
    <>
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <Field mono value={code} placeholder={t("api.collab.joinPlaceholder")} onChange={setCode} />
        </div>
        <div className="w-[170px] shrink-0">
          <Select
            value={target}
            onChange={setTarget}
            placeholder={t("api.collab.pickWorkspace")}
            options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
          />
        </div>
        <GhostButton
          onClick={() =>
            void (async () => {
              setBusy(true);
              try {
                if (await importCollaborative(code, target)) {
                  setCode("");
                  onDone?.();
                }
              } finally {
                setBusy(false);
              }
            })()
          }
          disabled={busy || code.trim() === "" || target === ""}
        >
          <FolderInput size={12} />
          {t("api.collab.join")}
        </GhostButton>
      </div>
      <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        {t("api.collab.joinHint")}
      </p>
    </>
  );
}

/**
 * Accepting an invitation, from wherever it was pasted: adopt the project the code names, register
 * the share under the chosen workspace, pull it down, and land the user on it.
 */
export function useImportCollaborative() {
  const t = useT();
  const join = useCollabStore((s) => s.join);
  const pushToast = useToastStore((s) => s.pushToast);

  return async (code: string, workspaceId: string): Promise<boolean> => {
    try {
      const { decodeInvite } = await import("../../lib/api/sync");
      const invite = decodeInvite(code);

      // Filed under the project the invitation names, before anything is asked of that project.
      // Every request is built from the key stored for the URL it goes to, so skipping this is
      // not "the key gets set up later" — it is the join reaching for whatever key happens to be
      // lying around: the one for this person's *own* project, which the host's server rejects as
      // an invalid key, or none at all, which is the "no anon key is stored for …" further down.
      //
      // Nothing here is written to the settings above. That field is this person's own project,
      // the one they host their collections on, and accepting an invitation to somebody else's is
      // not a reason to redefine it — it used to be, which meant the second invitation silently
      // cut off every collection accepted before it, and left the host's server sitting on a
      // settings pane belonging to someone with no business reading it.
      await supabaseSetAnonKey(invite.url, invite.key);

      const collectionId = await join(invite.url, invite.token, workspaceId);
      if (collectionId === null) return false;

      // The collection does not exist here yet — this first round is what creates it.
      await syncCollection(collectionId);
      if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
        await useApiStore.getState().reloadTree();
      } else {
        useWorkspaceStore.getState().setActiveWorkspace(workspaceId);
      }
      pushToast(t("api.collab.joined", { name: invite.name }), "success");
      return true;
    } catch (e) {
      pushErrorToast(String(e));
      return false;
    }
  };
}
