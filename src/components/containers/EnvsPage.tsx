import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ArchiveRestore,
  ArrowUpFromLine,
  Copy,
  ExternalLink,
  FileText,
  GitBranch,
  Hammer,
  Loader2,
  Plus,
  ScrollText,
  Square,
  TerminalSquare,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { RowAction, StateDot, stateTone, useInterval } from "./containerBits";
import { runtimeLabel } from "./containerActions";
import { DataTable, Dialog, EmptyLine, LiveMark, LoadingLine, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { EnvCreateDialog } from "./EnvCreateDialog";
import { hostPortLabel, initChangedCommands, isDirtyRefusal, portUrl, publishedPorts, runsAsJob, statusTone } from "./envsModel";
import {
  containersEnvsApproveInit,
  containersEnvsList,
  containersEnvsPrepare,
  containersEnvsRemove,
  containersEnvsRestore,
  containersEnvsSnapshot,
  containersEnvsStop,
  containersEnvsUp,
  containersEnvsWorktreeState,
} from "../../lib/tauri/containersEnvsCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { confirmAction, useConfirmStore } from "../../state/confirmStore";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useTerminalStore } from "../../state/terminalStore";
import { useUiStore } from "../../state/uiStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { EnvView, EnvWarning, EnvWorktreeState } from "../../types/containersEnvs";
import type { RuntimeId, RuntimeInfo } from "../../types/containers";

/**
 * Contenedores › Entornos: several branches of one system running side by side — each in its own
 * worktree, under its own Compose project, with every published port moved by the environment's
 * offset (see `src-tauri/src/containers/envs`). Listed with what the engine says right now, the
 * port map as links, and the lifecycle: start (a Compose stack's `up` runs as a job of the jobs
 * panel), stop, rebuild, logs, a terminal in the checkout, clone to another branch, volume
 * snapshots, remove.
 */

type Busy = Record<string, TranslationKey | undefined>;
/** What the last start of a devcontainer said — `initializeCommand`, the build, the lifecycle commands. */
type UpLog = { text: string; ok: boolean };

const STATUS_LABEL: Record<EnvView["status"], TranslationKey> = {
  running: "containers.envs.status.running",
  partial: "containers.envs.status.partial",
  stopped: "containers.envs.status.stopped",
  absent: "containers.envs.status.absent",
  unknown: "containers.envs.status.unknown",
};

export function warningText(t: ReturnType<typeof useT>, warning: EnvWarning): string {
  switch (warning.code) {
    case "sharedVolume":
      return t("containers.envs.warn.sharedVolume", { name: warning.subject });
    case "sharedNetwork":
      return t("containers.envs.warn.sharedNetwork", { name: warning.subject });
    case "hostNetwork":
      return t("containers.envs.warn.hostNetwork", { name: warning.subject });
    case "unsupported":
      return t("containers.envs.warn.unsupported", { name: warning.subject });
    case "cliNoOffset":
      return t("containers.envs.warn.cliNoOffset");
    case "noPorts":
      return t("containers.envs.warn.noPorts");
    case "hardening":
      return t("containers.envs.warn.hardening", { name: warning.subject });
    case "dropped":
      return t("containers.envs.warn.dropped", { name: warning.subject });
    case "withoutFeatures":
      return t("containers.envs.warn.withoutFeatures", { name: warning.subject });
    default:
      return `${warning.code}: ${warning.subject}`;
  }
}

export function EnvsPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const refreshList = useContainersStore((s) => s.refreshList);
  const visible = useUiStore((s) => s.activeView === "containers");
  const startJob = useContainersJobsStore((s) => s.start);
  const [envs, setEnvs] = useState<EnvView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Busy>({});
  const [creating, setCreating] = useState(false);
  const [cloning, setCloning] = useState<EnvView | null>(null);
  const [removing, setRemoving] = useState<EnvView | null>(null);
  const [upLogs, setUpLogs] = useState<Record<string, UpLog>>({});
  const [showingLog, setShowingLog] = useState<EnvView | null>(null);
  const ctr = runtime.id === "ctr";

  const load = useCallback(async () => {
    try {
      setEnvs(await containersEnvsList());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useInterval(() => void load(), 5000, visible);

  const mine = useMemo(() => (envs ?? []).filter((e) => e.runtime === runtime.id), [envs, runtime.id]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return mine;
    return mine.filter((e) => [e.repoName, e.branch, e.composeProject, ...e.services.map((s) => s.name)].some((v) => v.toLowerCase().includes(needle)));
  }, [mine, query]);

  /** One action on one environment, its label as the row's spinner; the list is read again after. */
  const work = async (env: EnvView, label: TranslationKey, run: () => Promise<string | void>) => {
    setBusy((b) => ({ ...b, [env.id]: label }));
    try {
      const said = await run();
      if (said) pushSuccessToast(said);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy((b) => ({ ...b, [env.id]: undefined }));
      void load();
      void refreshList(runtime.id, "containers");
    }
  };

  const start = (env: EnvView, rebuild: boolean) =>
    void work(env, rebuild ? "containers.envs.rebuilding" : "containers.envs.starting", async () => {
      if (runsAsJob(env)) {
        const launch = await containersEnvsPrepare(env.id);
        void startJob(
          t(rebuild ? "containers.envs.job.rebuild" : "containers.envs.job.up", { name: launch.project }),
          { kind: rebuild ? "composeBuild" : "composeUp", runtime: env.runtime, context: env.context, target: launch.project, projectDir: launch.projectDir, configFiles: launch.configFiles },
          { refresh: ["containers", "volumes", "networks", "images"], done: t("containers.envs.done.up", { name: launch.project }) },
        );
        return;
      }
      return upDevcontainer(env, rebuild);
    });

  /** `up` of a devcontainer, its output kept for the row. A branch whose `initializeCommand` is not
   *  the one approved is asked about first — the exact commands listed — and nothing runs on this
   *  computer without a yes. */
  const upDevcontainer = async (env: EnvView, rebuild: boolean): Promise<string | void> => {
    try {
      const result = await containersEnvsUp(env.id, rebuild);
      setUpLogs((logs) => ({ ...logs, [env.id]: { text: result.log, ok: true } }));
      return t("containers.envs.done.up", { name: env.composeProject });
    } catch (e) {
      const commands = initChangedCommands(e);
      if (commands) {
        const yes = await useConfirmStore.getState().ask({ message: t("containers.envs.init.confirm", { name: env.composeProject }), danger: true, confirmLabel: t("containers.envs.init.run"), items: commands });
        if (!yes) return;
        await containersEnvsApproveInit(env.id, commands);
        return upDevcontainer(env, rebuild);
      }
      setUpLogs((logs) => ({ ...logs, [env.id]: { text: String(e), ok: false } }));
      throw e;
    }
  };

  const stop = (env: EnvView) =>
    void work(env, "containers.envs.stopping", async () => {
      await containersEnvsStop(env.id);
      return t("containers.envs.done.stop", { name: env.composeProject });
    });

  /** A devcontainer of one container follows that container; anything else, its Compose project. */
  const logs = (env: EnvView) => {
    const title = t("containers.envs.job.logs", { name: env.composeProject });
    const request =
      env.config.kind === "devcontainer" && env.services.length === 1
        ? { kind: "logs" as const, runtime: env.runtime, context: env.context, target: env.services[0].id, tail: 300 }
        : { kind: "projectLogs" as const, runtime: env.runtime, context: env.context, target: env.composeProject, tail: 300 };
    void startJob(title, request, { follow: true });
  };

  const terminal = (env: EnvView) => {
    void useTerminalStore
      .getState()
      .openNew(env.projectId, env.worktreePath, { title: env.branch })
      .catch((e) => pushErrorToast(String(e)));
  };

  const snapshot = async (env: EnvView) => {
    const folder = await openDialog({ directory: true, title: t("containers.envs.snapshot.pick") });
    if (typeof folder !== "string") return;
    void work(env, "containers.envs.snapshotting", async () => {
      const done = await containersEnvsSnapshot(env.id, folder);
      return t("containers.envs.done.snapshot", { count: done.volumes.length, folder: done.folder });
    });
  };

  const restore = async (env: EnvView) => {
    if (!(await confirmAction(t("containers.envs.restore.confirm", { name: env.composeProject }), true, t("containers.envs.action.restore")))) return;
    const folder = await openDialog({ directory: true, title: t("containers.envs.restore.pick") });
    if (typeof folder !== "string") return;
    void work(env, "containers.envs.restoring", async () => {
      const restored = await containersEnvsRestore(env.id, folder);
      return t("containers.envs.done.restore", { count: restored.length });
    });
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.envs.title")} sub={mine.length ? String(mine.length) : t("containers.envs.sub")}>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={!runtime.running || ctr}>
          <Plus size={13} />
          {t("containers.envs.new")}
        </Button>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.envs.search")} />
        <div className="flex-1" />
        {runtime.running && <LiveMark />}
      </PageToolbar>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&_table]:table-fixed">
        {ctr ? (
          <EmptyLine>{t("containers.envs.unsupported")}</EmptyLine>
        ) : error ? (
          <EmptyLine>{error}</EmptyLine>
        ) : envs === null ? (
          <LoadingLine />
        ) : shown.length === 0 ? (
          <EmptyLine>{mine.length ? t("containers.envs.noMatch") : t("containers.envs.none")}</EmptyLine>
        ) : (
          <DataTable minWidth={860}>
            <thead>
              <tr>
                <Th width={220}>{t("containers.envs.col.env")}</Th>
                <Th width={150}>{t("containers.m.col.state")}</Th>
                <Th>{t("containers.envs.col.ports")}</Th>
                <Th width={180}>{t("containers.envs.col.services")}</Th>
                <Th align="right" width={250}>
                  {t("containers.m.col.actions")}
                </Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((env) => (
                <EnvRow
                  key={env.id}
                  env={env}
                  busy={busy[env.id]}
                  runtimeRunning={runtime.running}
                  onStart={() => start(env, false)}
                  onRebuild={() => start(env, true)}
                  onStop={() => stop(env)}
                  onLogs={() => logs(env)}
                  onTerminal={() => terminal(env)}
                  onClone={() => setCloning(env)}
                  onSnapshot={() => void snapshot(env)}
                  onRestore={() => void restore(env)}
                  onRemove={() => setRemoving(env)}
                  onOutput={upLogs[env.id] ? () => setShowingLog(env) : undefined}
                  outputFailed={upLogs[env.id]?.ok === false}
                />
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
      {(creating || cloning) && (
        <EnvCreateDialog
          runtime={runtime}
          context={cloning?.context ?? context}
          cloneFrom={cloning}
          onClose={() => {
            setCreating(false);
            setCloning(null);
          }}
          onCreated={(env, startNow) => {
            setCreating(false);
            setCloning(null);
            void load();
            if (startNow) start(env, false);
          }}
        />
      )}
      {showingLog && upLogs[showingLog.id] && (
        <Dialog title={t("containers.envs.output.title", { name: showingLog.composeProject })} onClose={() => setShowingLog(null)} width={720}>
          <pre className={`whitespace-pre-wrap break-all font-mono text-[11.5px] leading-snug ${upLogs[showingLog.id].ok ? "text-[var(--cf-text)]" : "text-[var(--cf-danger)]"}`}>
            {upLogs[showingLog.id].text.trim() || t("containers.envs.output.empty")}
          </pre>
        </Dialog>
      )}
      {removing && (
        <RemoveEnvDialog
          env={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoving(null);
            void load();
            void refreshList(runtime.id, "containers");
          }}
        />
      )}
    </div>
  );
}

function EnvRow({
  env,
  busy,
  runtimeRunning,
  onStart,
  onRebuild,
  onStop,
  onLogs,
  onTerminal,
  onClone,
  onSnapshot,
  onRestore,
  onRemove,
  onOutput,
  outputFailed,
}: {
  env: EnvView;
  busy: TranslationKey | undefined;
  runtimeRunning: boolean;
  onStart: () => void;
  onRebuild: () => void;
  onStop: () => void;
  onLogs: () => void;
  onTerminal: () => void;
  onClone: () => void;
  onSnapshot: () => void;
  onRestore: () => void;
  onRemove: () => void;
  /** The last start's output, when this session started it. */
  onOutput?: () => void;
  outputFailed?: boolean;
}) {
  const t = useT();
  const ports = publishedPorts(env);
  const running = env.status === "running" || env.status === "partial";
  const locked = !!busy || !runtimeRunning;
  const gone = !env.worktreeExists;
  const kindLabel = env.config.kind === "compose" ? "compose" : env.config.mode === "cli" ? "devcontainer · CLI" : "devcontainer";
  return (
    <tr className={trClass(false)}>
      <Td tall>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <GitBranch size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
            <span className="truncate font-semibold text-[var(--cf-text)]" title={env.branch}>
              {env.branch}
            </span>
          </span>
          <span className="truncate text-[11px] text-[var(--cf-text-muted)]" title={`${env.repoName} · ${env.worktreePath}`}>
            {env.repoName} · <span className="font-mono">{env.composeProject}</span>
          </span>
          <span className="flex items-center gap-1.5 text-[10.5px] text-[var(--cf-text-faint)]">
            <span>{kindLabel}</span>
            <span>·</span>
            <span title={t("containers.envs.offsetHint")}>{t("containers.envs.offsetShort", { offset: env.portOffset })}</span>
          </span>
          {gone && (
            <span className="flex items-center gap-1 text-[11px] text-[var(--cf-danger)]">
              <TriangleAlert size={11} />
              {t("containers.envs.worktreeGone")}
            </span>
          )}
        </div>
      </Td>
      <Td>
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={env.problem ?? undefined}>
          {busy ? <Loader2 size={11} className="animate-spin text-[var(--cf-accent)]" /> : <StateDot tone={statusTone(env.status)} />}
          <span className={running ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}>{busy ? t(busy) : t(STATUS_LABEL[env.status])}</span>
        </span>
      </Td>
      <Td tall>
        {ports.length === 0 ? (
          <span className="text-[var(--cf-text-faint)]" title={t("containers.envs.portsLater")}>
            {env.ports.length === 0 ? t("containers.envs.portsUnknown") : "—"}
          </span>
        ) : (
          <span className="flex min-w-0 flex-wrap gap-1">
            {ports.map((port) => {
              const url = portUrl(port);
              const label = `${port.service} ${hostPortLabel(port)}→${port.target}${port.protocol === "udp" ? "/udp" : ""}`;
              const from = port.base != null && port.base !== port.host ? t("containers.envs.portFrom", { port: port.base }) : "";
              return url ? (
                <button
                  key={`${port.service}-${port.target}-${port.host}`}
                  onClick={() => void openExternalUrl(url)}
                  title={[t("containers.m.openPort", { url }), from].filter(Boolean).join("\n")}
                  className="inline-flex items-center gap-0.5 rounded-[5px] border border-[var(--cf-border)] px-1.5 font-mono text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                >
                  {label}
                  <ExternalLink size={9} />
                </button>
              ) : (
                <span key={`${port.service}-${port.target}-${port.host}`} title={from} className="inline-flex items-center rounded-[5px] border border-[var(--cf-border)] px-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
                  {label}
                </span>
              );
            })}
          </span>
        )}
        {env.warnings.length > 0 && (
          <span className="mt-1 flex items-start gap-1 text-[11px] text-[var(--cf-warning)]" title={env.warnings.map((w) => warningText(t, w)).join("\n")}>
            <TriangleAlert size={11} className="mt-[2px] shrink-0" />
            <span className="truncate">{warningText(t, env.warnings[0])}{env.warnings.length > 1 ? ` (+${env.warnings.length - 1})` : ""}</span>
          </span>
        )}
      </Td>
      <Td tall>
        {env.services.length === 0 ? (
          <span className="text-[var(--cf-text-faint)]">—</span>
        ) : (
          <span className="flex min-w-0 flex-col gap-0.5">
            {env.services.slice(0, 5).map((s) => (
              <span key={s.id} className="flex min-w-0 items-center gap-1.5 text-[11.5px]">
                <StateDot tone={stateTone(s.state, s.health)} title={s.state} />
                <span className="truncate text-[var(--cf-text-muted)]">{s.name}</span>
              </span>
            ))}
            {env.services.length > 5 && <span className="text-[11px] text-[var(--cf-text-faint)]">+{env.services.length - 5}</span>}
          </span>
        )}
      </Td>
      <Td className="w-[250px]">
        <div className="flex flex-wrap items-center justify-end gap-0.5">
          <RowAction label={running ? t("containers.envs.action.apply") : t("containers.envs.action.start")} disabled={locked || gone} onClick={onStart}>
            <ArrowUpFromLine size={12} />
          </RowAction>
          <RowAction label={t("containers.envs.action.stop")} disabled={locked || !running} onClick={onStop}>
            <Square size={12} />
          </RowAction>
          <RowAction label={t("containers.envs.action.rebuild")} disabled={locked || gone} onClick={onRebuild}>
            <Hammer size={12} />
          </RowAction>
          <RowAction label={t("containers.tab.logs")} disabled={!runtimeRunning || env.services.length === 0} onClick={onLogs}>
            <ScrollText size={12} />
          </RowAction>
          {onOutput && (
            <RowAction label={t(outputFailed ? "containers.envs.action.outputFailed" : "containers.envs.action.output")} danger={outputFailed} onClick={onOutput}>
              <FileText size={12} />
            </RowAction>
          )}
          <RowAction label={t("containers.envs.action.terminal")} disabled={gone} onClick={onTerminal}>
            <TerminalSquare size={12} />
          </RowAction>
          <RowAction label={t("containers.envs.action.clone")} disabled={!!busy} onClick={onClone}>
            <Copy size={12} />
          </RowAction>
          <RowAction label={t("containers.envs.action.snapshot")} disabled={locked} onClick={onSnapshot}>
            <Archive size={12} />
          </RowAction>
          <RowAction label={t("containers.envs.action.restore")} disabled={locked} onClick={onRestore}>
            <ArchiveRestore size={12} />
          </RowAction>
          <RowAction label={t("containers.envs.action.remove")} danger disabled={!!busy} onClick={onRemove}>
            <Trash2 size={12} />
          </RowAction>
        </div>
      </Td>
    </tr>
  );
}

/** Taking an environment away: its containers always, its volumes and its checkout when ticked — and
 *  a checkout with uncommitted changes only with a second, explicit tick. */
function RemoveEnvDialog({ env, onClose, onRemoved }: { env: EnvView; onClose: () => void; onRemoved: () => void }) {
  const t = useT();
  const [state, setState] = useState<EnvWorktreeState | null>(null);
  const [volumes, setVolumes] = useState(false);
  const [worktree, setWorktree] = useState(false);
  const [force, setForce] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void containersEnvsWorktreeState(env.id)
      .then(setState)
      .catch(() => setState({ exists: env.worktreeExists, dirty: true, created: env.worktreeCreated }));
  }, [env.id, env.worktreeExists, env.worktreeCreated]);
  const canRemoveWorktree = !!state?.created && state.exists;
  const blocked = worktree && !!state?.dirty && !force;

  const remove = async () => {
    setWorking(true);
    setError(null);
    try {
      await containersEnvsRemove(env.id, volumes, worktree && canRemoveWorktree, force);
      pushSuccessToast(t("containers.envs.done.remove", { name: env.composeProject }));
      onRemoved();
    } catch (e) {
      setError(isDirtyRefusal(e) ? t("containers.envs.remove.dirtyRefused") : String(e));
      setWorking(false);
    }
  };

  return (
    <Dialog
      title={t("containers.envs.remove.title", { name: env.composeProject })}
      onClose={onClose}
      width={520}
      footer={
        <>
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={working || blocked || state === null}>
            {working && <Loader2 size={12} className="animate-spin" />}
            {t("containers.envs.action.remove")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-[12.5px] text-[var(--cf-text)]">
        <p className="text-[var(--cf-text-muted)]">{t("containers.envs.remove.body", { branch: env.branch, runtime: runtimeLabel(env.runtime as RuntimeId, t) })}</p>
        <label className="flex items-start gap-2">
          <Checkbox checked={volumes} onChange={setVolumes} className="mt-[2px]" />
          <span>
            {t("containers.envs.remove.volumes")}
            <span className="block text-[11px] text-[var(--cf-text-faint)]">{t("containers.envs.remove.volumesHint")}</span>
          </span>
        </label>
        <label className={`flex items-start gap-2 ${canRemoveWorktree ? "" : "opacity-60"}`}>
          <Checkbox checked={worktree && canRemoveWorktree} onChange={setWorktree} disabled={!canRemoveWorktree} className="mt-[2px]" />
          <span>
            {t("containers.envs.remove.worktree")}
            <span className="block break-all font-mono text-[11px] text-[var(--cf-text-faint)]">{env.worktreePath}</span>
            {state && !state.created && <span className="block text-[11px] text-[var(--cf-text-faint)]">{t("containers.envs.remove.notOurs")}</span>}
          </span>
        </label>
        {worktree && state?.dirty && (
          <div className="flex flex-col gap-2 rounded-md border border-[var(--cf-danger)] p-2.5">
            <span className="flex items-center gap-1.5 text-[var(--cf-danger)]">
              <TriangleAlert size={12} />
              {t("containers.envs.remove.dirty")}
            </span>
            <label className="flex items-center gap-2">
              <Checkbox checked={force} onChange={setForce} />
              <span>{t("containers.envs.remove.force")}</span>
            </label>
          </div>
        )}
        {error && <p className="text-[12px] text-[var(--cf-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}
