import { useState } from "react";
import { FolderGit2, MessagesSquare } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../../api/ApiModal";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { Checkbox } from "../../common/Checkbox";
import { Select } from "../../common/Select";
import { fieldClass } from "../../common/recipes";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import { createAgentWorktree } from "../../../lib/tauri/commands";
import { AI_PROVIDERS } from "../../../lib/aiProviders";
import { CLI_PROVIDERS } from "../../../lib/agents/cliLaunch";
import { startAgentCli } from "../../../lib/agents/startCli";
import { taskTitleFrom } from "../../../state/agentsStore";
import type { RepoRef } from "../../../lib/agents/worktreeRows";

/** The agent the dialog starts with: the one the user picked last time, kept for the session. */
let lastProvider = "claude";

/**
 * «Nuevo espacio»: a working copy of its own and an agent at work in it, in one step — what Orca's
 * Create Workspace does.
 *
 * The agent is one of the CLIs, started in a terminal of the new folder with the first prompt; the
 * rail follows it from the terminal like any other. An agent with no CLI — a chat agent from the
 * roster, the local model among them — is a task, and «Chat…» hands over to the task dialog, which
 * already knows how to make one with a worktree of its own.
 */
export function NewWorkspaceDialog({
  repos,
  initialProjectId,
  onClose,
  onChat,
  onCreated,
}: {
  repos: readonly RepoRef[];
  initialProjectId: string;
  onClose: () => void;
  /** Hands over to the task dialog, on this repository. */
  onChat: (projectId: string) => void;
  /** The folder the agent was started in, and its terminal session — so the rail can open it. */
  onCreated: (path: string, sessionId: string | null) => void;
}) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [projectId, setProjectId] = useState(
    repos.some((repo) => repo.id === initialProjectId) ? initialProjectId : (repos[0]?.id ?? ""),
  );
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState(lastProvider);
  const [ownWorktree, setOwnWorktree] = useState(true);
  const [busy, setBusy] = useState(false);
  const repo = repos.find((candidate) => candidate.id === projectId) ?? null;

  const create = async () => {
    if (!repo || !workspaceId || busy) return;
    setBusy(true);
    lastProvider = provider;
    try {
      // The name the card shows: what the user typed, else the start of what they asked for, else the
      // agent's — always one, since a name is what puts a space on the rail before its agent speaks.
      const label = AI_PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;
      const shown = name.trim() || (prompt.trim() ? taskTitleFrom(prompt) : "") || label;
      let path = repo.local_path;
      if (ownWorktree) {
        const made = await createAgentWorktree(repo.id, shown);
        path = made.path;
        await useWorktreeViewStore.getState().refreshListings([repo]);
      }
      useWorktreeViewStore.getState().setName(path, shown);
      const started = await startAgentCli({
        workspaceId,
        path,
        provider,
        title: shown === label ? label : `${label} · ${shown}`,
        prompt,
      });
      onCreated(path, started?.sessionId ?? null);
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
      setBusy(false);
    }
  };

  return (
    <ApiModal
      icon={FolderGit2}
      title={t("wt.newSpaceTitle")}
      subtitle={t("wt.newSpaceSubtitle")}
      width="max-w-lg"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={() => onChat(projectId)} disabled={busy}>
            <MessagesSquare size={13} />
            {t("wt.launchChat")}
          </GhostButton>
          <span className="ml-auto flex items-center gap-2">
            <GhostButton onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </GhostButton>
            <PrimaryButton onClick={() => void create()} disabled={busy || !repo || !workspaceId}>
              {t("wt.newSpaceCreate")}
            </PrimaryButton>
          </span>
        </>
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
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("wt.newSpaceName")}</span>
          <Field value={name} onChange={setName} placeholder={t("wt.newSpaceNamePlaceholder")} />
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
        </div>
        <label className="block space-y-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("wt.newSpacePrompt")}</span>
          <textarea
            rows={4}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void create();
              }
            }}
            placeholder={t("wt.newSpacePromptPlaceholder")}
            className={fieldClass({ className: "h-auto w-full resize-none py-2 leading-relaxed" })}
          />
        </label>
        <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-[var(--cf-text)]">
          <Checkbox checked={ownWorktree} onChange={setOwnWorktree} className="mt-0.5" />
          <span>
            {t("wt.newSpaceWorktree")}
            <span className="block text-[11.5px] text-[var(--cf-text-muted)]">
              {ownWorktree ? t("wt.newSpaceWorktreeHint") : t("wt.newSpaceMainHint")}
            </span>
          </span>
        </label>
      </div>
    </ApiModal>
  );
}
