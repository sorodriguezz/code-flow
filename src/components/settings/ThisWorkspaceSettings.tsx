import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Skeleton } from "../common/Skeleton";
import { AI_PROMPTS } from "../../lib/aiPrompts";
import { defaultWorkspacePrompt, getWorkspaceIdentity, getWorkspacePrompt, listWorkspaceSkills } from "../../lib/tauri/commands";
import { mcpList } from "../../lib/tauri/mcpCommands";
import type { SettingsSectionId } from "../../state/uiStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useAiAccountsStore } from "../../state/aiAccountsStore";
import { useT } from "../../state/languageStore";

/**
 * «Workspaces y proyectos › Este workspace»: everything the open workspace does differently from the
 * rest, in one list — what replaced the nav's «Workspace» group (2026-10-09). Each setting that can
 * differ per workspace still says so on its own row; this is where they are seen together, each a
 * way to the pane that sets it.
 *
 * Read once per workspace, every answer stamped with the workspace it was asked about, so a switch
 * mid-read never lists one workspace's values under another's name.
 */

interface Facts {
  workspaceId: string;
  identity: { name: string; email: string } | null;
  prompts: string[];
  mcp: string[];
  skills: string[];
}

export function ThisWorkspaceSettings() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const workspaceName = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.activeWorkspaceId)?.name ?? "");
  const accounts = useAiAccountsStore((s) => s.workspaceDefaults);
  const [facts, setFacts] = useState<Facts | null>(null);

  useEffect(() => {
    void useAiAccountsStore.getState().ensure();
  }, []);

  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const workspacePrompts = AI_PROMPTS.filter((prompt) => prompt.scope === "workspace");
    void Promise.all([
      getWorkspaceIdentity(workspaceId).catch(() => null),
      Promise.all(
        workspacePrompts.map(async (prompt) => {
          const [stored, fallback] = await Promise.all([
            getWorkspacePrompt(workspaceId, prompt.key).catch(() => ""),
            defaultWorkspacePrompt(prompt.key).catch(() => ""),
          ]);
          return stored?.trim() && stored.trim() !== fallback.trim() ? t(prompt.labelKey) : null;
        }),
      ),
      mcpList(workspaceId).catch(() => []),
      listWorkspaceSkills(workspaceId).catch(() => []),
    ]).then(([identity, prompts, servers, skills]) => {
      if (!live) return;
      setFacts({
        workspaceId,
        identity: identity && (identity.name || identity.email) ? { name: identity.name ?? "", email: identity.email ?? "" } : null,
        prompts: prompts.filter((label): label is string => !!label),
        mcp: servers.filter((server) => server.scope === "workspace").map((server) => server.name),
        skills: skills.map((skill) => skill.skill_name),
      });
    });
    return () => {
      live = false;
    };
  }, [workspaceId, t]);

  if (!workspaceId) return <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.skillsSelectWorkspace")}</p>;
  if (!facts || facts.workspaceId !== workspaceId) {
    return (
      <div className="space-y-1.5">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-11 w-full" />
        ))}
      </div>
    );
  }

  const own = accounts.filter((row) => row.workspaceId === workspaceId);
  const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", "));
  const rows: { label: string; value: string; custom: boolean; to: [SettingsSectionId, string] }[] = [
    {
      label: t("thisWorkspace.gitIdentity"),
      value: facts.identity ? [facts.identity.name, facts.identity.email].filter(Boolean).join(" · ") : t("thisWorkspace.inherits"),
      custom: !!facts.identity,
      to: ["git", "identity"],
    },
    {
      label: t("thisWorkspace.aiAccount"),
      value: own.length ? t("thisWorkspace.accounts", { n: own.length }) : t("thisWorkspace.inherits"),
      custom: own.length > 0,
      to: ["claude", "accounts"],
    },
    {
      label: t("thisWorkspace.prompts"),
      value: facts.prompts.length ? list(facts.prompts) : t("thisWorkspace.defaults"),
      custom: facts.prompts.length > 0,
      to: ["tasks", "review"],
    },
    {
      label: t("settings.review"),
      value: t("thisWorkspace.review"),
      custom: true,
      to: ["review", "engine"],
    },
    {
      label: t("settings.mcp"),
      value: facts.mcp.length ? list(facts.mcp) : t("thisWorkspace.none"),
      custom: facts.mcp.length > 0,
      to: ["tools", "mcp"],
    },
    {
      label: t("settings.skills"),
      value: facts.skills.length ? list(facts.skills) : t("thisWorkspace.none"),
      custom: facts.skills.length > 0,
      to: ["tools", "skills"],
    },
  ];

  return (
    <div>
      <p className="mb-2 text-[12px] text-[var(--cf-text-muted)]">{t("thisWorkspace.for", { name: workspaceName })}</p>
      <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
        {rows.map((row) => (
          <button
            key={row.label}
            type="button"
            onClick={() => useUiStore.getState().openSettingsAt(row.to[0], row.to[1])}
            className="flex w-full items-start gap-3 border-b border-[var(--cf-border)] px-3 py-2.5 text-left last:border-b-0 hover:bg-[var(--cf-hover)]"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-[var(--cf-text)]">{row.label}</span>
              <span className={`mt-0.5 block break-words text-[11.5px] ${row.custom ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>{row.value}</span>
            </span>
            <ChevronRight size={14} className="mt-[3px] shrink-0 text-[var(--cf-text-faint)]" />
          </button>
        ))}
      </div>
    </div>
  );
}
