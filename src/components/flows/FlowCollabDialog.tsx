import { useEffect, useMemo, useState } from "react";
import { Copy, LogOut, Plus, RefreshCw, Users } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import {
  ConnectionRow,
  NewConnection,
  ProjectSteps,
  RECHECK_AFTER_MS,
  type ConnectionLabels,
} from "../api/CollaborationPanel";
import { Group, Note, Status } from "../api/settingsChrome";
import { ActiveUnderline } from "../common/ActivePill";
import { Button, iconButtonClass } from "../common/Button";
import { fieldClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import { projectHost, projectRef } from "../../lib/api/projects";
import { supabaseInstallSql } from "../../lib/tauri/apiCommands";
import type { FlowShareRow } from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { confirmAction } from "../../state/confirmStore";
import { flowConnections, useFlowShareStore, type FlowCollabTab } from "../../state/flowShareStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";

const TABS: { id: FlowCollabTab; labelKey: TranslationKey }[] = [
  { id: "project", labelKey: "flows.collab.tabProject" },
  { id: "shares", labelKey: "flows.collab.tabShares" },
  { id: "join", labelKey: "flows.collab.tabJoin" },
];

/**
 * Flujos' own Collaboration window — the API client's pane, for flows: the Supabase projects this
 * app hosts flows on, the flows shared from or into this computer, and accepting an invitation.
 *
 * **The projects are Flujos' own** (`flowShareStore.saved`), set up here and nowhere else; the API
 * client keeps its list in its own settings. The rows, the form and the three setup links are the
 * API pane's components, so a project is connected the same way in both places — and connecting
 * the same project in both shares one stored key, which neither pane deletes while the other uses it.
 */
export function FlowCollabDialog() {
  const t = useT();
  const tab = useFlowShareStore((s) => s.collab);
  if (!tab) return null;
  const close = () => useFlowShareStore.getState().closeCollab();
  return (
    <ApiModal icon={Users} title={t("flows.collab.title")} width="max-w-xl" onClose={close}>
      <div className="p-4">
        <div role="tablist" className={`${underlineStripClass} mb-3`}>
          {TABS.map(({ id, labelKey }) => {
            const active = tab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => useFlowShareStore.getState().openCollab(id)}
                className={underlineTabClass(active)}
              >
                {t(labelKey)}
                {active && <ActiveUnderline layoutId="cf-flows-collab-tab-underline" />}
              </button>
            );
          })}
        </div>
        {tab === "project" && <ProjectPane />}
        {tab === "shares" && <SharesPane />}
        {tab === "join" && <JoinPane onJoined={close} />}
      </div>
    </ApiModal>
  );
}

/** The projects Flujos hosts on: one row each, the form for another, and the setup links. */
function ProjectPane() {
  const t = useT();
  const saved = useFlowShareStore((s) => s.saved);
  const shares = useFlowShareStore((s) => s.shares);
  const keys = useFlowShareStore((s) => s.keys);
  const [adding, setAdding] = useState(false);
  const connections = useMemo(() => flowConnections({ saved, shares, keys }), [saved, shares, keys]);
  const store = useFlowShareStore.getState;

  const labels = useMemo<ConnectionLabels>(
    () => ({
      one: t("flows.collab.oneFlow"),
      many: (n) => t("flows.collab.nFlows", { n: String(n) }),
      forgetBlocked: t("flows.collab.forgetBlocked"),
      editHint: t("flows.collab.editHint"),
      forgetConfirm: (ref) => t("flows.collab.forgetConfirm", { ref }),
    }),
    [t],
  );

  useEffect(() => {
    void (async () => {
      await store().loadProjects();
      await store().refresh();
      await store().refreshKeys();
    })();
  }, [store]);

  // Stale verdicts are re-asked quietly on open, as the API client's pane does — "connected" is
  // never a claim nobody has checked since the project was set up.
  const keyFingerprint = keys.join(",");
  useEffect(() => {
    for (const connection of connections) {
      if (!connection.hasKey) continue;
      const age = connection.checkedAt === "" ? Infinity : Date.now() - Date.parse(connection.checkedAt);
      if (age >= RECHECK_AFTER_MS) void store().verify(connection.url, true);
    }
    // Network calls, keyed on what actually means "something new to ask" (see the API pane).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length, keyFingerprint]);

  const copySql = async (url?: string) => {
    try {
      await navigator.clipboard.writeText(await supabaseInstallSql(url));
      pushSuccessToast(t("api.collab.sqlCopied"));
    } catch (error) {
      pushErrorToast(String(error));
    }
  };

  return (
    <>
      {connections.length === 0 && !adding && <Note>{t("flows.collab.noConnections")}</Note>}
      <div className="flex flex-col divide-y divide-[var(--cf-border)]">
        {connections.map((connection) => (
          <ConnectionRow
            key={projectHost(connection.url)}
            connection={connection}
            labels={labels}
            onCheck={(silent) => store().verify(connection.url, silent)}
            onConnect={(url, key) => store().connect(url, key)}
            onForget={() => store().forgetProject(connection.url)}
            onCopySql={() => copySql(connection.url)}
          />
        ))}
      </div>
      {adding ? (
        <NewConnection
          taken={connections.map((connection) => projectHost(connection.url))}
          onConnect={(url, key) => store().connect(url, key)}
          onCopySql={() => copySql()}
          onDone={() => setAdding(false)}
        />
      ) : (
        <div className="mt-2 flex justify-end">
          <Button variant={connections.length === 0 ? "primary" : "secondary"} size="sm" onClick={() => setAdding(true)}>
            <Plus size={13} />
            {t("api.collab.addConnection")}
          </Button>
        </div>
      )}
      <Group title={t("api.collab.moreInfo")} collapsible defaultOpen={false}>
        <ProjectSteps />
        <Note>{t("flows.collab.about")}</Note>
      </Group>
    </>
  );
}

/** Every flow shared from or into this computer, across workspaces: how it is going, its code,
 *  a round now, and leaving. Sharing one starts in its editor. */
function SharesPane() {
  const t = useT();
  const shares = useFlowShareStore((s) => s.shares);
  const rows = useMemo(() => Object.values(shares).sort((a, b) => a.name.localeCompare(b.name)), [shares]);
  useEffect(() => {
    void useFlowShareStore.getState().refresh();
  }, []);
  if (rows.length === 0) return <Note>{t("flows.collab.noShares")}</Note>;
  return (
    <div className="flex flex-col divide-y divide-[var(--cf-border)]">
      {rows.map((row) => (
        <ShareLine key={row.flowId} row={row} />
      ))}
    </div>
  );
}

function ShareLine({ row }: { row: FlowShareRow }) {
  const t = useT();
  const here = useFlowsStore((s) => s.flows.some((flow) => flow.id === row.flowId));
  const [busy, setBusy] = useState(false);
  const store = useFlowShareStore.getState;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };
  const copyCode = () =>
    run(async () => {
      const code = await store().inviteCode(row.flowId);
      if (!code) return pushErrorToast(t("flows.collab.noCode"));
      await navigator.clipboard.writeText(code);
      pushSuccessToast(t("flows.share.copied"));
    });
  const leave = () =>
    run(async () => {
      if (!(await confirmAction(t("flows.share.leaveConfirm", { name: row.name }), true, t("flows.share.leave")))) return;
      await store().leave(row.flowId);
    });

  return (
    <div className="flex items-center gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        {here ? (
          <button
            type="button"
            className="block max-w-full truncate text-left text-[12.5px] font-medium text-[var(--cf-text)] hover:underline"
            onClick={() => {
              void useFlowsStore.getState().openFlow(row.flowId);
              store().closeCollab();
            }}
          >
            {row.name}
          </button>
        ) : (
          <span className="block truncate text-[12.5px] font-medium text-[var(--cf-text)]" title={t("flows.collab.otherWorkspace")}>
            {row.name}
          </span>
        )}
        <span className="block truncate text-[11px] text-[var(--cf-text-muted)]" title={row.lastError || projectHost(row.projectUrl)}>
          {projectRef(row.projectUrl)} · {t(row.role === "owner" ? "flows.share.host" : "flows.share.member")}
        </span>
      </div>
      {row.conflict ? (
        <Status tone="warning">{t("flows.share.conflictChip")}</Status>
      ) : row.lastError ? (
        <Status tone="warning">{t("flows.collab.failing")}</Status>
      ) : row.syncedAt ? (
        <Status tone="success">{t("flows.share.syncedAt", { at: new Date(row.syncedAt).toLocaleTimeString() })}</Status>
      ) : null}
      <button
        type="button"
        className={iconButtonClass({ size: "sm" })}
        disabled={busy}
        title={t("flows.collab.copyCode")}
        aria-label={t("flows.collab.copyCode")}
        onClick={() => void copyCode()}
      >
        <Copy size={13} />
      </button>
      <button
        type="button"
        className={iconButtonClass({ size: "sm" })}
        disabled={busy || !!row.conflict}
        title={t("flows.share.syncNow")}
        aria-label={t("flows.share.syncNow")}
        onClick={() => void run(() => store().syncNow(row.flowId))}
      >
        <RefreshCw size={13} />
      </button>
      <button
        type="button"
        className={iconButtonClass({ size: "sm" })}
        disabled={busy}
        title={t("flows.share.leave")}
        aria-label={t("flows.share.leave")}
        onClick={() => void leave()}
      >
        <LogOut size={13} />
      </button>
    </div>
  );
}

/** Accepting an invitation: the flow lands in this workspace's root, paused and not reviewed. */
function JoinPane({ onJoined }: { onJoined: () => void }) {
  const t = useT();
  const workspaceId = useFlowsStore((s) => s.workspaceId);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const join = async () => {
    if (!workspaceId || !code.trim()) return;
    setBusy(true);
    const id = await useFlowShareStore.getState().join(code, workspaceId, null);
    setBusy(false);
    if (!id) return;
    await useFlowsStore.getState().refresh();
    await useFlowsStore.getState().openFlow(id);
    onJoined();
  };
  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus
        rows={3}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="codeflow:…"
        className={fieldClass({ size: "sm", className: "h-auto resize-none py-1.5 font-mono text-[11px]" })}
        aria-label={t("flows.share.code")}
      />
      <Note>{t("flows.collab.joinHint")}</Note>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" disabled={!code.trim() || busy} onClick={() => void join()}>
          {t("flows.share.join")}
        </Button>
      </div>
    </div>
  );
}
