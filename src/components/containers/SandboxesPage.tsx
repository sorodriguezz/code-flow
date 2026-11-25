import { useCallback, useEffect, useMemo, useState } from "react";
import { Brush, Loader2, Plus, RefreshCw } from "lucide-react";
import { Button } from "../common/Button";
import { StateDot } from "./containerBits";
import { DataTable, EmptyLine, LoadingLine, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { NewSandboxDialog } from "./NewSandboxDialog";
import { SandboxDetail } from "./SandboxDetail";
import { sandboxLabel, statusTone } from "./sandboxModel";
import { useSandboxFocus } from "./sandboxFocus";
import { containersSandboxCleanup, containersSandboxList } from "../../lib/tauri/containersSandboxCommands";
import { useContainersStore } from "../../state/containersStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { RuntimeInfo } from "../../types/containers";
import type { SandboxView } from "../../types/containersSandbox";

/**
 * «Sandboxes»: the agent sandboxes made on this engine — what each is for (its task or story), its
 * branch, its state, its limits, its network policy and how it stood against the workspace's
 * security policy. A row opens its detail: the evidence timeline, a box to run a command in it,
 * and destroying it.
 *
 * The orphan cleanup is offered here, and run once when the page opens: a container with the
 * sandbox label whose sandbox is gone (the app killed mid-creation, a row forgotten) is removed.
 */
export function SandboxesPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const openId = useSandboxFocus((s) => s.openId);
  const version = useSandboxFocus((s) => s.version);
  const open = useSandboxFocus((s) => s.open);
  const [rows, setRows] = useState<SandboxView[] | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [cleaning, setCleaning] = useState(false);

  const reload = useCallback(() => {
    void containersSandboxList(workspaceId)
      .then(setRows)
      .catch((e) => {
        setRows([]);
        pushErrorToast(String(e));
      });
  }, [workspaceId]);

  useEffect(() => reload(), [reload, version]);

  // Once per visit: quietly remove what an earlier session left behind.
  useEffect(() => {
    if (!runtime.running || runtime.id === "ctr") return;
    void containersSandboxCleanup(runtime.id, context).catch(() => {});
  }, [runtime.id, runtime.running, context]);

  const here = useMemo(() => (rows ?? []).filter((row) => row.runtime === runtime.id && (row.context || null) === (context || null)), [rows, runtime.id, context]);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return here;
    return here.filter((row) => [sandboxLabel(row), row.branch, row.image, row.projectName, row.status].some((v) => v.toLowerCase().includes(needle)));
  }, [here, query]);
  const openRow = openId ? (rows ?? []).find((row) => row.id === openId) : undefined;

  const cleanup = async () => {
    setCleaning(true);
    try {
      const removed = await containersSandboxCleanup(runtime.id, context);
      pushSuccessToast(removed.length ? t("containers.sandbox.cleanupDone", { count: removed.length, names: removed.join(", ") }) : t("containers.sandbox.cleanupNone"));
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setCleaning(false);
    }
  };

  if (runtime.id === "ctr") return <EmptyLine>{t("containers.sandbox.ctrUnsupported")}</EmptyLine>;
  if (openRow) {
    return (
      <SandboxDetail
        sandbox={openRow}
        onBack={() => open(null)}
        onChanged={reload}
      />
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.sandbox.title")} sub={t("containers.sandbox.sub", { count: here.length })}>
        <Button size="sm" variant="ghost" onClick={reload} title={t("containers.sandbox.action.refresh")}>
          <RefreshCw size={12} />
        </Button>
        <Button size="sm" variant="secondary" onClick={() => void cleanup()} disabled={cleaning || !runtime.running} title={t("containers.sandbox.cleanupHint")}>
          {cleaning ? <Loader2 size={12} className="animate-spin" /> : <Brush size={12} />}
          {t("containers.sandbox.cleanup")}
        </Button>
        <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={!runtime.running || !workspaceId}>
          <Plus size={12} />
          {t("containers.sandbox.new")}
        </Button>
      </PageHead>
      {here.length > 0 && (
        <PageToolbar>
          <SearchField value={query} onChange={setQuery} placeholder={t("containers.sandbox.search")} />
        </PageToolbar>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {rows === null ? (
          <LoadingLine />
        ) : here.length === 0 ? (
          <p className="max-w-[640px] px-3 py-3 text-[12px] leading-relaxed text-[var(--cf-text-muted)]">{t("containers.sandbox.empty")}</p>
        ) : (
          <DataTable minWidth={820}>
            <thead>
              <tr>
                <Th>{t("containers.sandbox.col.task")}</Th>
                <Th>{t("containers.sandbox.col.branch")}</Th>
                <Th width={150}>{t("containers.sandbox.col.status")}</Th>
                <Th width={170}>{t("containers.sandbox.col.limits")}</Th>
                <Th width={110}>{t("containers.sandbox.col.network")}</Th>
                <Th width={100}>{t("containers.sandbox.col.policy")}</Th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.id} className={trClass(false, true)} onClick={() => open(row.id)}>
                  <Td title={row.error || undefined}>
                    <span className="block truncate font-medium text-[var(--cf-text)]">{sandboxLabel(row)}</span>
                    <span className="block truncate text-[11px] text-[var(--cf-text-faint)]">{[row.projectName, row.image].filter(Boolean).join(" · ")}</span>
                  </Td>
                  <Td>
                    <span className="block truncate font-mono text-[11.5px]">{row.branch || "—"}</span>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5">
                      <StateDot tone={statusTone(row.status)} pulse={row.status === "creating"} />
                      {t(`containers.sandbox.status.${row.status}`)}
                    </span>
                  </Td>
                  <Td>
                    <span className="tabular-nums text-[11.5px] text-[var(--cf-text-muted)]">{t("containers.sandbox.limits", { memory: row.memoryMb, cpus: row.cpus, pids: row.pidsLimit })}</span>
                  </Td>
                  <Td>{t(`containers.sandbox.network.${row.network}`)}</Td>
                  <Td>
                    <PolicyBadge status={row.policyStatus} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        )}
      </div>
      {creating && workspaceId && (
        <NewSandboxDialog
          workspaceId={workspaceId}
          runtime={runtime.id}
          context={context}
          onClose={() => {
            setCreating(false);
            reload();
          }}
          onCreated={(sandbox) => {
            setCreating(false);
            reload();
            open(sandbox.id);
          }}
        />
      )}
    </div>
  );
}

export function PolicyBadge({ status }: { status: SandboxView["policyStatus"] }) {
  const t = useT();
  if (!status) return <span className="text-[var(--cf-text-faint)]">—</span>;
  const tone = status === "ok" ? "var(--cf-success)" : status === "warnings" ? "var(--cf-warning)" : "var(--cf-danger)";
  return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold" style={{ color: tone, background: `color-mix(in oklab, ${tone} 14%, transparent)` }}>
      {t(`containers.sandbox.policy.${status}`)}
    </span>
  );
}
