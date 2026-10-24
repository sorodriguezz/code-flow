import { useEffect, useMemo } from "react";
import { Tooltip } from "../../common/Tooltip";
import { useTicketStore } from "../../../state/ticketStore";
import { useRepoSummaryStore } from "../../../state/repoSummaryStore";
import { useRepoStore } from "../../../state/repoStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { useT } from "../../../state/languageStore";
import { displayKey, ticketForBranch, ticketUid } from "../../../lib/tickets/ticketKeys";
import type { Project } from "../../../types/domain";

/** One read of the cache and the links per workspace, however many rows draw a chip. */
let primedFor: string | null = null;

/**
 * The ticket of a repository's current branch, as a chip on its row in the projects panel (user,
 * 2026-10-23: «En el panel de proyectos, la fila del repo muestra el ticket de la rama actual»).
 * Hover names it and its state; a click opens it in Agentes › Tareas.
 *
 * Nothing here asks a board anything: the branch comes from the panel's own summary (or the open
 * repository's live state), the ticket from the links «Empezar» recorded and the last list read.
 */
export function TicketChip({ project, isActive }: { project: Project; isActive: boolean }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const summaryBranch = useRepoSummaryStore((s) => s.byPath[project.local_path]?.branch ?? null);
  const liveBranch = useRepoStore((s) => (isActive ? (s.status?.current_branch ?? null) : null));
  const links = useTicketStore((s) => s.links);
  const tickets = useTicketStore((s) => s.tickets);
  const branch = liveBranch ?? summaryBranch;

  useEffect(() => {
    if (!workspaceId || primedFor === workspaceId) return;
    primedFor = workspaceId;
    void useTicketStore.getState().loadCache();
    void useTicketStore.getState().loadLinks(workspaceId);
  }, [workspaceId]);

  const found = useMemo(() => ticketForBranch(project.id, branch, links, tickets), [project.id, branch, links, tickets]);
  if (!found) return null;
  const { ticket } = found;
  return (
    <Tooltip label={`${displayKey(ticket)} · ${ticket.title}${ticket.state ? ` · ${ticket.state}` : ""}`}>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          useTicketStore.getState().reveal(ticketUid(ticket));
        }}
        aria-label={t("tickets.openTicket", { key: displayKey(ticket) })}
        className="shrink-0 rounded-[4px] bg-[var(--cf-accent-soft)] px-1 font-mono text-[10.5px] leading-[16px] text-[var(--cf-accent)] hover:brightness-110"
      >
        {displayKey(ticket)}
      </button>
    </Tooltip>
  );
}
