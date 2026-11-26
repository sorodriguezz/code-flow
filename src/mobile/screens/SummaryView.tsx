import { CircleCheck, Gauge, ServerCrash, UserCheck, Workflow } from "lucide-react";
import { t } from "../i18n";
import { teamRunWaits, useMobileStore } from "../store";
import { useNav } from "../nav";
import { navigated } from "../haptics";
import { sinceIso } from "../time";
import { Card, Divider, Row, Section } from "../ui/List";
import { Badge } from "../ui/Feedback";
import { ChainBadge, stepLabel } from "./AgentsScreen";
import { TeamRunRowView } from "./TeamsScreen";

/** The views the Agents tab switches between. Here because the summary sends people to them. */
export type AgentsView = "summary" | "teams" | "chains" | "runs" | "services" | "containers" | "flows";

/**
 * The first thing the Agents tab shows: what is waiting for you, then what is moving.
 *
 * # Why a summary, when every list already sorts its questions first
 *
 * Because there were five lists. A team waiting for its plan to be approved, a chain on a gate, a
 * flow on an approval and a service that fell over each lived behind a different view of this tab,
 * and the tab's badge counted only one of them — so "does anything need me?", the question a phone
 * is unlocked to ask, took four taps to answer and could still be answered wrong.
 *
 * This is that question answered once. Everything that is a *request* is here, in one list, each
 * row opening the thing it is about; and when there is nothing, it says so in a sentence, which is
 * the answer most visits are hoping for.
 *
 * The count on the tab bar is computed from the same four sources (`attentionCount` in the store),
 * so the badge and this list cannot disagree about what "waiting" means.
 */
export function SummaryView({ onOpen }: { onOpen: (view: AgentsView) => void }) {
  const workspaceId = useMobileStore((s) => s.workspaceId);
  const push = useNav((s) => s.push);
  const chains = useMobileStore((s) => s.chains);
  const teamRuns = useMobileStore((s) => s.teamRuns);
  const flowWaits = useMobileStore((s) => s.flowWaits);
  const services = useMobileStore((s) => s.services);
  const runtime = useMobileStore((s) => s.serviceRuntime);
  const liveRuns = useMobileStore((s) => Object.values(s.logs).filter((log) => !log.finished).length);

  const waitingTeams = teamRuns.filter(teamRunWaits);
  const gatedChains = chains.filter((chain) => chain.status === "gated");
  const approvals = flowWaits.filter((wait) => wait.kind === "approval");
  const failedServices = services.filter((service) => runtime[service.id]?.status === "failed");
  const waiting = waitingTeams.length + gatedChains.length + approvals.length + failedServices.length;

  const movingTeams = teamRuns.filter((run) => !teamRunWaits(run) && run.status === "running");
  const runningChains = chains.filter((chain) => chain.status === "running");
  const upServices = services.filter((service) => {
    const status = runtime[service.id]?.status;
    return status === "ready" || status === "starting" || status === "restarting";
  });
  const moving = movingTeams.length + runningChains.length + liveRuns + upServices.length;

  return (
    <>
      {waiting === 0 ? (
        // Said, rather than left as an empty section: "nothing is waiting" is an answer, and it is
        // the one most visits to this tab are for.
        <Card padded className="mt-3 flex items-center gap-3">
          <CircleCheck size={22} className="shrink-0 text-[var(--cf-success-text)]" aria-hidden />
          <span className="min-w-0">
            <span className="block text-md font-medium">{t("summary.clear")}</span>
            <span className="mt-0.5 block text-xs text-[var(--cf-text-muted)]">{t("summary.clearHint")}</span>
          </span>
        </Card>
      ) : (
        <Section title={t("summary.waiting", { n: waiting })}>
          <Card>
            {waitingTeams.map((run, index) => (
              <div key={run.id} className="bg-[var(--cf-accent-soft)]">
                {index > 0 && <Divider />}
                <TeamRunRowView run={run} />
              </div>
            ))}
            {gatedChains.map((chain, index) => (
              <div key={chain.id} className="bg-[var(--cf-accent-soft)]">
                {(index > 0 || waitingTeams.length > 0) && <Divider />}
                <Row
                  title={chain.title}
                  titleClassName="font-semibold"
                  subtitle={`${t("agents.chains")} · ${t("chains.step", { current: stepLabel(chain), total: chain.step_count })}`}
                  trailing={<ChainBadge status={chain.status} />}
                  onClick={() => {
                    navigated();
                    push({ k: "chain", workspaceId: workspaceId ?? "", chainId: chain.id, title: chain.title });
                  }}
                />
              </div>
            ))}
            {/* A flow's approval and a fallen service are answered in their own view, which has the
                buttons — one row each, however many there are, so a dozen approvals do not push the
                team gate above them off the screen. */}
            {approvals.length > 0 && (
              <div className="bg-[var(--cf-accent-soft)]">
                {waitingTeams.length + gatedChains.length > 0 && <Divider />}
                <Row
                  leading={<UserCheck size={16} className="text-[var(--cf-accent-text)]" aria-hidden />}
                  title={t("summary.approvals", { n: approvals.length })}
                  titleClassName="font-semibold"
                  subtitle={[approvals[0].flowName, sinceIso(approvals[0].createdAt)].filter(Boolean).join(" · ")}
                  onClick={() => onOpen("flows")}
                />
              </div>
            )}
            {failedServices.length > 0 && (
              <div>
                {waitingTeams.length + gatedChains.length + approvals.length > 0 && <Divider />}
                <Row
                  leading={<ServerCrash size={16} className="text-[var(--cf-danger-text)]" aria-hidden />}
                  title={t("summary.failedServices", { n: failedServices.length })}
                  subtitle={failedServices.map((service) => service.name).join(", ")}
                  trailing={<Badge tone="danger">{t("summary.down")}</Badge>}
                  onClick={() => onOpen("services")}
                />
              </div>
            )}
          </Card>
        </Section>
      )}

      {moving > 0 && (
        <Section title={t("summary.moving")}>
          <Card>
            {movingTeams.map((run, index) => (
              <div key={run.id}>
                {index > 0 && <Divider />}
                <TeamRunRowView run={run} />
              </div>
            ))}
            {runningChains.length > 0 && (
              <div>
                {movingTeams.length > 0 && <Divider />}
                <Row
                  leading={<Workflow size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
                  title={t("summary.chainsRunning", { n: runningChains.length })}
                  subtitle={runningChains.map((chain) => chain.title).join(", ")}
                  onClick={() => onOpen("chains")}
                />
              </div>
            )}
            {liveRuns > 0 && (
              <div>
                {movingTeams.length + runningChains.length > 0 && <Divider />}
                <Row title={t("summary.liveRuns", { n: liveRuns })} onClick={() => onOpen("runs")} />
              </div>
            )}
            {upServices.length > 0 && (
              <div>
                {movingTeams.length + runningChains.length + liveRuns > 0 && <Divider />}
                <Row
                  title={t("summary.servicesUp", { n: upServices.length })}
                  subtitle={upServices.map((service) => service.name).join(", ")}
                  onClick={() => onOpen("services")}
                />
              </div>
            )}
          </Card>
        </Section>
      )}

      <Section>
        <Card>
          <Row
            leading={<Gauge size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
            title={t("usage.title")}
            subtitle={t("usage.rowHint")}
            onClick={() => {
              navigated();
              push({ k: "usage" });
            }}
          />
        </Card>
      </Section>
    </>
  );
}
