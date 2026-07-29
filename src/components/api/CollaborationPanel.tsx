import { useEffect, useMemo, useState } from "react";
import {
  ClipboardCopy,
  Crown,
  FolderInput,
  KeyRound,
  Link2,
  Server,
  Plus,
  RefreshCw,
  ShieldAlert,
  Users,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field, GhostButton, Row } from "./ApiModal";
import { Actions, Group, HelpLink, Note, Panel, Status, Tag, relativeTime } from "./settingsChrome";
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
import { encodeInvite, syncCollection } from "../../lib/api/sync";
import type { ApiCollection } from "../../types/api";

/**
 * Collaboration, as a list of workspaces and the collections shared inside each one.
 *
 * The shape follows the model: what travels is a **collection**, and a collection lives in a
 * workspace. Sharing one is therefore "pick a collection in this workspace", and accepting an
 * invitation is "put this collection in that workspace" — neither is a decision about the workspace
 * itself, which is what made the previous, workspace-shaped version so hard to explain.
 *
 * The connection block above it is about the project and nothing else, and its verdict is
 * persisted. A check that only lived in component state meant reopening this pane said "not tested
 * yet" about a project that had been syncing for a week, and the only way back to "connected" was
 * pressing a button that changed nothing.
 */

/**
 * The consoles the bring-your-own credentials come from. `project/_/` is Supabase's own placeholder
 * for "whichever project is selected", so these land on the right page without knowing its ref.
 */
const HELP_URLS = {
  newProject: "https://supabase.com/dashboard/new",
  apiSettings: "https://supabase.com/dashboard/project/_/settings/api",
  sqlEditor: "https://supabase.com/dashboard/project/_/sql/new",
} as const;

/** Re-verify on open if the last check is older than this. Cheap, and keeps the dot honest. */
const RECHECK_AFTER_MS = 5 * 60_000;

/** `https://abcd.supabase.co` → `abcd.supabase.co`. Enough to tell two projects apart in a tag. */
function projectHost(url: string): string {
  return url.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function CollaborationPanel() {
  const t = useT();
  const settings = useApiStore((s) => s.settings);
  const updateSettings = useApiStore((s) => s.updateSettings);
  const pushToast = useToastStore((s) => s.pushToast);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const shares = useCollabStore((s) => s.shares);
  const hasKey = useCollabStore((s) => s.hasKey);
  const refresh = useCollabStore((s) => s.refresh);

  const [anonKey, setAnonKey] = useState("");
  const [checking, setChecking] = useState(false);
  const [hosting, setHosting] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Every workspace's collections, so a share can be picked without switching workspace first. */
  const [trees, setTrees] = useState<Record<string, ApiCollection[]>>({});

  const configured = settings.supabaseUrl.trim() !== "" && hasKey;
  const ownedShares = shares.filter((share) => share.role === "owner").length;

  useEffect(() => {
    void refresh();
    if (settings.supabaseUrl.trim() === "") return;
    void supabaseAnonKey(settings.supabaseUrl).then((key) => setAnonKey(key ?? "")).catch(() => {});
    // Shares created before a project could be recorded per share are all on this one, which is the
    // only place that still knows it. Cheap and idempotent — it only ever touches empty columns.
    void apiBackfillShareProjects(settings.supabaseUrl)
      .then((filled) => {
        if (filled > 0) void refresh();
        void disownInheritedProject();
      })
      .catch(() => {});
  }, [refresh, settings.supabaseUrl]);

  // Collections come from the database rather than from `apiStore`, which only ever holds the
  // active workspace's tree — and this panel is a list of *all* of them.
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
  }, [workspaces, shares]);

  const verify = async (silent: boolean) => {
    if (!configured) return;
    setChecking(true);
    try {
      const check = await supabaseCheck(settings.supabaseUrl);
      const ready = check.reachable && check.schema_installed;
      await updateSettings({
        supabaseReady: ready,
        supabaseCheckedAt: new Date().toISOString(),
      });
      if (!silent && ready) pushToast(t("api.collab.checkPassed"), "success");
    } catch (e) {
      await updateSettings({ supabaseReady: false, supabaseCheckedAt: new Date().toISOString() });
      if (!silent) pushErrorToast(String(e));
    } finally {
      setChecking(false);
    }
  };

  // Opening the pane re-verifies quietly when the stored verdict has gone stale, so "connected"
  // never becomes a claim nobody has checked since the project was set up.
  useEffect(() => {
    if (!configured) return;
    const age = settings.supabaseCheckedAt === "" ? Infinity : Date.now() - Date.parse(settings.supabaseCheckedAt);
    if (age < RECHECK_AFTER_MS) return;
    void verify(true);
    // Only on open and on a credential change: this is a network call, not a render concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured, settings.supabaseUrl]);

  /**
   * Clears a project URL that was never this person's to begin with.
   *
   * Accepting an invitation used to overwrite the single global project, because there was only
   * one. On a machine that only ever joined, that leaves the *host's* server sitting in the field
   * labelled "your project" — the one thing a member is not supposed to be looking at. The tell is
   * exact: nothing is hosted here, and the URL is the one a share we are a member of points at.
   * Only then, and it never touches a project the user actually set up.
   */
  const disownInheritedProject = async () => {
    const current = useApiStore.getState().settings.supabaseUrl.trim();
    if (current === "") return;
    const rows = useCollabStore.getState().shares;
    if (rows.some((share) => share.role === "owner")) return;
    if (!rows.some((share) => share.project_url.trim() === current)) return;
    await updateSettings({ supabaseUrl: "", supabaseReady: false, supabaseCheckedAt: "" });
    await refresh();
  };

  const saveKey = async (value: string) => {
    setAnonKey(value);
    await supabaseSetAnonKey(settings.supabaseUrl, value).catch((e: unknown) =>
      pushErrorToast(String(e)),
    );
    await refresh();
  };

  const copySql = async () => {
    setBusy(true);
    try {
      await navigator.clipboard.writeText(await supabaseInstallSql());
      pushToast(t("api.collab.sqlCopied"), "success");
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const checkedAgo = relativeTime(settings.supabaseCheckedAt, {
    now: t("api.collab.justNow"),
    minutes: t("api.collab.minutesAgo"),
    hours: t("api.collab.hoursAgo"),
    days: t("api.collab.daysAgo"),
  });

  // Someone who only ever accepted invitations hosts nothing, so a URL field, a key field, an
  // install script and a connection test are four controls they will never touch — and the last
  // thing a guest needs is a settings pane implying they are supposed to run a server. It folds
  // away until they ask for it, or the moment they actually host something.
  const hostsNothing = ownedShares === 0 && settings.supabaseUrl.trim() === "";

  return (
    <Panel>
      <Note>{t("api.collab.about")}</Note>

      {hostsNothing && !hosting ? (
        <Group title={t("api.collab.groupProject")}>
          <Note>{t("api.collab.guestNoProject")}</Note>
          <Actions>
            <GhostButton onClick={() => setHosting(true)}>
              <Server size={12} />
              {t("api.collab.setUpHosting")}
            </GhostButton>
          </Actions>
        </Group>
      ) : (
      <Group title={t("api.collab.groupProject")}>
        <Note>{t("api.collab.oneProjectPerOwner")}</Note>
        {/* Changing it does not move anything: the shares already created live on the old project,
            and every one of them would start failing against a URL that has never heard of them. */}
        {ownedShares > 0 && <Note tone="warning">{t("api.collab.changingProjectWarning")}</Note>}
        {/* Create the project, copy its two values, then run the script — the three steps below,
            in that order, each landing on the page they happen on. */}
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <HelpLink url={HELP_URLS.newProject}>{t("api.collab.helpNewProject")}</HelpLink>
          <HelpLink url={HELP_URLS.apiSettings}>{t("api.collab.helpApiKeys")}</HelpLink>
          <HelpLink url={HELP_URLS.sqlEditor}>{t("api.collab.helpSqlEditor")}</HelpLink>
        </div>

        <Row label={t("api.collab.projectUrl")} wide>
          <Field
            mono
            value={settings.supabaseUrl}
            placeholder="https://xxxx.supabase.co"
            onChange={(supabaseUrl) => void updateSettings({ supabaseUrl, supabaseReady: false })}
          />
        </Row>
        <Row label={t("api.collab.anonKey")} hint={t("api.collab.anonKeyHint")} wide>
          <Field
            type="password"
            value={anonKey}
            placeholder={hasKey ? t("api.collab.keyStored") : ""}
            onChange={(value) => void saveKey(value)}
          />
        </Row>

        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2">
          {checking ? (
            <Status tone="accent" pulse>
              {t("api.collab.checking")}
            </Status>
          ) : !configured ? (
            <Status tone="muted">{t("api.collab.needsCredentials")}</Status>
          ) : settings.supabaseReady ? (
            <Status tone="success">
              {checkedAgo ? t("api.collab.connectedAgo", { ago: checkedAgo }) : t("api.collab.connected")}
            </Status>
          ) : (
            <Status tone="warning">
              {settings.supabaseCheckedAt === ""
                ? t("api.collab.untested")
                : t("api.collab.notReachable")}
            </Status>
          )}
          <Actions>
            <GhostButton onClick={() => void copySql()} disabled={busy}>
              <ClipboardCopy size={12} />
              {t("api.collab.copySql")}
            </GhostButton>
            <GhostButton onClick={() => void verify(false)} disabled={checking || !configured}>
              <RefreshCw size={12} />
              {t("api.collab.test")}
            </GhostButton>
          </Actions>
        </div>
      </Group>
      )}

      <Group title={t("api.collab.groupShares")}>
        <Note>{t("api.collab.sharesAbout")}</Note>
        {workspaces.map((workspace) => (
          <WorkspaceShares
            key={workspace.id}
            workspaceId={workspace.id}
            workspaceName={workspace.name}
            active={workspace.id === activeWorkspaceId}
            collections={trees[workspace.id] ?? []}
            anonKey={anonKey}
            enabled={configured && settings.supabaseReady}
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
        <Note tone="warning">{t("api.collab.tokenIsACredential")}</Note>
        <Note>{t("api.collab.secretsNote")}</Note>
        <Note>{t("api.collab.conflictNote")}</Note>
      </Group>

      <Group title={t("api.collab.joinTitle")}>
        <JoinBlock />
      </Group>
    </Panel>
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
  anonKey,
  enabled,
}: {
  workspaceId: string;
  workspaceName: string;
  active: boolean;
  collections: ApiCollection[];
  anonKey: string;
  enabled: boolean;
}) {
  const t = useT();
  // Selected as the whole list and filtered here: a selector that returns a fresh array on every
  // call never matches its own previous snapshot, and `useSyncExternalStore` re-renders forever.
  const allShares = useCollabStore((s) => s.shares);
  const shares = useMemo(
    () => allShares.filter((share) => share.workspace_id === workspaceId),
    [allShares, workspaceId],
  );
  const startSharing = useCollabStore((s) => s.startSharing);
  const setActiveWorkspace = useWorkspaceStore((s) => s.setActiveWorkspace);
  const pushToast = useToastStore((s) => s.pushToast);

  const [picking, setPicking] = useState(false);
  const [choice, setChoice] = useState("");

  const shareable = useMemo(() => {
    const already = new Set(shares.map((share) => share.collection_id));
    return collections.filter((collection) => !already.has(collection.id));
  }, [collections, shares]);

  const confirmShare = async () => {
    const collection = collections.find((c) => c.id === choice);
    if (!collection) return;
    // Sharing writes against the *active* workspace's collection ids on the backend, and the first
    // upload has to be able to read the tree — switching first is what makes both true.
    if (!active) setActiveWorkspace(workspaceId);
    const token = await startSharing(collection.id, collection.name);
    if (token === null) return;
    setPicking(false);
    setChoice("");
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
          disabled={!enabled || shareable.length === 0}
          title={shareable.length === 0 ? t("api.collab.nothingLeftToShare") : undefined}
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
          <GhostButton onClick={() => void confirmShare()} disabled={choice === ""}>
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
            <ShareRow key={share.collection_id} collectionId={share.collection_id} anonKey={anonKey} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One shared collection
// ---------------------------------------------------------------------------

function ShareRow({ collectionId, anonKey }: { collectionId: string; anonKey: string }) {
  const t = useT();
  const share = useCollabStore((s) => s.shareFor(collectionId));
  const health = useCollabStore((s) => s.health(collectionId));
  const tokenFor = useCollabStore((s) => s.tokenFor);
  const rotate = useCollabStore((s) => s.rotate);
  const leave = useCollabStore((s) => s.leave);
  const settings = useApiStore((s) => s.settings);
  const pushToast = useToastStore((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

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
      await navigator.clipboard.writeText(
        encodeInvite({ url: settings.supabaseUrl, key: anonKey, token, name }),
      );
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

  return (
    <div className="rounded-md bg-black/[0.02] px-2 py-1.5 dark:bg-white/[0.03]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-text)]">{name}</span>
        {/* The host sees which of their projects a share is on — theirs to know. A member is told
            *how* they are connected, never *where*: the project, its URL and its key belong to
            whoever invited them, and a guest has no business reading them off a settings pane. */}
        {isOwner ? (
          share.project_url !== "" &&
          share.project_url !== settings.supabaseUrl && (
            <Tag icon={Server}>{projectHost(share.project_url)}</Tag>
          )
        ) : (
          <Tag icon={Link2}>{t("api.collab.viaInvitation")}</Tag>
        )}
        {share.role === "owner" ? (
          <Tag icon={Crown}>{t("api.collab.roleOwner")}</Tag>
        ) : (
          <Tag>{t("api.collab.roleMember")}</Tag>
        )}
        {share.conflicts > 0 && (
          <Tag tone="warning" icon={ShieldAlert}>
            {t("api.collab.nConflicts", { n: String(share.conflicts) })}
          </Tag>
        )}
      </div>

      <div className="mt-1 flex flex-wrap items-center justify-between gap-1.5">
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
        {/* A member is a guest on somebody else's project. They can move changes in and out, and
            they can walk away — that is the whole of it. Handing out the invitation would be
            re-sharing a project that is not theirs (the code carries its URL and key), and rotating
            the token would lock out the person whose project it is, along with everyone else. */}
        <Actions>
          {isOwner && (
            <GhostButton onClick={copyInvite} disabled={busy} title={t("api.collab.copyInviteHint")}>
              <ClipboardCopy size={12} />
              {t("api.collab.copyInvite")}
            </GhostButton>
          )}
          <GhostButton onClick={syncOne} disabled={busy}>
            <RefreshCw size={12} />
            {t("api.collab.syncNow")}
          </GhostButton>
          {isOwner && (
            <GhostButton onClick={rotateCode} disabled={busy}>
              <KeyRound size={12} />
              {t("api.collab.rotate")}
            </GhostButton>
          )}
          <GhostButton onClick={stop} disabled={busy}>
            {isOwner ? t("api.collab.leave") : t("api.collab.disconnect")}
          </GhostButton>
        </Actions>
      </div>
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
      // The key is stored *for the project the invitation names*, and the share records that
      // project as its own. Nothing here touches the default above — that is the project this
      // person shares their own collections from, and an invitation to someone else's is not a
      // reason to redefine it. It used to be, which meant the second invitation silently cut off
      // every collection accepted before it.
      // The key is stored against the project the invitation names, and the share records that
      // project as its own. Nothing is written to the settings above: that field is *this* person's
      // project, the one they host their own collections on, and a guest never becomes the owner of
      // somebody else's — putting the host's URL there would put their server on a settings pane
      // belonging to someone who has no business reading it.

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
