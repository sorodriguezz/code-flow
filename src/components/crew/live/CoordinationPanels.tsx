import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Braces, ChartNoAxesColumn, GitPullRequest } from "lucide-react";
import { getProject } from "../../../lib/tauri/commands";
import { teamPrDraft, teamRecommendations } from "../../../lib/tauri/teamCommands";
import { useAiPanelStore } from "../../../state/aiPanelStore";
import { useTeamStore } from "../../../state/teamStore";
import { pushErrorToast } from "../../../state/toastStore";
import type { Project } from "../../../types/domain";
import type { TeamPrDraft, TeamRecommendation, TeamRunState } from "../../../types/team";
import { CreatePrModal } from "../../layout/CreatePrModal";
import { Btn, Chip, Panel } from "../kit/ui";
import { useL } from "../state";
import { ITEM_KIND } from "./look";

export function CoordinationPanels({ state, onOpenItem }: { state: TeamRunState; onOpenItem: (id: string) => void }) {
  const l = useL();
  const [contractsOpen, setContractsOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [prOpen, setPrOpen] = useState(true);
  const [recommendations, setRecommendations] = useState<TeamRecommendation[] | null>(null);
  const [draft, setDraft] = useState<{ project: Project; initial: TeamPrDraft } | null>(null);
  const [loadingRepo, setLoadingRepo] = useState<string | null>(null);
  const runs = useTeamStore((store) => store.runs);
  const { run, repos, items } = state;
  const repoName = (id: string) => repos.find((repo) => repo.project_id === id)?.name ?? id;
  const contracts = useMemo(() => {
    const latest = new Map<string, { itemId: string; path: string; version: string }>();
    const publishers = items.filter((item) => item.status === "done" && (!["work", "integrate"].includes(item.kind) || item.merged || !item.commit_sha))
      .sort((a, b) => a.finished_at.localeCompare(b.finished_at) || a.created_at.localeCompare(b.created_at));
    for (const item of publishers) {
      for (const contract of item.intelligence?.published_contracts ?? []) latest.set(contract.name, { ...contract, itemId: item.id });
    }
    return latest;
  }, [items]);
  const stale = items.filter((item) => item.status === "done").flatMap((item) => {
    const names = Object.entries(item.intelligence?.used_contracts ?? {}).filter(([name, version]) => contracts.get(name)?.version !== version).map(([name]) => name);
    return names.length ? [{ item, names }] : [];
  });
  const eligible = repos.filter((repo) => (run.status === "gated" && run.gate === "merge" && repo.status === "ready")
    || (run.status === "done" && repo.status === "left"));

  useEffect(() => {
    if (!modelsOpen) return;
    let active = true;
    void teamRecommendations(run.id).then((rows) => { if (active) setRecommendations(rows); })
      .catch((error) => { if (active) { setRecommendations([]); pushErrorToast(String(error)); } });
    return () => { active = false; };
  }, [modelsOpen, run.id]);

  const openDraft = async (projectId: string) => {
    setLoadingRepo(projectId);
    try {
      const [project, initial] = await Promise.all([getProject(projectId), teamPrDraft(run.id, projectId, l("es", "en") === "es")]);
      if (!project) throw new Error(l("El repositorio ya no está disponible.", "The repository is no longer available."));
      setDraft({ project, initial });
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setLoadingRepo(null);
    }
  };

  return (
    <>
      <Panel icon={Braces} title={<span className="flex items-center gap-2">{l("Contratos del equipo", "Team contracts")}
        {stale.length > 0 && <Chip tone="warn">{stale.length}</Chip>}</span>}
        open={contractsOpen} onToggle={() => setContractsOpen(!contractsOpen)}>
        {contracts.size === 0 && stale.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Los contratos publicados en la corrida aparecen aquí.", "Contracts published in the run appear here.")}</span>}
        {[...contracts].map(([name, contract]) => (
          <Btn small key={name} onClick={() => onOpenItem(contract.itemId)}>
            {name} · {contract.path} · {contract.version.slice(0, 12)}
          </Btn>
        ))}
        {stale.map(({ item, names }) => (
          <div key={item.id} className="rounded-lg border border-[var(--cf-warning)] p-2 text-[12px]">
            <b>{item.title} · {l("Requiere revalidación", "Needs revalidation")}</b>
            <p className="m-0">{names.join(", ")}</p>
            {item.intelligence?.criteria?.map((criterion, index) => <p className="m-0 text-[11px]" key={index}>• {criterion}</p>)}
            {item.intelligence?.evidence?.filter((entry) => entry.result !== "reported" && entry.result !== "unverified").map((entry, index) => (
              <p className="m-0 text-[11px] font-mono" key={index}>{entry.label}</p>
            ))}
            <Btn small onClick={() => onOpenItem(item.id)}>{l("Ver tarea y pruebas", "View task and checks")}</Btn>
          </div>
        ))}
      </Panel>
      <Panel icon={ChartNoAxesColumn} title={l("Modelos según el historial", "Models from run history")} open={modelsOpen} onToggle={() => setModelsOpen(!modelsOpen)}>
        {recommendations === null && <span className="text-[12px]">…</span>}
        {recommendations?.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{l("Las sugerencias aparecen al repetir trabajos comparables en este repositorio.", "Suggestions appear after comparable work is repeated in this repository.")}</span>}
        {recommendations?.map((row) => (
          <div key={JSON.stringify([row.project_id, row.role, row.kind, row.route])} className="rounded-lg border border-[var(--cf-border)] p-2 text-[12px]">
            <b>{row.route.provider} · {row.route.model} · {row.route.effort || l("Esfuerzo predeterminado", "Default effort")}</b>
            <p className="m-0">{repoName(row.project_id)} · {row.role || l(...ITEM_KIND[row.kind])}</p>
            <p className="m-0 text-[var(--cf-text-muted)]">
              {l(`${row.first_pass}/${row.attempted} al primer intento`, `${row.first_pass}/${row.attempted} on the first attempt`)}
              {row.median_seconds > 0 && ` · ${l("Mediana", "Median")} ${row.median_seconds} s`}
              {row.quota_blocks > 0 && ` · ${row.quota_blocks} ${l("pausas por cuota", "quota pauses")}`}
            </p>
            <div className="flex flex-wrap gap-1">
              {row.run_ids.map((id) => <Btn small key={id} onClick={() => void useTeamStore.getState().select(id)}>
                {runs.find((candidate) => candidate.id === id)?.title || id.slice(0, 8)}
              </Btn>)}
            </div>
          </div>
        ))}
      </Panel>
      {eligible.length > 0 && <Panel icon={GitPullRequest} title={l("Entrega como borrador de PR", "Deliver as a draft PR")} open={prOpen} onToggle={() => setPrOpen(!prOpen)}>
        {eligible.map((repo) => <Btn small key={repo.project_id} disabled={loadingRepo !== null} onClick={() => void openDraft(repo.project_id)}>
          {repo.name} · {loadingRepo === repo.project_id ? l("Preparando…", "Preparing…") : l("Revisar borrador", "Review draft")}
        </Btn>)}
      </Panel>}
      {draft && createPortal(<CreatePrModal project={draft.project} initial={draft.initial} onClose={() => setDraft(null)}
        onCreated={(pr) => useAiPanelStore.getState().open({ kind: "pr", projectId: draft.project.id, pr })} />, document.body)}
    </>
  );
}
