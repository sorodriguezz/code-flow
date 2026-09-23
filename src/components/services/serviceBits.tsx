import { useEffect, useState } from "react";
import { Check, LoaderCircle, RotateCw } from "lucide-react";
import { openExternalUrl } from "../../lib/tauri/commands";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { Translate } from "../../state/languageStore";
import { STATUS_TONE } from "../../state/servicesStore";
import {
  serviceDeps,
  serviceDetectedPorts,
  type ReadyKind,
  type ServiceRow,
  type ServiceRuntime,
  type ServiceStatus,
} from "../../types/services";

/**
 * The small pieces every Services surface shares — the status mark, a port as a link, and the
 * sentences that explain a state — so the row, the console header and the ports table say the same
 * thing the same way.
 */

type T = Translate;

/**
 * One service's state as a mark.
 *
 * The shape carries as much as the colour, because red and green are the pair a colour-blind eye
 * separates worst: a hollow ring is stopped, a dashed one is queued, a spinner is working, a solid
 * dot is up, a check is done, and failed is the solid dot in red with a ring around it.
 */
export function StatusGlyph({ status, size = 8 }: { status: ServiceStatus; size?: number }) {
  const tone = STATUS_TONE[status];
  const box = { width: size + 4, height: size + 4 };
  switch (status) {
    case "starting":
      return (
        <span className="flex shrink-0 items-center justify-center" style={box} aria-hidden>
          <LoaderCircle size={size + 3} className="animate-spin" style={{ color: tone }} />
        </span>
      );
    case "restarting":
      return (
        <span className="flex shrink-0 items-center justify-center" style={box} aria-hidden>
          <RotateCw size={size + 2} className="animate-spin [animation-duration:1.6s]" style={{ color: tone }} />
        </span>
      );
    case "completed":
      return (
        <span className="flex shrink-0 items-center justify-center" style={box} aria-hidden>
          <Check size={size + 3} strokeWidth={3} style={{ color: tone }} />
        </span>
      );
    default: {
      const filled = status === "ready" || status === "failed" || status === "stopping";
      return (
        <span className="flex shrink-0 items-center justify-center" style={box} aria-hidden>
          <span
            className={`block rounded-full ${status === "stopping" ? "animate-pulse" : ""} ${
              status === "waiting" ? "border border-dashed" : filled ? "" : "border"
            }`}
            style={{
              width: size,
              height: size,
              background: filled ? tone : "transparent",
              borderColor: tone,
              boxShadow:
                status === "ready"
                  ? `0 0 0 3px color-mix(in srgb, ${tone} 22%, transparent)`
                  : status === "failed"
                    ? `0 0 0 3px color-mix(in srgb, ${tone} 25%, transparent)`
                    : undefined,
            }}
          />
        </span>
      );
    }
  }
}

/** A port as a link to `http://localhost:<port>`. Dimmed when it is where the service *was*. */
export function PortChip({ port, dim = false, title }: { port: number; dim?: boolean; title?: string }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void openExternalUrl(`http://localhost:${port}`);
      }}
      title={title ?? `http://localhost:${port}`}
      className={`shrink-0 rounded border px-1 font-mono text-[10px] tabular-nums leading-[15px] transition-colors ${
        dim
          ? "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          : "border-[color-mix(in_srgb,var(--cf-accent)_40%,transparent)] text-[var(--cf-accent)] hover:border-[var(--cf-accent)] hover:bg-[var(--cf-accent-soft)]"
      }`}
    >
      :{port}
    </button>
  );
}

/** Re-renders every second while `since` is set, and answers how long ago it was. */
export function useElapsed(since: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  return since ? Math.max(0, now - since) : null;
}

/** `12s`, `4m`, `2h 5m` — for a row, where space is the constraint. */
export function shortDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

export function statusLabel(status: ServiceStatus, t: T): string {
  return t(`services.status.${status}` as TranslationKey);
}

/** The ports to show for a service: live ones while it runs, and the last run's, dimmed, when it
 *  does not. */
export function portsFor(
  runtime: ServiceRuntime | undefined,
  learned: number[],
): { ports: number[]; live: boolean } {
  if (runtime?.alive && runtime.ports.length) return { ports: runtime.ports, live: true };
  const known = runtime?.knownPorts.length ? runtime.knownPorts : learned;
  return { ports: known, live: false };
}

/**
 * Why a service is where it is, as one sentence — or `null` when its status says it all.
 *
 * `nameOf` turns the service id in `blockedBy` into a name; a dependency that has been deleted
 * since is named as "another service" rather than as an id.
 */
export function explain(runtime: ServiceRuntime | undefined, nameOf: (id: string) => string | null, t: T): string | null {
  if (!runtime) return null;
  const dep = runtime.blockedBy ? (nameOf(runtime.blockedBy) ?? t("services.anotherService")) : "";
  const code = runtime.exitCode === null ? "?" : String(runtime.exitCode);
  switch (runtime.status) {
    case "waiting":
      return dep ? t("services.why.waiting", { name: dep }) : t("services.why.waitingAny");
    case "restarting":
      return t("services.why.restarting", { attempt: String(runtime.restarts), code });
    case "completed":
      return t("services.why.completed");
    case "failed":
      switch (runtime.error) {
        case "dependencyFailed":
          return t("services.why.dependencyFailed", { name: dep });
        case "dependencyStopped":
          return t("services.why.dependencyStopped", { name: dep });
        case "gateTimedOut":
          return t("services.why.gateTimedOut");
        case "exitedBeforeReady":
          return t("services.why.exitedBeforeReady", { code });
        case "spawn":
          return runtime.detail ? t("services.why.spawnDetail", { detail: runtime.detail }) : t("services.why.spawn");
        default:
          return t("services.why.exited", { code });
      }
    case "stopped":
      // Only a process that ended by itself has something to say; one the user stopped does not.
      return runtime.error === "exitedClean" ? t("services.why.exitedClean") : null;
    default:
      return null;
  }
}

/**
 * A row's tooltip: where the service is and why, then what it starts after.
 *
 * The status glyph carries the state in a shape, which is only a message to someone who has
 * learnt the shapes. This is the same state in a sentence — the one the console's banner would
 * show, or, where the banner has nothing to say, what the state means for the person hovering.
 */
export function rowHint(
  service: ServiceRow,
  runtime: ServiceRuntime | undefined,
  nameOf: (id: string) => string | null,
  t: T,
): string {
  const status = runtime?.status ?? "stopped";
  const lines: string[] = [];
  const why = explain(runtime, nameOf, t);
  if (why) {
    lines.push(why);
  } else if (status === "ready") {
    const { ports, live } = portsFor(runtime, serviceDetectedPorts(service));
    lines.push(
      live && ports.length
        ? t("services.hint.readyPorts", { ports: ports.map((port) => `:${port}`).join(", ") })
        : t("services.hint.ready"),
    );
  } else if (status === "starting") {
    lines.push(t("services.hint.starting", { ready: readyDescription(service.ready_kind, service.ready_value, t) }));
  } else if (status === "stopping") {
    lines.push(t("services.hint.stopping"));
  } else {
    lines.push(t("services.hint.stopped"));
  }
  const deps = serviceDeps(service)
    .map(nameOf)
    .filter((name): name is string => !!name);
  if (deps.length) lines.push(t("services.hint.after", { names: deps.join(", ") }));
  return lines.join("\n");
}

/** What "ready" means for this service, in words. */
export function readyDescription(kind: ReadyKind, value: string, t: T): string {
  switch (kind) {
    case "port":
      return t("services.readyWhen.portLabel", { port: value || "?" });
    case "log":
      return t("services.readyWhen.logLabel", { pattern: value || "?" });
    case "http":
      return t("services.readyWhen.httpLabel", { url: value || "?" });
    case "exit":
      return t("services.readyWhen.exitLabel");
    case "none":
      return t("services.readyWhen.noneLabel");
    default:
      return t("services.readyWhen.autoLabel");
  }
}
