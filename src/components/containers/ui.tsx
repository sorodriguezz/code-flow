import { useRef, type ReactNode } from "react";
import { ExternalLink, Loader2, Search, X } from "lucide-react";
import { useDialog } from "../../lib/useFocusTrap";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { StateDot, stateTone } from "./containerBits";
import type { PortMap } from "../../types/containers";

export { fmtBytes, fmtPercent, statusSince } from "./format";

/**
 * The pieces every page of the Contenedores manager is built from — a page's head and toolbar, its
 * table, a state pill, port chips, a sparkline, a dialog. lite-dock's views, drawn in this app's
 * tokens and at the dock's density (a 12px table, 32px rows), so a page fits a panel a third of
 * the window high and still reads as a table rather than a tree.
 */

/** The fallback for a list not read yet. One array, so a selector that falls back to it returns the
 *  same thing every time — a fresh `[]` from a zustand selector re-renders until React gives up. */
export const NO_ROWS: never[] = [];

/** A page's first row: what it is, how many, and its main actions on the right. */
export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">
      <h3 className="shrink-0 text-[13px] font-semibold text-[var(--cf-text)]">{title}</h3>
      {sub && <span className="min-w-0 truncate text-[11.5px] text-[var(--cf-text-muted)]">{sub}</span>}
      <div className="flex-1" />
      {children}
    </div>
  );
}

/** The row under a page's head: search, filters, the live mark. */
export function PageToolbar({ children }: { children: ReactNode }) {
  return <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-3">{children}</div>;
}

export function SearchField({ value, onChange, placeholder, width = 220 }: { value: string; onChange: (next: string) => void; placeholder: string; width?: number }) {
  const t = useT();
  return (
    <div className="relative min-w-0 shrink" style={{ width }}>
      <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-[26px] w-full rounded-md border border-[var(--cf-field-border)] bg-transparent pl-6 pr-6 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)] focus:border-[var(--cf-accent)]"
      />
      {value && (
        <button onClick={() => onChange("")} aria-label={t("containers.clearFilter")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
          <X size={11} />
        </button>
      )}
    </div>
  );
}

/** "En vivo" — the page reads itself again while it is on screen. */
export function LiveMark() {
  const t = useT();
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]" title={t("containers.m.liveHint")}>
      <StateDot tone="ok" pulse />
      {t("containers.m.live")}
    </span>
  );
}

/** A table that scrolls on its own under a sticky head. */
export function DataTable({ children, minWidth = 640 }: { children: ReactNode; minWidth?: number }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-separate border-spacing-0 text-[12px]" style={{ minWidth }}>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, className = "", width, align = "left" }: { children?: ReactNode; className?: string; width?: number; align?: "left" | "right" | "center" }) {
  return (
    <th
      style={width ? { width } : undefined}
      className={`sticky top-0 z-[1] h-7 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 text-[11px] font-medium text-[var(--cf-text-muted)] ${
        align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
      } ${className}`}
    >
      {children}
    </th>
  );
}

export function Td({ children, className = "", align = "left", title }: { children?: ReactNode; className?: string; align?: "left" | "right" | "center"; title?: string }) {
  return (
    <td
      title={title}
      className={`h-8 border-b border-[color-mix(in_srgb,var(--cf-border)_55%,transparent)] px-2 align-middle ${
        align === "right" ? "text-right tabular-nums" : align === "center" ? "text-center" : ""
      } ${className}`}
    >
      {children}
    </td>
  );
}

/** A row's hover and selection tint — the explorers' colours on a table row. A row that does
 *  something on a single click says so with the pointer, like a button would. */
export function trClass(selected: boolean, clickable = false): string {
  return `group transition-colors duration-100 ${selected ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"}${clickable ? " cursor-pointer" : ""}`;
}

/** The words for an engine state. */
export function useStateLabel() {
  const t = useT();
  return (state: string, health = ""): string => {
    if (health === "unhealthy") return t("containers.m.state.unhealthy");
    if (health === "starting") return t("containers.m.state.starting");
    switch (state) {
      case "running":
        return t("containers.m.state.running");
      case "paused":
        return t("containers.m.state.paused");
      case "restarting":
        return t("containers.m.state.restarting");
      case "created":
        return t("containers.m.state.created");
      case "dead":
        return t("containers.m.state.dead");
      case "removing":
        return t("containers.m.state.removing");
      default:
        return t("containers.m.state.exited");
    }
  };
}

/** A container's state as a pill: its colour, its word, and how long it has been so. */
export function StatePill({ state, health = "", since, title }: { state: string; health?: string; since?: string; title?: string }) {
  const label = useStateLabel();
  const tone = stateTone(state, health);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5" title={title}>
      <StateDot tone={tone} pulse={state === "restarting" || health === "starting"} />
      <span className={tone === "bad" ? "text-[var(--cf-danger)]" : tone === "idle" ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"}>{label(state, health)}</span>
      {since && <span className="truncate text-[11px] text-[var(--cf-text-faint)]">{since}</span>}
    </span>
  );
}

/** A port a browser can open: TCP, published on this computer. */
export function webPort(port: PortMap): number | null {
  if (!port.hostPort || port.protocol === "udp") return null;
  return port.hostPort;
}

/** Published ports as chips — one that serves the web opens in the browser while the container runs. */
export function PortChips({ ports, running }: { ports: PortMap[]; running: boolean }) {
  const t = useT();
  const published = ports.filter((p) => p.hostPort);
  if (published.length === 0) return <span className="text-[var(--cf-text-faint)]">—</span>;
  const seen = new Set<string>();
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {published.map((port) => {
        const label = `${port.hostPort}→${port.containerPort}${port.protocol === "udp" ? "/udp" : ""}`;
        if (seen.has(label)) return null;
        seen.add(label);
        const open = running ? webPort(port) : null;
        const host = port.hostIp && port.hostIp !== "0.0.0.0" && port.hostIp !== "::" ? port.hostIp : "localhost";
        return open ? (
          <button
            key={label}
            onClick={(e) => {
              e.stopPropagation();
              void openExternalUrl(`http://${host}:${open}`);
            }}
            title={t("containers.m.openPort", { url: `http://${host}:${open}` })}
            className="inline-flex items-center gap-0.5 rounded-[5px] border border-[var(--cf-border)] px-1.5 font-mono text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            {label}
            <ExternalLink size={9} />
          </button>
        ) : (
          <span key={label} className="inline-flex items-center rounded-[5px] border border-[var(--cf-border)] px-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
            {label}
          </span>
        );
      })}
    </span>
  );
}

/** A little line of the last samples — CPU, memory, network, disk. */
export function Sparkline({ values, max, color = "var(--cf-accent)", height = 36 }: { values: number[]; max?: number; color?: string; height?: number }) {
  const width = 160;
  if (values.length < 2) return <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden />;
  // Headroom over the peak: a steady series sits at four fifths of the box, not pressed to its top.
  const top = Math.max(max ?? 0, Math.max(...values, 1e-9) * 1.25);
  const step = width / (values.length - 1);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - (Math.max(0, v) / top) * (height - 4)).toFixed(1)}`);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden>
      <polyline points={`0,${height} ${points.join(" ")} ${width},${height}`} fill={color} opacity={0.12} stroke="none" />
      <polyline points={points.join(" ")} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** A modal over the window, like the app's other dialogs: Escape and the backdrop close it. */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 640,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useDialog(panel, true, onClose);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{ width }}
        className="cf-fade-in flex max-h-[calc(100vh-2rem)] max-w-[94vw] flex-col rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow-modal)]"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4">
          <h2 className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-[var(--cf-text)]">{title}</h2>
          <button onClick={onClose} aria-label="Esc" className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]">
            <X size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {footer && <div className="flex shrink-0 items-center justify-end gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">{footer}</div>}
      </div>
    </div>
  );
}

/** A labelled field in a form. */
export function Field({ label, hint, children, className = "" }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[11.5px] text-[var(--cf-text-muted)]">{label}</span>
      {children}
      {hint && <span className="text-[11px] leading-snug text-[var(--cf-text-faint)]">{hint}</span>}
    </label>
  );
}

/** A group of a form's fields under a small heading. */
export function FormSection({ title, children, trailing }: { title: ReactNode; children: ReactNode; trailing?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-[var(--cf-border)] pt-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{title}</h4>
        <div className="flex-1" />
        {trailing}
      </div>
      {children}
    </section>
  );
}

/** The one line an empty list shows — no box, no heading (the app's empty states are terse). */
export function EmptyLine({ children }: { children: ReactNode }) {
  return <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{children}</p>;
}

/** The same line while a list is read for the first time — with the spinner, so a cluster that takes
 *  seconds to answer reads as working, never as empty. */
export function LoadingLine({ children }: { children?: ReactNode }) {
  const t = useT();
  return (
    <p className="flex items-center gap-1.5 px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">
      <Loader2 size={12} className="shrink-0 animate-spin" />
      {children ?? t("containers.m.loading")}
    </p>
  );
}
