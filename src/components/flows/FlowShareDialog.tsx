import { useEffect, useMemo, useState } from "react";
import { Copy, GitMerge, RefreshCw, UserPlus, Users } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { diffSpecs } from "../../lib/flows/diff";
import { parseSpec, type FlowSpec } from "../../lib/flows/spec";
import type { SupabaseProject } from "../../types/api";
import { confirmAction } from "../../state/confirmStore";
import { useFlowShareStore } from "../../state/flowShareStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";
import { pushSuccessToast } from "../../state/toastStore";

/** `abcd` of `https://abcd.supabase.co` — how the API client's settings name a project too. */
function projectRef(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] || url;
  } catch {
    return url;
  }
}

/**
 * Sharing one flow through a Supabase project — the projects set up for the API client's
 * collections. Not shared: pick a project and share. Shared: the invitation code to hand out (it is
 * a credential: whoever holds it can read and change the flow), a new code to take access back
 * (host only), and leaving — the flow stays here, it just stops syncing.
 */
export function FlowShareDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const t = useT();
  const share = useFlowShareStore((s) => s.shares[flowId]);
  const name = useFlowsStore((s) => s.flows.find((flow) => flow.id === flowId)?.name ?? "");
  const [projects, setProjects] = useState<SupabaseProject[] | null>(null);
  const [project, setProject] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const store = useFlowShareStore.getState;

  useEffect(() => {
    void store()
      .projects()
      .then((list) => {
        setProjects(list);
        setProject((current) => current || list[0]?.url || "");
      });
  }, [store]);
  useEffect(() => {
    if (share) void store().inviteCode(flowId).then(setCode);
  }, [share, flowId, store]);

  const copy = async () => {
    if (!code) return;
    await navigator.clipboard.writeText(code);
    pushSuccessToast(t("flows.share.copied"));
  };

  return (
    <ApiModal icon={Users} title={t("flows.share.title")} subtitle={name} width="max-w-md" busy={busy} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        {!share ? (
          projects === null ? null : projects.length === 0 ? (
            <p className="text-[12.5px] leading-snug text-[var(--cf-text-muted)]">{t("flows.share.noProject")}</p>
          ) : (
            <>
              {projects.length > 1 && (
                <label className="flex flex-col gap-1">
                  <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.share.project")}</span>
                  <Select
                    value={project}
                    onChange={setProject}
                    options={projects.map((p) => ({ value: p.url, label: projectRef(p.url) }))}
                    size="sm"
                  />
                </label>
              )}
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={!project || busy}
                  title={t("flows.share.shareHint")}
                  onClick={async () => {
                    setBusy(true);
                    await store().share(flowId, project);
                    setBusy(false);
                  }}
                >
                  <Users size={12} />
                  {t("flows.share.share")}
                </Button>
              </div>
            </>
          )
        ) : (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.share.code")}</span>
              <div className="flex items-center gap-1.5">
                <input
                  readOnly
                  value={code ?? ""}
                  onFocus={(event) => event.currentTarget.select()}
                  className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono text-[11px]" })}
                  title={t("flows.share.codeHint")}
                />
                <Button size="sm" onClick={() => void copy()} disabled={!code}>
                  <Copy size={12} />
                  {t("flows.share.copy")}
                </Button>
              </div>
            </label>
            <p className="text-[11.5px] text-[var(--cf-text-muted)]">
              {projectRef(share.projectUrl)} · {t(share.role === "owner" ? "flows.share.host" : "flows.share.member")}
              {share.lastError ? (
                <span className="text-[var(--cf-danger)]"> · {share.lastError}</span>
              ) : share.syncedAt ? (
                ` · ${t("flows.share.syncedAt", { at: new Date(share.syncedAt).toLocaleTimeString() })}`
              ) : null}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="danger-ghost"
                size="sm"
                onClick={async () => {
                  const ok = await confirmAction(t("flows.share.leaveConfirm", { name }), true, t("flows.share.leave"));
                  if (!ok) return;
                  await store().leave(flowId);
                  onClose();
                }}
              >
                {t("flows.share.leave")}
              </Button>
              <span className="flex-1" />
              <Button size="sm" onClick={() => void store().syncNow(flowId)} title={t("flows.share.syncNow")}>
                <RefreshCw size={12} />
              </Button>
              {share.role === "owner" && (
                <Button
                  size="sm"
                  title={t("flows.share.rotateHint")}
                  onClick={async () => {
                    const ok = await confirmAction(t("flows.share.rotateConfirm"), true, t("flows.share.rotate"));
                    if (!ok) return;
                    const next = await store().rotate(flowId);
                    if (next) setCode(next);
                  }}
                >
                  {t("flows.share.rotate")}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </ApiModal>
  );
}

/** Accepting an invitation: the flow lands in this workspace (and folder), not reviewed. */
export function JoinSharedDialog({ folderId, onClose }: { folderId: string | null; onClose: () => void }) {
  const t = useT();
  const workspaceId = useFlowsStore((s) => s.workspaceId);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const join = async () => {
    if (!workspaceId || !code.trim()) return;
    setBusy(true);
    const id = await useFlowShareStore.getState().join(code, workspaceId, folderId);
    setBusy(false);
    if (!id) return;
    await useFlowsStore.getState().refresh();
    await useFlowsStore.getState().openFlow(id);
    onClose();
  };
  return (
    <ApiModal icon={UserPlus} title={t("flows.share.joinTitle")} width="max-w-md" busy={busy} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <textarea
          autoFocus
          rows={3}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="codeflow:…"
          className={fieldClass({ size: "sm", className: "h-auto resize-none py-1.5 font-mono text-[11px]" })}
          aria-label={t("flows.share.code")}
        />
        <div className="flex justify-end">
          <Button variant="primary" size="sm" disabled={!code.trim() || busy} onClick={() => void join()}>
            {t("flows.share.join")}
          </Button>
        </div>
      </div>
    </ApiModal>
  );
}

/** Both sides changed the flow: keep this one (sent now) or take theirs (replaces this one). */
export function ShareConflictDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const t = useT();
  const share = useFlowShareStore((s) => s.shares[flowId]);
  const local = useFlowsStore((s) => (s.draft?.id === flowId ? s.draft.spec : null));
  const [busy, setBusy] = useState(false);
  const theirs = useMemo((): FlowSpec | null => {
    if (!share?.conflict) return null;
    try {
      const payload = JSON.parse(share.conflict) as { spec?: unknown };
      return parseSpec(JSON.stringify(payload.spec ?? null));
    } catch {
      return null;
    }
  }, [share?.conflict]);
  const counts = local && theirs ? diffSpecs(local, theirs).counts : null;
  const answer = async (keepMine: boolean) => {
    setBusy(true);
    // What is on screen goes first, so "mine" is the latest of mine.
    await useFlowsStore.getState().flush();
    await useFlowShareStore.getState().resolve(flowId, keepMine);
    if (!keepMine) await useFlowsStore.getState().reloadShared(flowId);
    setBusy(false);
    onClose();
  };
  return (
    <ApiModal icon={GitMerge} title={t("flows.share.conflictTitle")} width="max-w-md" busy={busy} onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-[12.5px] leading-snug text-[var(--cf-text)]">{t("flows.share.conflictBody")}</p>
        {counts && (
          <span className="flex gap-2.5 text-[11.5px] tabular-nums text-[var(--cf-text-muted)]">
            {t("flows.share.theirs")}:
            <span className="text-[var(--cf-success)]">+{counts.added}</span>
            <span className="text-[var(--cf-warning)]">~{counts.changed}</span>
            <span className="text-[var(--cf-danger)]">−{counts.removed}</span>
          </span>
        )}
        <div className="flex justify-end gap-2">
          <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
            {t("flows.share.keepMine")}
          </Button>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => void answer(false)}>
            {t("flows.share.takeTheirs")}
          </Button>
        </div>
      </div>
    </ApiModal>
  );
}
