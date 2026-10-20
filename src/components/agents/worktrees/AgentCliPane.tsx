import { useState } from "react";
import { Play, SquareTerminal } from "lucide-react";
import { ProviderGlyph } from "../../ai/ProviderGlyph";
import { buttonClass } from "../../common/Button";
import { BenchTerminalPane } from "../TerminalBench";
import { useAgentsStore } from "../../../state/agentsStore";
import { useBenchStore } from "../../../state/benchStore";
import { useWorktreeViewStore } from "../../../state/worktreeViewStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { pushErrorToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import { AI_PROVIDERS } from "../../../lib/aiProviders";
import { canResume, CLI_PROVIDERS, hasCli } from "../../../lib/agents/cliLaunch";
import { startAgentCli } from "../../../lib/agents/startCli";
import { folderName, type WorktreeRow } from "../../../lib/agents/worktreeRows";

function providerLabel(id: string, t: ReturnType<typeof useT>): string {
  const provider = AI_PROVIDERS.find((candidate) => candidate.id === id);
  return provider?.label ?? (provider?.labelKey ? t(provider.labelKey) : id);
}

/**
 * An agent's own CLI, running in a terminal inside the row's working copy — what Orca shows for
 * every agent, and here the other half of a task beside its chat.
 *
 * The terminal is an ordinary bench shell (so it is also listed on the bench, keeps running when this
 * view is left, and comes back with its scrollback after a restart); this pane only remembers which
 * one belongs to the row and types the CLI's command into it once, when it is made.
 */
export function AgentCliPane({ row, visible }: { row: WorktreeRow; visible: boolean }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const terminalId = useWorktreeViewStore((s) => s.cliTerminal[row.key] ?? "");
  const terminal = useBenchStore((s) => s.terminals.find((candidate) => candidate.id === terminalId) ?? null);
  const task = row.task;
  const sending = useAgentsStore((s) => (task ? (s.live[task.id]?.sending ?? false) : false));
  const sessionId = useAgentsStore((s) => (task ? (s.live[task.id]?.sessionId ?? null) : null));
  const [starting, setStarting] = useState(false);

  const start = async (provider: string) => {
    if (!workspaceId || row.path === "") return;
    setStarting(true);
    try {
      const started = await startAgentCli({
        workspaceId,
        path: row.path,
        provider,
        title: `${providerLabel(provider, t)} · ${row.branch || folderName(row.path)}`,
        resume: { sessionId, accountId: task?.account_id },
      });
      if (started) useWorktreeViewStore.getState().setCliTerminal(row.key, started.terminalId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setStarting(false);
    }
  };

  const close = () => {
    if (terminal) void useBenchStore.getState().closePane(terminal.tab_id, terminal.id).catch((e: unknown) => pushErrorToast(String(e)));
    useWorktreeViewStore.getState().setCliTerminal(row.key, null);
  };

  if (terminal) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <BenchTerminalPane bare terminal={terminal} visible={visible} focused={false} onFocus={() => undefined} onClose={close} />
      </div>
    );
  }

  // Nothing started yet: the task's own CLI, or — in a folder no task owns — any of them.
  const choices = task ? [task.provider].filter(hasCli) : [...CLI_PROVIDERS];
  const resumable = !!task && canResume(task.provider, { sessionId, accountId: task.account_id });

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <SquareTerminal size={22} className="text-[var(--cf-text-faint)]" />
      <p className="max-w-[420px] text-[12.5px] leading-relaxed text-[var(--cf-text-muted)]">
        {choices.length === 0
          ? t("wt.cliUnavailable", { name: task ? providerLabel(task.provider, t) : "" })
          : resumable
            ? t("wt.cliResumeHint")
            : t("wt.cliHint")}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {choices.map((provider) => (
          <button
            key={provider}
            type="button"
            disabled={starting || sending || !workspaceId}
            title={sending ? t("wt.cliBusy") : undefined}
            onClick={() => void start(provider)}
            className={buttonClass({ variant: task ? "primary" : "secondary", size: "sm" })}
          >
            {task ? <Play size={12} /> : <ProviderGlyph providerId={provider} size={13} />}
            {task ? t("wt.cliStart", { name: providerLabel(provider, t) }) : providerLabel(provider, t)}
          </button>
        ))}
      </div>
    </div>
  );
}
