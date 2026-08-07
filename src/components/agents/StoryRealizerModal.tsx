import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, Search, Wand2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Note } from "../api/settingsChrome";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Field } from "../settings/modelPicker";
import { AI_PROVIDERS, modelDisplayLabel, providerDisplayLabel } from "../../lib/aiProviders";
import { loadAdoConnections } from "../../lib/adoConnections";
import { loadJiraConnections } from "../../lib/jiraConnections";
import { boardGetWorkItem, boardParseItemRef, openExternalUrl } from "../../lib/tauri/commands";
import { htmlToText, splitCriteriaHtml } from "../../lib/workItemHtml";
import { isRunnableAgent, useAgentsStore } from "../../state/agentsStore";
import { useChainStore } from "../../state/chainStore";
import { isProviderReady, useProviderStatusStore } from "../../state/providerStatusStore";
import { useActiveProjects, useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { BoardWorkItem, NewStoryWorkItem } from "../../types/domain";

/** Mirrors `queries::MAX_CHAIN_REPOS`, halved by `create_story_chain`'s row budget: a story run is
 * two passes per repository. */
const MAX_REPOS = 12;

/** The work item, flattened to the text every step of the run will read as its objective.
 *
 * English labels around the story's own words, for the same reason `compose_chain_input` uses them
 * in Rust: an engine reads this, a person does not, and the story itself arrives in whatever
 * language it was written in either way. */
function composeBody(item: BoardWorkItem): string {
  const parts: string[] = [`Type: ${item.work_item_type || "unknown"}`, `State: ${item.state || "unknown"}`];
  const description = htmlToText(item.description_html).trim();
  const repro = htmlToText(item.repro_steps_html).trim();
  const criteria = splitCriteriaHtml(item.acceptance_criteria_html);

  parts.push(`\n### Description\n${description || "(empty)"}`);
  if (repro) parts.push(`\n### Steps to reproduce\n${repro}`);
  parts.push(
    criteria.length > 0
      ? `\n### Acceptance criteria\n${criteria.map((c, at) => `${at + 1}. ${c}`).join("\n\n")}`
      : "\n### Acceptance criteria\n(none written)",
  );
  if (item.children.length > 0) {
    parts.push(
      `\n### Tasks already on the board\n${item.children
        .map((child) => `- ${child.title} [${child.state}]`)
        .join("\n")}`,
    );
  }
  return parts.join("\n");
}

/**
 * The story realizer: a work item, the repositories it might touch, and the two agents that will
 * read them and then write them.
 *
 * The shape is fixed and that is the point. Phase one runs the first agent **once per candidate
 * repository**, read-only, and each pass answers whether its repository has to change and what
 * would change in it. The run then stops — every time, not only when something looks wrong — and
 * shows you those N answers together. Phase two runs the second agent only on the repositories you
 * kept, with the plan as you left it.
 *
 * One agent per phase, not one per repository: what differs between repositories is the tree, and
 * the tree is already what a step carries. And a single run cannot see two repositories at once —
 * the engines this app dispatches to take one working directory — which is the same constraint the
 * work-item review already lives under, and the reason "which repos does this touch?" is answered by
 * N passes and a merge rather than by one clever prompt.
 */
export function StoryRealizerModal({
  onClose,
  onManageAgents,
  initialAgentProjectId = "",
}: {
  onClose: () => void;
  onManageAgents: () => void;
  initialAgentProjectId?: string;
}) {
  const t = useT();
  const roster = useAgentsStore((s) => s.roster);
  const agentProjects = useAgentsStore((s) => s.projects);
  const projects = useActiveProjects();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const statuses = useProviderStatusStore((s) => s.byProvider);
  const checkAll = useProviderStatusStore((s) => s.checkAll);

  const runnable = useMemo(() => roster.filter(isRunnableAgent), [roster]);

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  /** The resolved work item, and the host it was resolved against. `null` until Load succeeds —
   * everything below it is disabled, because a story run with no story is nothing. */
  const [item, setItem] = useState<{ work: BoardWorkItem; provider: string; org: string } | null>(null);

  const [projectIds, setProjectIds] = useState<string[]>(() => {
    const first =
      (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : projects[0]?.id) ?? "";
    return first ? [first] : [];
  });
  const [analystId, setAnalystId] = useState("");
  const [implementerId, setImplementerId] = useState("");
  const [notes, setNotes] = useState("");
  const [agentProjectId, setAgentProjectId] = useState(() =>
    agentProjects.some((p) => p.id === initialAgentProjectId) ? initialAgentProjectId : "",
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (Object.keys(statuses).length === 0) void checkAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same guard the chain dialog carries: the roster is editable from behind this dialog, and a
  // phase pointed at an agent that stopped being runnable is cleared rather than submitted with a
  // blank routing the backend would refuse.
  useEffect(() => {
    setAnalystId((current) => (current && !runnable.some((a) => a.id === current) ? "" : current));
    setImplementerId((current) => (current && !runnable.some((a) => a.id === current) ? "" : current));
  }, [runnable]);

  const toggleRepo = (id: string) =>
    setProjectIds((current) =>
      current.includes(id)
        ? current.filter((kept) => kept !== id)
        : current.length >= MAX_REPOS
          ? current
          : [...current, id],
    );

  /**
   * Resolves whatever was pasted and fetches it.
   *
   * A bare id or key carries no host, so it falls back to the one connection of that kind — and
   * only when there is exactly one. Guessing between two Azure organisations would fetch *an* item
   * 4821 and look like it worked, which is the failure this refuses to risk; paste the link
   * instead.
   */
  const load = async () => {
    if (!input.trim() || loading) return;
    setLoading(true);
    setLoadError("");
    try {
      const ref = await boardParseItemRef(input);
      const org =
        ref.org ??
        (ref.provider === "jira"
          ? ((await loadJiraConnections().catch(() => []))[1] ? null : (await loadJiraConnections())[0]?.site) ?? null
          : ((await loadAdoConnections().catch(() => []))[1] ? null : (await loadAdoConnections())[0]?.org) ?? null);
      if (!org) throw new Error(t("agents.storyNoBoards"));
      const work = await boardGetWorkItem(ref.provider, org, ref.id, ref.key);
      setItem({ work, provider: ref.provider, org });
      // The lookup is done; leaving the reference in the box makes Load look armed when what it
      // would do is fetch the item already on screen.
      setInput("");
    } catch (e) {
      setItem(null);
      setLoadError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const canStart =
    !busy && item !== null && projectIds.length > 0 && analystId !== "" && implementerId !== "";

  const submit = async (start: boolean) => {
    if (!canStart || !item) return;
    setBusy(true);
    try {
      const workItem: NewStoryWorkItem = {
        provider: item.provider,
        org: item.org,
        id: item.work.id,
        key: item.work.key,
        url: item.work.url,
        title: item.work.title,
        body: composeBody(item.work),
      };
      await useChainStore.getState().createStory({
        projectIds,
        title: item.work.key ? `${item.work.key} — ${item.work.title}` : item.work.title,
        notes,
        analystAgentId: analystId,
        implementerAgentId: implementerId,
        agentProjectId,
        workItem,
        start,
      });
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  const agentOptions = runnable.map((a) => ({
    value: a.id,
    label: `${a.name || t("settings.sddNewAgent")} — ${providerDisplayLabel(a.provider, t)} · ${modelDisplayLabel(
      a.provider,
      a.model,
      t,
    )}`,
    icon: AI_PROVIDERS.find((p) => p.id === a.provider)?.icon,
    disabled: !isProviderReady(statuses, a.provider),
  }));

  return (
    <ApiModal
      icon={Wand2}
      title={t("agents.newStoryTitle")}
      subtitle={t("agents.newStorySubtitle")}
      width="max-w-2xl"
      busy={busy}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onManageAgents} disabled={busy}>
            {t("agents.newAgent")}
          </GhostButton>
          <span className="ml-auto flex items-center gap-2">
            <GhostButton onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </GhostButton>
            <GhostButton onClick={() => void submit(false)} disabled={!canStart}>
              {t("agents.storyCreateOnly")}
            </GhostButton>
            <PrimaryButton onClick={() => void submit(true)} disabled={!canStart}>
              {t("agents.storyStartAnalysis")}
            </PrimaryButton>
          </span>
        </>
      }
    >
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {runnable.length === 0 && <Note tone="warning">{t("agents.agentIncomplete")}</Note>}
        {projects.length === 0 && (
          <Note tone="warning">{`${t("agents.noProjects")} — ${t("agents.noProjectsHint")}`}</Note>
        )}

        <Field label={t("agents.storyRef")}>
          <div className="flex items-center gap-1.5">
            <input
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void load();
                }
              }}
              placeholder={t("agents.storyRefPlaceholder")}
              className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] outline-none focus:border-[var(--cf-accent)]"
            />
            <GhostButton onClick={() => void load()} disabled={loading || !input.trim()}>
              {loading ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              {t("agents.storyLoad")}
            </GhostButton>
          </div>
        </Field>

        {loadError && <Note tone="warning">{loadError}</Note>}

        {item && (
          <div className="rounded-lg border border-[var(--cf-border)] px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded bg-black/[0.06] px-1.5 py-[1px] text-[10px] font-semibold tabular-nums dark:bg-white/[0.1]">
                {item.work.key || `#${item.work.id}`}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{item.work.title}</span>
              {item.work.url && (
                <button
                  type="button"
                  onClick={() =>
                    void openExternalUrl(item.work.url).catch((e: unknown) => pushErrorToast(String(e)))
                  }
                  title={t("agents.storyOpenBoard")}
                  className="shrink-0 text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
                >
                  <ExternalLink size={12} />
                </button>
              )}
            </div>
            <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
              {htmlToText(item.work.description_html) || t("agents.storyNoAnalysis")}
            </p>
          </div>
        )}

        {/* Every one of these is read. Which of them are written to is decided later, on the
            evidence — which is what the whole two-phase shape exists to make possible. */}
        <Field label={t("agents.storyCandidates")} hint={t("agents.storyCandidatesHint")}>
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-[var(--cf-border)] px-2 py-1.5">
            {projects.map((repo) => (
              <label
                key={repo.id}
                className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]"
              >
                <Checkbox
                  checked={projectIds.includes(repo.id)}
                  disabled={!projectIds.includes(repo.id) && projectIds.length >= MAX_REPOS}
                  onChange={() => toggleRepo(repo.id)}
                />
                <span className="min-w-0 truncate">{repo.name}</span>
              </label>
            ))}
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t("agents.storyAnalyst")} hint={t("agents.storyAnalystHint")}>
            <Select
              size="field"
              value={analystId}
              placeholder={t("agents.pickAgent")}
              ariaLabel={t("agents.storyAnalyst")}
              onChange={setAnalystId}
              options={agentOptions}
            />
          </Field>
          <Field label={t("agents.storyImplementer")} hint={t("agents.storyImplementerHint")}>
            <Select
              size="field"
              value={implementerId}
              placeholder={t("agents.pickAgent")}
              ariaLabel={t("agents.storyImplementer")}
              onChange={setImplementerId}
              options={agentOptions}
            />
          </Field>
        </div>

        <Field label={t("agents.project")} hint={t("agents.projectHint")}>
          <Select
            size="field"
            value={agentProjectId}
            ariaLabel={t("agents.project")}
            onChange={setAgentProjectId}
            options={[
              { value: "", label: t("agents.projectNone") },
              ...agentProjects.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Field>

        <Field label={t("agents.storyNotes")}>
          <textarea
            value={notes}
            rows={3}
            onChange={(e) => setNotes(e.target.value)}
            placeholder={t("agents.storyNotesPlaceholder")}
            className="w-full resize-y rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1.5 text-[12px] leading-relaxed outline-none focus:border-[var(--cf-accent)]"
          />
        </Field>

        {!item && <Note tone="muted">{t("agents.storyLoadFirst")}</Note>}
      </div>
    </ApiModal>
  );
}
