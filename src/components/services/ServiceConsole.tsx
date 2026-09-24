import { useMemo, useState } from "react";
import {
  CirclePlay,
  Eraser,
  FolderOpen,
  Hourglass,
  Pencil,
  RotateCw,
  ShieldCheck,
  Square,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { TerminalPane } from "../terminal/TerminalPane";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { isActive, useServicesStore } from "../../state/servicesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { clearServiceLog, serviceLog } from "../../lib/tauri/services";
import { serviceDeps, serviceDetectedPorts, type ServiceRow } from "../../types/services";
import {
  PortChip,
  StatusGlyph,
  explain,
  portsFor,
  readyDescription,
  shortDuration,
  statusLabel,
  useElapsed,
} from "./serviceBits";
import { buttonClass } from "../common/Button";

/**
 * One service, on the right of the dock: what it is doing, why, where it listens, and everything it
 * printed.
 *
 * # The log is the supervisor's, not the pane's
 *
 * The console used to be the only record of a service's output — so it was empty whenever it had
 * not been mounted, which is to say exactly when the service crashed while you looked at something
 * else. The supervisor keeps the output now, across restarts, and the pane replays it on mount (see
 * `TerminalPane`'s `backlog`). A stopped service therefore still shows its last run, read-only,
 * which is where "why did it stop" is answered.
 */
export function ServiceConsole({ service, onEdit }: { service: ServiceRow; onEdit: () => void }) {
  const t = useT();
  const runtime = useServicesStore((s) => s.runtime[service.id]);
  const services = useServicesStore((s) => s.services);
  const start = useServicesStore((s) => s.start);
  const stop = useServicesStore((s) => s.stop);
  const restart = useServicesStore((s) => s.restart);
  const projects = useWorkspaceStore((s) => s.projectsByWorkspace[service.workspace_id]);
  /** Bumped to remount the pane after the log is cleared, so it replays the now-empty record. */
  const [clearedAt, setClearedAt] = useState(0);

  const status = runtime?.status ?? "stopped";
  const active = isActive(runtime);
  const nameOf = (id: string) => services.find((s) => s.id === id)?.name ?? null;
  const why = explain(runtime, nameOf, t);

  const clock = useElapsed(
    status === "starting" || status === "ready" || status === "waiting" ? runtime?.startedAt : null,
  );
  const since =
    status === "ready" && runtime?.readyAt ? shortDuration(Date.now() - runtime.readyAt) : clock !== null ? shortDuration(clock) : null;

  const { ports, live } = portsFor(runtime, serviceDetectedPorts(service));
  const deps = serviceDeps(service)
    .map((id) => nameOf(id))
    .filter((n): n is string => !!n);
  const project = service.project_id ? projects?.find((p) => p.id === service.project_id) : undefined;
  const where = project
    ? `${project.name}${service.cwd.trim() ? `/${service.cwd.trim()}` : ""}`
    : service.cwd.trim() || "~";

  // Edited after this process started: what is running is not what the form says any more.
  const stale =
    !!runtime?.alive && !!runtime.startedAt && Date.parse(service.updated_at) > runtime.startedAt + 1000;

  const backlog = useMemo(() => () => serviceLog(service.id), [service.id]);

  const tone =
    status === "failed"
      ? "danger"
      : status === "restarting" || status === "waiting"
        ? "warning"
        : status === "completed" || runtime?.error === "exitedClean"
          ? "muted"
          : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
        <StatusGlyph status={status} size={9} />
        <span className="min-w-0 truncate text-[13px] font-semibold text-[var(--cf-text)]">{service.name}</span>
        <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
          {statusLabel(status, t)}
          {since && status !== "stopped" && status !== "failed" && <span className="tabular-nums"> · {since}</span>}
        </span>
        {ports.length > 0 && (
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            {ports.slice(0, 4).map((port) => (
              <PortChip key={port} port={port} dim={!live} title={live ? undefined : t("services.lastSeenPort", { port })} />
            ))}
          </div>
        )}
        {(runtime?.restarts ?? 0) > 0 && (
          <Tooltip label={t("services.restartsBadge", { count: runtime!.restarts })}>
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-[color-mix(in_srgb,var(--cf-warning)_14%,transparent)] px-1 text-[10.5px] tabular-nums text-[var(--cf-warning)]">
              <RotateCw size={9} /> {runtime!.restarts}/3
            </span>
          </Tooltip>
        )}
        <div className="flex-1" />
        {stale && (
          <button
            onClick={() => void restart(service.id)}
            className="shrink-0 rounded-full border border-[var(--cf-warning)] px-2 py-0.5 text-[10.5px] text-[var(--cf-warning)] hover:bg-[color-mix(in_srgb,var(--cf-warning)_12%,transparent)]"
          >
            {t("services.applyChanges")}
          </button>
        )}
        {active ? (
          <>
            <ToolbarButton
              onClick={() => void restart(service.id)}
              label={t("services.restart")}
              disabled={status === "stopping"}
            >
              <RotateCw size={12} />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => void stop(service.id)}
              label={status === "stopping" ? t("services.status.stopping") : t("services.stop")}
              disabled={status === "stopping"}
              danger
            >
              <Square size={11} />
            </ToolbarButton>
          </>
        ) : (
          <button
            onClick={() => void start(service.id)}
            className={buttonClass({ variant: "primary", size: "sm" })}
          >
            <CirclePlay size={12} />
            {t("services.start")}
          </button>
        )}
        <div className="mx-0.5 h-4 w-px bg-[var(--cf-border)]" />
        <IconButton onClick={onEdit} label={t("services.edit")}>
          <Pencil size={12} />
        </IconButton>
        <IconButton
          onClick={() => {
            void clearServiceLog(service.id).then(() => setClearedAt(Date.now()));
          }}
          label={t("services.clearLog")}
        >
          <Eraser size={12} />
        </IconButton>
      </div>

      <div className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-b border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 text-[11px] text-[var(--cf-text-muted)]">
        <span className="flex min-w-0 shrink items-center gap-1.5 font-mono text-[var(--cf-text)]" title={service.command}>
          <TerminalSquare size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="truncate">{service.command}</span>
        </span>
        <span className="flex min-w-0 shrink-[2] items-center gap-1.5" title={where}>
          <FolderOpen size={11} className="shrink-0" />
          <span className="truncate">{where}</span>
        </span>
        {deps.length > 0 && (
          <span className="flex min-w-0 shrink-[3] items-center gap-1.5" title={deps.join(", ")}>
            <Hourglass size={11} className="shrink-0" />
            <span className="truncate">{t("services.waitsForList", { names: deps.join(", ") })}</span>
          </span>
        )}
        <span className="flex min-w-0 shrink-[3] items-center gap-1.5">
          <ShieldCheck size={11} className="shrink-0" />
          <span className="truncate">{readyDescription(service.ready_kind, service.ready_value, t)}</span>
        </span>
      </div>

      {why && (
        <div
          className={`flex shrink-0 items-center gap-2 border-b px-3 py-1.5 text-[11px] ${
            tone === "danger"
              ? "border-[color-mix(in_srgb,var(--cf-danger)_30%,transparent)] bg-[color-mix(in_srgb,var(--cf-danger)_10%,transparent)] text-[var(--cf-danger)]"
              : tone === "warning"
                ? "border-[color-mix(in_srgb,var(--cf-warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--cf-warning)_9%,transparent)] text-[var(--cf-warning)]"
                : "border-[var(--cf-border)] bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]"
          }`}
        >
          {tone === "danger" && <TriangleAlert size={12} className="shrink-0" />}
          <span className="min-w-0 flex-1 break-words">{why}</span>
          {status === "failed" && !runtime?.alive && (
            <button
              onClick={() => void start(service.id)}
              className="shrink-0 rounded border border-current px-1.5 py-0.5 text-[10.5px] font-medium hover:bg-[color-mix(in_srgb,currentColor_12%,transparent)]"
            >
              {t("services.tryAgain")}
            </button>
          )}
        </div>
      )}

      <div className="relative min-h-0 min-w-0 flex-1 bg-[var(--cf-surface)]">
        {runtime?.alive && runtime.sessionId ? (
          // Keyed on the session, so a restart builds a fresh terminal that replays the whole record
          // — the previous run, the seam, and the new one — rather than appending to a dead pane.
          <TerminalPane
            key={`${runtime.sessionId}:${clearedAt}`}
            sessionId={runtime.sessionId}
            visible
            backlog={backlog}
            quietExit
          />
        ) : runtime ? (
          <TerminalPane
            key={`log:${service.id}:${runtime.startedAt ?? 0}:${runtime.status}:${clearedAt}`}
            sessionId={`log:${service.id}`}
            visible
            readOnly
            backlog={backlog}
          />
        ) : (
          <NeverRun service={service} onStart={() => void start(service.id)} where={where} deps={deps} />
        )}
      </div>
    </div>
  );
}

/** A service that has not run since the app started: what pressing play will do, and the button. */
function NeverRun({
  service,
  onStart,
  where,
  deps,
}: {
  service: ServiceRow;
  onStart: () => void;
  where: string;
  deps: string[];
}) {
  const t = useT();
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
        <CirclePlay size={20} />
      </div>
      <div>
        <p className="text-[13px] font-medium text-[var(--cf-text)]">{t("services.notRunning")}</p>
        <p className="mt-1 max-w-sm text-[12px] text-[var(--cf-text-muted)]">
          {deps.length > 0
            ? t("services.neverRunWithDeps", { names: deps.join(", ") })
            : t("services.neverRun")}
        </p>
      </div>
      <code className="max-w-md truncate rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-2 py-1 text-[11px] text-[var(--cf-text)]">
        {where} $ {service.command}
      </code>
      <button
        onClick={onStart}
        className={buttonClass({ variant: "primary" })}
      >
        <CirclePlay size={13} />
        {t("services.start")}
      </button>
    </div>
  );
}

function ToolbarButton({
  onClick,
  label,
  disabled,
  danger,
  children,
}: {
  onClick: () => void;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text)] disabled:opacity-50 ${
        danger
          ? "hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
          : "hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      }`}
    >
      {children}
      {label}
    </button>
  );
}

function IconButton({ onClick, label, children }: { onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <Tooltip label={label}>
      <button
        onClick={onClick}
        aria-label={label}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
      >
        {children}
      </button>
    </Tooltip>
  );
}
