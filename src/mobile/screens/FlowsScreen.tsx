import { useEffect, useState, type ReactNode } from "react";
import { Check, Play, UserCheck, Waypoints, X } from "lucide-react";
import { t } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore, type FlowWait, type PhoneFlow } from "../store";
import { sinceIso } from "../time";
import { Button } from "../ui/Button";
import { Card, Divider, Row, Section } from "../ui/List";
import { EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";

/**
 * The Agents tab's fourth view: the flows that need somebody.
 *
 * Two lists. **Waiting** — runs parked at an approval node (Approve / Reject here decides them, as
 * `phone`), and runs waiting for a call or a time, shown so nobody wonders why a flow has not
 * finished. **Start from here** — the armed flows with a phone trigger; the desktop refuses any flow
 * it did not offer (`fire_from_phone`), so this list is the whole of what a phone can start.
 *
 * Rejecting and running take two taps, like stopping a service: both act on the machine at once and
 * a pocket is a poor place to confirm in. Approving is one — it is what the wait was waiting for.
 */

function TwoTap({
  label,
  confirmLabel,
  icon,
  danger,
  disabled,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  icon: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(id);
  }, [armed]);
  return (
    <Button
      size="sm"
      variant={armed ? (danger ? "danger" : "primary") : "ghost"}
      icon={armed ? undefined : icon}
      disabled={disabled}
      ariaLabel={armed ? confirmLabel : label}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : null}
    </Button>
  );
}

function when(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

function WaitRow({ wait }: { wait: FlowWait }) {
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("flows");
  const decide = (decision: "approved" | "rejected") =>
    void run(
      () => rpc<FlowWait>("flows_decide_wait", { id: wait.id, decision }),
      "flows",
      t(decision === "approved" ? "toast.flowApproved" : "toast.flowRejected"),
    );
  const kindLine = wait.kind === "approval" ? wait.message : wait.kind === "webhook" ? t("flows.waitsCall") : t("flows.waitsTime");
  const subtitle = [
    `${wait.flowName} · ${wait.nodeName}`,
    sinceIso(wait.createdAt),
    wait.expiresAt ? t("flows.until", { when: when(wait.expiresAt) }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Row
      leading={<UserCheck size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
      title={kindLine || wait.nodeName}
      titleClassName={wait.kind === "approval" ? "font-semibold" : ""}
      subtitle={subtitle}
      chevron={false}
      trailing={
        wait.kind === "approval" ? (
          <span className="flex shrink-0 items-center gap-0.5">
            <TwoTap
              label={t("flows.reject")}
              confirmLabel={t("flows.rejectConfirm")}
              icon={<X size={15} />}
              danger
              disabled={busy}
              onConfirm={() => decide("rejected")}
            />
            <Button size="sm" variant="primary" icon={<Check size={15} />} disabled={busy} onClick={() => decide("approved")}>
              {t("flows.approve")}
            </Button>
          </span>
        ) : undefined
      }
    />
  );
}

function PhoneButton({ button }: { button: PhoneFlow }) {
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("flows");
  return (
    <Row
      leading={<Waypoints size={16} className="text-[var(--cf-text-muted)]" aria-hidden />}
      title={button.label}
      subtitle={button.label === button.flowName ? undefined : button.flowName}
      chevron={false}
      trailing={
        <TwoTap
          label={t("flows.run")}
          confirmLabel={t("flows.runConfirm")}
          icon={<Play size={15} />}
          disabled={busy}
          onConfirm={() =>
            void run(
              async () => {
                const answer = await rpc<{ held: boolean }>("flows_run_from_phone", { flowId: button.flowId, nodeId: button.nodeId });
                if (answer.held) throw new Error(t("toast.flowBusy"));
                return answer;
              },
              "flows",
              t("toast.flowStarted"),
            )
          }
        />
      }
    />
  );
}

export function FlowsView() {
  const waits = useMobileStore((s) => s.flowWaits);
  const buttons = useMobileStore((s) => s.phoneFlows);
  const state = useMobileStore((s) => s.flowsState);
  const error = useMobileStore((s) => s.flowsError);
  const refresh = useMobileStore((s) => s.refreshFlows);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (waits.length === 0 && buttons.length === 0) {
    if (state === "loading") {
      return (
        <Section>
          <SkeletonList rows={3} />
        </Section>
      );
    }
    if (state === "error") {
      return <ErrorState title={t("flows.failed")} detail={error} onRetry={() => void refresh()} />;
    }
    return <EmptyState icon={<Waypoints size={26} aria-hidden />} title={t("flows.none")} />;
  }

  // Approvals first: they are questions; the rest only explain why a run has not finished.
  const sorted = [...waits].sort((a, b) => Number(b.kind === "approval") - Number(a.kind === "approval"));
  return (
    <>
      {sorted.length > 0 && (
        <Section title={t("flows.waiting")}>
          <Card>
            {sorted.map((wait, index) => (
              <div key={wait.id} className={wait.kind === "approval" ? "bg-[var(--cf-accent-soft)]" : ""}>
                {index > 0 && <Divider inset />}
                <WaitRow wait={wait} />
              </div>
            ))}
          </Card>
        </Section>
      )}
      {buttons.length > 0 && (
        <Section title={t("flows.buttons")}>
          <Card>
            {buttons.map((button, index) => (
              <div key={`${button.flowId}:${button.nodeId}`}>
                {index > 0 && <Divider inset />}
                <PhoneButton button={button} />
              </div>
            ))}
          </Card>
        </Section>
      )}
    </>
  );
}
