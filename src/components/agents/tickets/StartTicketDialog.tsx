import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../../api/ApiModal";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { Select } from "../../common/Select";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { useWorkspaceStore, useActiveProjects } from "../../../state/workspaceStore";
import { useBenchStore } from "../../../state/benchStore";
import { useTicketStore } from "../../../state/ticketStore";
import { pushErrorToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import { AI_PROVIDERS } from "../../../lib/aiProviders";
import { CLI_PROVIDERS } from "../../../lib/agents/cliLaunch";
import { startAgentCli } from "../../../lib/agents/startCli";
import { ticketsBranchName, ticketsStart, type Ticket } from "../../../lib/tauri/ticketCommands";
import { displayKey, ticketUid } from "../../../lib/tickets/ticketKeys";

/** The agent and repository picked last, kept for the session — a queue of tickets is worked with
 * the same agent on the same repository far more often than not. */
let lastProvider = "claude";
let lastProjectId = "";

/**
 * «Empezar»: a worktree of its own on a branch named after the ticket, and an agent at work in it
 * with the whole ticket as its first prompt (user, 2026-10-23). The same two steps as «Nuevo
 * agente» (`NewWorkspaceDialog`), with the branch and the prompt written from the ticket instead of
 * typed — and the link ticket ↔ branch recorded, which is what later puts the reference in the pull
 * request and moves the ticket.
 *
 * The agent is one of the CLIs the bench starts; the branch name is shown first and can be edited.
 */
export function StartTicketDialog({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const repos = useActiveProjects();
  const [projectId, setProjectId] = useState(() => {
    const linked = useTicketStore.getState().links.find((link) => link.ticket_uid === ticketUid(ticket))?.project_id;
    const preferred = linked ?? lastProjectId;
    return repos.some((repo) => repo.id === preferred) ? preferred : (repos[0]?.id ?? "");
  });
  const [branch, setBranch] = useState("");
  const [provider, setProvider] = useState(lastProvider);
  const [busy, setBusy] = useState(false);
  const repo = repos.find((candidate) => candidate.id === projectId) ?? null;

  useEffect(() => {
    let cancelled = false;
    void ticketsBranchName(ticket)
      .then((name) => {
        if (!cancelled) setBranch((current) => current || name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ticket]);

  const start = async () => {
    if (!repo || !workspaceId || busy) return;
    setBusy(true);
    lastProvider = provider;
    lastProjectId = repo.id;
    try {
      const started = await ticketsStart(workspaceId, repo.id, ticket, branch.trim() || null);
      await useWorktreeViewStore.getState().refreshListings([repo]);
      const shown = `${displayKey(ticket)} ${ticket.title}`.trim();
      useWorktreeViewStore.getState().setName(started.path, shown);
      const label = AI_PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;
      const launched = await startAgentCli({
        workspaceId,
        path: started.path,
        provider,
        title: `${label} · ${displayKey(ticket)}`,
        prompt: started.prompt,
      });
      await useTicketStore.getState().loadLinks(workspaceId);
      // The terminal the agent is in, on screen — the tree stays where it was beside it.
      if (launched) void useBenchStore.getState().show(workspaceId, launched.terminalId);
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={Play}
      title={t("tickets.startTitle", { key: displayKey(ticket) })}
      subtitle={ticket.title}
      width="max-w-lg"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <span className="ml-auto flex items-center gap-2">
          <GhostButton onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </GhostButton>
          <PrimaryButton onClick={() => void start()} disabled={busy || !repo || !workspaceId}>
            {busy ? t("tickets.starting") : t("tickets.start")}
          </PrimaryButton>
        </span>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("wt.newSpaceRepo")}</span>
          <Select
            value={projectId}
            onChange={setProjectId}
            options={repos.map((candidate) => ({ value: candidate.id, label: candidate.name }))}
            size="field"
            ariaLabel={t("wt.newSpaceRepo")}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("tickets.branch")}</span>
          <Field value={branch} onChange={setBranch} mono />
          <span className="block text-[11.5px] text-[var(--cf-text-muted)]">{t("tickets.branchHint")}</span>
        </label>
        <div className="space-y-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("wt.newSpaceAgent")}</span>
          <div className="grid grid-cols-3 gap-1.5">
            {CLI_PROVIDERS.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setProvider(id)}
                aria-pressed={provider === id}
                className={`flex h-8 items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors ${
                  provider === id
                    ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-text)]"
                    : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
                }`}
              >
                <ProviderGlyph providerId={id} size={14} />
                <span className="min-w-0 truncate">{AI_PROVIDERS.find((candidate) => candidate.id === id)?.label ?? id}</span>
              </button>
            ))}
          </div>
          <span className="block text-[11.5px] text-[var(--cf-text-muted)]">{t("tickets.promptHint")}</span>
        </div>
      </div>
    </ApiModal>
  );
}
