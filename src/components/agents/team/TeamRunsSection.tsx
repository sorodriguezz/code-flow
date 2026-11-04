import { useState } from "react";
import { ChevronRight, CircleHelp, Lock, Plus, Settings2, Users } from "lucide-react";
import { Tooltip } from "../../common/Tooltip";
import { iconButtonClass } from "../../common/Button";
import { rowClass, sectionLabelClass, tabCountClass } from "../../common/recipes";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { useTeamStore } from "../../../state/teamStore";
import { useT } from "../../../state/languageStore";
import { statusTone } from "./teamLook";

/**
 * EQUIPOS in the task tree: every team run of the workspace, the live ones first. Drawn only once a
 * team exists — a heading for a feature nobody has set up lists nothing.
 */
export function TeamRunsSection({ query }: { query: string }) {
  const t = useT();
  const runs = useTeamStore((s) => s.runs);
  const teams = useTeamStore((s) => s.teams);
  const selectedRunId = useTeamStore((s) => s.selectedRunId);
  const [open, setOpen] = useState(true);
  if (teams.length === 0 && runs.length === 0) return null;
  const needle = query.trim().toLowerCase();
  const shown = runs.filter((r) => !needle || r.title.toLowerCase().includes(needle) || r.goal.toLowerCase().includes(needle) || r.team_name.toLowerCase().includes(needle));
  const live = (s: string) => (s === "running" || s === "gated" || s === "paused" ? 0 : 1);
  const ordered = [...shown].sort((a, b) => live(a.status) - live(b.status) || b.updated_at.localeCompare(a.updated_at));
  return (
    <section>
      <div className={`group/section ${sectionLabelClass} pr-0`}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-[22px] min-w-0 flex-1 items-center gap-1.5 text-left uppercase transition-colors hover:text-[var(--cf-text-muted)]">
          <ChevronRight size={12} className={`shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
          <span className="truncate">{t("team.section")}</span>
          {shown.length > 0 && <span className={`${tabCountClass} tracking-normal`}>{shown.length}</span>}
        </button>
        <Tooltip label={t("team.manage")}>
          <button type="button" onClick={() => useTeamStore.setState({ dialog: { kind: "teams" } })} aria-label={t("team.manage")} className={iconButtonClass({ size: "sm" })}>
            <Settings2 size={13} />
          </button>
        </Tooltip>
        <Tooltip label={t("team.newRun")}>
          <button type="button" onClick={() => useTeamStore.setState({ dialog: { kind: "run" } })} aria-label={t("team.newRun")} className={iconButtonClass({ size: "sm" })}>
            <Plus size={13} />
          </button>
        </Tooltip>
      </div>
      {open && (
        <div>
          {ordered.map((run) => (
            <button key={run.id} type="button" onClick={() => void useTeamStore.getState().select(run.id)} className={rowClass(run.id === selectedRunId, "h-7")} title={run.goal}>
              {run.status === "running" ? <ThinkingOrb size="sm" /> : run.status === "gated" ? <Lock size={12} className="shrink-0 text-[var(--cf-warning)]" /> : <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${statusTone(run.status).dot}`} />}
              <Users size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
              <span className="min-w-0 flex-1 truncate">{run.title}</span>
              {run.gate.startsWith("question") && <CircleHelp size={12} className="text-[var(--cf-warning)]" />}
              <span className="max-w-[40%] shrink-0 truncate text-[11px] text-[var(--cf-text-faint)]">{run.team_name}</span>
            </button>
          ))}
          {ordered.length === 0 && (
            <button type="button" onClick={() => useTeamStore.setState({ dialog: { kind: "run" } })} className={rowClass(false, "h-7 text-[var(--cf-text-muted)]")}>
              <Plus size={13} />
              {t("team.newRun")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
