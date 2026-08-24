import { useState } from "react";
import { CircleDot, Loader2, PauseCircle, TriangleAlert, Workflow } from "lucide-react";
import { t, type MobileKey } from "../i18n";
import { useMobileStore } from "../store";
import { useNav } from "../nav";
import { navigated } from "../haptics";
import { sinceIso } from "../time";
import { RootBar } from "../ui/RootBar";
import { Screen } from "../ui/Screen";
import { Segmented } from "../ui/Segmented";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge, EmptyState } from "../ui/Feedback";
import { RunsView } from "./RunsScreen";
import type { AgentChain, ChainStatus } from "../../types/domain";

/**
 * The tab this whole feature exists for.
 *
 * A chain that reaches a gate stops and stays stopped until a person answers it — so being able to
 * answer from wherever you are is the difference between a plan finishing over lunch and a plan
 * finishing when you get back to the desk. Everything else in this client is convenience; this is
 * the part that changes an outcome.
 *
 * # Two views, one control
 *
 * Chains and live runs are two views of one thing — a chain *is* what most runs belong to — so they
 * share a tab behind a segmented control rather than taking two of the five slots in the tab bar.
 * The control now disappears when a chain is open, because it belongs to the list level: it used to
 * stay, with "Cadenas" drawn as selected while the chain *list* was nowhere on screen and tapping it
 * did nothing at all.
 */

export const STATUS_KEY: Record<ChainStatus, MobileKey> = {
  queued: "chainStatus.queued",
  running: "chainStatus.running",
  gated: "chainStatus.gated",
  paused: "chainStatus.paused",
  failed: "chainStatus.failed",
  done: "chainStatus.done",
  aborted: "chainStatus.aborted",
};

export function statusTone(status: ChainStatus): "accent" | "success" | "danger" | "neutral" | "warning" {
  switch (status) {
    case "gated":
      // The one status that is a request rather than a report, so it is the one that gets the
      // accent. A screen of grey rows with one indigo badge answers "does anything need me?"
      // before the user has read a word.
      return "accent";
    case "running":
      return "success";
    case "failed":
      return "danger";
    case "done":
      return "neutral";
    default:
      return "warning";
  }
}

export function StatusIcon({ status }: { status: ChainStatus }) {
  if (status === "running") return <Loader2 size={11} className="animate-spin" aria-hidden />;
  if (status === "gated") return <CircleDot size={11} aria-hidden />;
  if (status === "failed") return <TriangleAlert size={11} aria-hidden />;
  if (status === "paused" || status === "queued") return <PauseCircle size={11} aria-hidden />;
  return null;
}

export function ChainBadge({ status }: { status: ChainStatus }) {
  return (
    <Badge tone={statusTone(status)} icon={<StatusIcon status={status} />}>
      {t(STATUS_KEY[status])}
    </Badge>
  );
}

/**
 * Which step to call the current one.
 *
 * `current_step` is a zero-based index, so the human number is one more — except at the end, where a
 * finished chain reports `current_step === step_count` and the arithmetic printed *"Paso 3 de 2"*.
 * Clamped, because "the last one" is what a finished chain is on.
 */
export function stepLabel(chain: { current_step: number; step_count: number }): number {
  return Math.min(chain.current_step + 1, Math.max(1, chain.step_count));
}

function ChainsView({ chains }: { chains: AgentChain[] }) {
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const push = useNav((s) => s.push);
  const [onlyWaiting, setOnlyWaiting] = useState(false);
  const waiting = chains.filter((c) => c.status === "gated").length;

  if (chains.length === 0) {
    return (
      <EmptyState
        icon={<Workflow size={26} aria-hidden />}
        title={t("chains.none")}
        hint={t("chains.noneHint")}
      />
    );
  }

  // Gated chains first: they are the only rows that are a question, and a question belongs above
  // the answers. Within each group the backend's order is kept.
  const sorted = [...chains].sort((a, b) => {
    const rank = (c: AgentChain) => (c.status === "gated" ? 0 : c.status === "running" ? 1 : 2);
    return rank(a) - rank(b);
  });
  const shown = onlyWaiting ? sorted.filter((c) => c.status === "gated") : sorted;

  return (
    <Section
      // A filter, not a second list. It appears only when there is both something waiting and
      // enough noise around it to be worth hiding — on five chains the sort already does the job.
      action={
        waiting > 0 && chains.length > 5 ? (
          <button
            type="button"
            aria-pressed={onlyWaiting}
            onClick={() => setOnlyWaiting((v) => !v)}
            className={`cf-press rounded-full border px-2.5 py-1 text-2xs font-semibold ${
              onlyWaiting
                ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent-text)]"
                : "border-[var(--cf-border)] text-[var(--cf-text-muted)]"
            }`}
          >
            {t("chains.waitingCount", { n: waiting })}
          </button>
        ) : undefined
      }
    >
      <Card>
        {shown.map((chain, index) => (
          <div key={chain.id} className={chain.status === "gated" ? "bg-[var(--cf-accent-soft)]" : ""}>
            {index > 0 && <Divider />}
            <Row
              title={chain.title}
              titleClassName={chain.status === "gated" ? "font-semibold" : ""}
              subtitle={
                <>
                  {t("chains.step", { current: stepLabel(chain), total: chain.step_count })}
                  {chain.repo_count > 1 ? ` · ${chain.repo_count} repos` : ""}
                  {sinceIso(chain.updated_at) ? ` · ${sinceIso(chain.updated_at)}` : ""}
                </>
              }
              trailing={<ChainBadge status={chain.status} />}
              onClick={() => {
                navigated();
                push({
                  k: "chain",
                  workspaceId: workspaceId ?? "",
                  chainId: chain.id,
                  title: chain.title,
                });
              }}
            />
          </div>
        ))}
      </Card>
    </Section>
  );
}

export function AgentsScreen() {
  const chains = useMobileStore((s) => s.chains);
  const refreshAll = useMobileStore((s) => s.refreshAll);
  const liveRuns = useMobileStore((s) => Object.values(s.logs).filter((l) => !l.finished).length);
  const [view, setView] = useState<"chains" | "runs">("chains");
  const waiting = chains.filter((c) => c.status === "gated").length;

  return (
    <Screen
      onRefresh={() => refreshAll()}
      bar={
        <RootBar
          title={t("nav.agents")}
          below={
            <div className="px-3 pb-2">
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { id: "chains", label: t("agents.chains"), badge: waiting },
                  { id: "runs", label: t("agents.runs"), badge: liveRuns },
                ]}
              />
            </div>
          }
        />
      }
    >
      {view === "chains" ? <ChainsView chains={chains} /> : <RunsView />}
    </Screen>
  );
}
