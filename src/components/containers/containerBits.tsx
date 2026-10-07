import { useEffect, useRef, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditorNS } from "monaco-editor";
import { Boxes } from "lucide-react";
import { BrandGlyph } from "../ai/ProviderGlyph";
import { Tooltip } from "../common/Tooltip";
import { RUNTIME_LOGOS } from "../../lib/containers/logos";
import type { BrandLogo } from "../../lib/icons/brandLogos";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { useThemeStore } from "../../state/themeStore";
import type { RuntimeId } from "../../types/containers";

/** A runtime's mark: Docker's whale, Podman's seals and Kubernetes' wheel; containerd (`nerdctl`,
 *  `ctr`), which has none in the sets, a box in its slate blue. */
export function RuntimeGlyph({ id, size = 14 }: { id: RuntimeId; size?: number }) {
  const logo: BrandLogo | undefined = RUNTIME_LOGOS[id];
  if (logo) return <BrandGlyph id={id} logo={logo} size={size} />;
  return <Boxes size={size} strokeWidth={2} style={{ color: "#5b7fa6" }} className="shrink-0" />;
}

/** The colour a state wears — the services' tones, so "running" means the same green everywhere. */
export function stateTone(state: string, health = ""): "ok" | "warn" | "bad" | "idle" {
  if (health === "unhealthy") return "bad";
  if (health === "starting") return "warn";
  switch (state) {
    case "running":
      return "ok";
    case "paused":
    case "restarting":
    case "created":
    case "removing":
      return "warn";
    case "dead":
      return "bad";
    default:
      return "idle";
  }
}

const TONE_COLOR: Record<string, string> = {
  ok: "var(--cf-success)",
  warn: "var(--cf-warning)",
  bad: "var(--cf-danger)",
  idle: "var(--cf-text-muted)",
};

export function StateDot({ tone, pulse = false, title }: { tone: "ok" | "warn" | "bad" | "idle"; pulse?: boolean; title?: string }) {
  return (
    <span
      aria-hidden={!title}
      title={title}
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${pulse ? "animate-pulse" : ""} ${tone === "idle" ? "opacity-50" : ""}`}
      style={{ background: TONE_COLOR[tone] }}
    />
  );
}

/** How long ago an RFC 3339 (or Docker's `2026-10-01 10:00:00 -0300 -03`) moment was, briefly. */
export function ago(stamp: string, language: string): string {
  if (!stamp) return "";
  let time = Date.parse(stamp);
  if (Number.isNaN(time)) {
    // Docker's `2026-10-01 10:00:00 -0300 -03`: date, time and offset are all there to rebuild ISO.
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2})/.exec(stamp);
    if (m) time = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  }
  if (Number.isNaN(time)) return stamp;
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  const es = language === "es";
  if (seconds < 60) return es ? `${seconds} s` : `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return es ? `${minutes} min` : `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return es ? `${hours} h` : `${hours}h`;
  const days = Math.round(hours / 24);
  return es ? `${days} d` : `${days}d`;
}

/** A small square action on a row or a header. */
export function RowAction({
  onClick,
  label,
  danger,
  disabled,
  children,
}: {
  /** Given the click, for an action that opens a menu under its button. */
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip side="top" label={label}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClick(e);
        }}
        disabled={disabled}
        aria-label={label}
        className={`inline-flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] disabled:opacity-40 ${
          danger ? "hover:text-[var(--cf-danger)]" : "hover:text-[var(--cf-text)]"
        }`}
      >
        {children}
      </button>
    </Tooltip>
  );
}

/** A worded button in a detail header — the Services console's style. */
export function HeaderAction({
  onClick,
  label,
  icon,
  danger,
  disabled,
  primary,
}: {
  onClick: () => void;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex h-[24px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] disabled:opacity-50 ${
        primary
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent)] text-[var(--cf-on-accent,#fff)] hover:opacity-90"
          : danger
            ? "border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-danger)] hover:text-[var(--cf-danger)]"
            : "border-[var(--cf-border)] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** Tabs under a detail header. */
export function DetailTabs<T extends string>({
  tabs,
  value,
  onChange,
  trailing,
}: {
  tabs: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-[var(--cf-border)] px-2">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onChange(tab.id)}
          className={`relative h-8 px-2.5 text-[12px] ${
            tab.id === value ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          }`}
        >
          {tab.label}
          {tab.id === value && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-[var(--cf-accent)]" />}
        </button>
      ))}
      <div className="flex-1" />
      {trailing}
    </div>
  );
}

const VIEW_OPTIONS: MonacoEditorNS.IStandaloneEditorConstructionOptions = {
  ...OVERFLOW_SAFE_OPTIONS,
  minimap: { enabled: false },
  fontSize: 12,
  automaticLayout: true,
  scrollBeyondLastLine: false,
  renderLineHighlight: "none",
  overviewRulerLanes: 0,
  padding: { top: 8, bottom: 8 },
  scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
  wordWrap: "off",
  folding: true,
};

/** JSON or YAML in Monaco — read-only, or editable for a manifest to apply. */
export function TextView({
  value,
  language,
  editable = false,
  onChange,
}: {
  value: string;
  language: "json" | "yaml" | "plaintext";
  editable?: boolean;
  onChange?: (next: string) => void;
}) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  return (
    <div className="min-h-0 flex-1">
      <Editor
        value={value}
        language={language}
        theme={monacoTheme}
        options={{ ...VIEW_OPTIONS, readOnly: !editable }}
        onChange={(next) => changeRef.current?.(next ?? "")}
      />
    </div>
  );
}

/** A label/value grid for a detail's facts. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0));
  return (
    <dl className="grid grid-cols-[minmax(110px,max-content)_1fr] gap-x-4 gap-y-1.5 text-[12px]">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-[var(--cf-text-muted)]">{label}</dt>
          <dd className="min-w-0 break-words text-[var(--cf-text)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h4 className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)] first:mt-0">{children}</h4>;
}

/** Re-runs `tick` every `ms` while `active`, and once at once. */
export function useInterval(tick: () => void, ms: number, active: boolean) {
  const ref = useRef(tick);
  ref.current = tick;
  useEffect(() => {
    if (!active) return;
    ref.current();
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") ref.current();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}
