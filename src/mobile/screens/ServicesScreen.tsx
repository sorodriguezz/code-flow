import { useEffect, useState, type ReactNode } from "react";
import { Play, RotateCcw, Server, Square } from "lucide-react";
import { t, type MobileKey } from "../i18n";
import { rpc } from "../transport";
import { useBusy, useMobileStore } from "../store";
import { Button } from "../ui/Button";
import { Card, Divider, Row, Section } from "../ui/List";
import { EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
import type { ServiceRow, ServiceRuntime, ServiceStatus } from "../../types/services";

/**
 * The workspace's services — the desktop's bottom panel, as a list with its three verbs.
 *
 * What a phone can do here is exactly what the panel's buttons do to a service that is already
 * defined: start it (and what it waits for), stop it (and what waits for it), restart it. Defining,
 * editing and deleting services stay at the desk, and so does the log: a build's output scrolling
 * past is thousands of frames nobody on a phone is reading.
 *
 * Live without polling: the supervisor emits `services:runtime` on every change, the desktop's
 * server forwards it (`remotectl/bridge.rs`), and `App.tsx` folds each frame into the store.
 *
 * Stop and restart ask twice. Starting cannot hurt anything that is running; stopping takes a dev
 * server away from whoever is at the desk using it.
 */

const LABEL: Record<ServiceStatus, MobileKey> = {
  stopped: "services.status.stopped",
  waiting: "services.status.waiting",
  starting: "services.status.starting",
  ready: "services.status.ready",
  completed: "services.status.completed",
  failed: "services.status.failed",
  stopping: "services.status.stopping",
  restarting: "services.status.restarting",
};

/** The dot a row leads with: green once it is up, amber on the way somewhere, red when it failed. */
const DOT: Record<ServiceStatus, string> = {
  stopped: "bg-[var(--cf-text-faint)]",
  waiting: "bg-[var(--cf-warning)] cf-pulse",
  starting: "bg-[var(--cf-warning)] cf-pulse",
  ready: "bg-[var(--cf-success)]",
  completed: "bg-[var(--cf-success)]",
  failed: "bg-[var(--cf-danger)]",
  stopping: "bg-[var(--cf-warning)] cf-pulse",
  restarting: "bg-[var(--cf-warning)] cf-pulse",
};

/** On its way somewhere: the one state no verb should interrupt. */
function inTransit(status: ServiceStatus): boolean {
  return status === "starting" || status === "waiting" || status === "stopping" || status === "restarting";
}

/**
 * An icon that becomes its own confirmation: the first tap arms it and spells out what the second
 * does, and it disarms itself after a few seconds. The row-sized sibling of `ConfirmAction`.
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

function ServiceItem({
  service,
  view,
  blockedByName,
}: {
  service: ServiceRow;
  view: ServiceRuntime | undefined;
  blockedByName: string | null;
}) {
  const run = useMobileStore((s) => s.run);
  const busy = useBusy("services");
  const status: ServiceStatus = view?.status ?? "stopped";
  const alive = view?.alive ?? false;
  const ids = [service.id];
  const workspaceId = service.workspace_id;

  const subtitle = [
    t(LABEL[status]),
    status === "waiting" && blockedByName ? t("services.waitingFor", { name: blockedByName }) : null,
    view?.ports.length ? view.ports.map((port) => `:${port}`).join(" ") : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Row
      leading={<span className={`h-2 w-2 rounded-full ${DOT[status]}`} aria-hidden />}
      title={service.name}
      subtitle={subtitle}
      trailing={
        <span className="flex shrink-0 items-center gap-0.5">
          {alive || inTransit(status) ? (
            <>
              <TwoTap
                label={t("services.restart")}
                confirmLabel={t("services.restartConfirm")}
                icon={<RotateCcw size={15} />}
                disabled={busy || inTransit(status)}
                onConfirm={() =>
                  void run(
                    () => rpc<void>("services_restart", { workspaceId, ids }),
                    "services",
                    t("toast.serviceRestarted"),
                  )
                }
              />
              <TwoTap
                label={t("services.stop")}
                confirmLabel={t("services.stopConfirm")}
                icon={<Square size={14} />}
                danger
                disabled={busy || status === "stopping"}
                onConfirm={() =>
                  void run(() => rpc<void>("services_stop", { ids }), "services", t("toast.serviceStopped"))
                }
              />
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              icon={<Play size={15} />}
              ariaLabel={t("services.start")}
              disabled={busy}
              onClick={() =>
                void run(
                  () => rpc<void>("services_start", { workspaceId, ids }),
                  "services",
                  t("toast.serviceStarted"),
                )
              }
            />
          )}
        </span>
      }
    />
  );
}

/** The Agents tab's third view. */
export function ServicesView() {
  const services = useMobileStore((s) => s.services);
  const runtime = useMobileStore((s) => s.serviceRuntime);
  const state = useMobileStore((s) => s.servicesState);
  const error = useMobileStore((s) => s.servicesError);
  const refresh = useMobileStore((s) => s.refreshServices);

  // Re-read on every visit: cheap, and what the desk changed while nobody here was looking — a
  // service added, renamed — arrives with no frame of its own.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (services.length === 0) {
    if (state === "loading") {
      return (
        <Section>
          <SkeletonList rows={3} />
        </Section>
      );
    }
    if (state === "error") {
      return <ErrorState title={t("services.failed")} detail={error} onRetry={() => void refresh()} />;
    }
    return <EmptyState icon={<Server size={26} aria-hidden />} title={t("services.none")} />;
  }

  const nameOf = (id: string | null | undefined) => services.find((service) => service.id === id)?.name ?? null;

  return (
    <Section>
      <Card>
        {services.map((service, index) => (
          <div key={service.id}>
            {index > 0 && <Divider inset />}
            <ServiceItem
              service={service}
              view={runtime[service.id]}
              blockedByName={nameOf(runtime[service.id]?.blockedBy)}
            />
          </div>
        ))}
      </Card>
    </Section>
  );
}
