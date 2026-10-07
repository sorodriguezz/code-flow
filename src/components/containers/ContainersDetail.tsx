import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowDownToLine,
  ArrowUpFromLine,
  CirclePlay,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from "lucide-react";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { SessionPane } from "./SessionPane";
import { ContainerFiles } from "./ContainerFiles";
import { ContainerStats } from "./ContainerStats";
import { NO_ROWS } from "./ui";
import { confirmAction } from "../../state/confirmStore";
import { KubeDetail } from "./KubeDetail";
import { DetailTabs, Facts, HeaderAction, RowAction, SectionTitle, StateDot, TextView, ago, stateTone, useInterval } from "./containerBits";
import { engineMenu, runtimeLabel } from "./containerActions";
import { projectOptions } from "./ContainersPanel";
import { containersContainerDetail, containersText } from "../../lib/tauri/containersCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { listKey, useContainersStore } from "../../state/containersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ContainerRow, ContainerSelection, ContainerSummary, ImageRow, NetworkRow, PortMap, VolumeRow } from "../../types/containers";

export function ContainersDetail({ selection }: { selection: ContainerSelection }) {
  switch (selection.object) {
    case "container":
      return <ContainerDetail selection={selection} />;
    case "project":
      return <ProjectDetail selection={selection} />;
    case "image":
    case "volume":
    case "network":
      return <ObjectDetail selection={selection} />;
    default:
      return <KubeDetail selection={selection} />;
  }
}

/** The header every detail shares: what it is, how it is, and its actions. */
export function DetailHeader({ leading, title, subtitle, children, menu }: { leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; children?: ReactNode; menu?: MenuItem[] }) {
  const [open, setOpen] = useState<{ x: number; y: number; anchor: DOMRect } | null>(null);
  return (
    <div className="flex min-h-[40px] shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium text-[var(--cf-text)]">{title}</div>
        {subtitle && <div className="truncate text-[11px] text-[var(--cf-text-muted)]">{subtitle}</div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        {children}
        {menu && menu.length > 0 && (
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setOpen({ x: rect.left, y: rect.bottom, anchor: rect });
            }}
            aria-label="⋯"
            className="flex h-[24px] w-[24px] items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
          >
            <MoreHorizontal size={13} />
          </button>
        )}
      </div>
      {open && menu && (
        <ContextMenu
          x={open.x}
          y={open.y}
          anchor={{ top: open.anchor.top, bottom: open.anchor.bottom, left: open.anchor.left, right: open.anchor.right, align: "end" }}
          items={menu}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function PortChips({ ports }: { ports: PortMap[] }) {
  const t = useT();
  const published = ports.filter((p) => p.hostPort);
  if (published.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {published.map((p) => (
        <button
          key={`${p.hostPort}-${p.containerPort}-${p.protocol}`}
          onClick={() => void openExternalUrl(`http://localhost:${p.hostPort}`)}
          title={t("containers.openPort", { port: String(p.hostPort) })}
          className="flex items-center gap-1 rounded border border-[var(--cf-border)] px-1.5 py-[1px] font-mono text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
        >
          :{p.hostPort}
          {p.hostPort !== p.containerPort && <span className="opacity-60">→{p.containerPort}</span>}
          <ExternalLink size={9} />
        </button>
      ))}
    </span>
  );
}

function Gone() {
  const t = useT();
  return <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("containers.gone")}</p>;
}

// --------------------------------------------------------------------------------- container

type ContainerTab = "logs" | "terminal" | "stats" | "files" | "config";

/** The fallback for a list not read yet — see `ui.tsx`, where it now lives. */
export { NO_ROWS };

function useContainerRow(selection: ContainerSelection): ContainerRow | undefined {
  return useContainersStore((s) => (s.lists[listKey(selection.runtime, selection.context, null, "containers")]?.rows as ContainerRow[] | undefined)?.find((r) => r.id === selection.id));
}

/** Back to the list the detail was opened from. */
export function BackButton({ label }: { label: string }) {
  const select = useContainersStore((s) => s.select);
  return (
    <RowAction label={label} onClick={() => select(null)}>
      <ArrowLeft size={14} />
    </RowAction>
  );
}

/**
 * A container's page — lite-dock's: what it is and how it is in the head, its actions beside it,
 * and five tabs: its log, a shell inside it, its live stats and limits, its files, and its
 * configuration as something to read (the inspect document is one switch away, not the view).
 */
function ContainerDetail({ selection }: { selection: ContainerSelection }) {
  const t = useT();
  const row = useContainerRow(selection);
  const act = useContainersStore((s) => s.act);
  const select = useContainersStore((s) => s.select);
  const busy = useContainersStore((s) => s.busy[`container|${selection.id}`]);
  const [tab, setTab] = useState<ContainerTab>("logs");
  const [visited, setVisited] = useState<Set<ContainerTab>>(new Set(["logs"]));
  const [tail, setTail] = useState("500");
  const [timestamps, setTimestamps] = useState(false);
  const [raw, setRaw] = useState(false);
  const ctr = selection.runtime === "ctr";
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set([...v, tab]))), [tab]);
  if (!row) return <Gone />;
  const running = row.state === "running";
  const place = selection.context || runtimeLabel(selection.runtime, t);
  const run = (action: string, label: TranslationKey) => void act({ runtime: selection.runtime, context: selection.context, object: "container", action, ids: [row.id], label: t(label, { name: row.name }) });
  const tabs: { id: ContainerTab; label: string }[] = ctr
    ? [{ id: "config", label: t("containers.m.tab.config") }]
    : [
        { id: "logs", label: t("containers.tab.logs") },
        { id: "terminal", label: t("containers.tab.terminal") },
        { id: "stats", label: t("containers.m.tab.stats") },
        { id: "files", label: t("containers.m.tab.files") },
        { id: "config", label: t("containers.m.tab.config") },
      ];
  const current = ctr ? "config" : tab;
  const menu = engineMenu({ runtime: selection.runtime, context: selection.context, object: "container", row, t, act, select: () => select(selection) });
  return (
    <>
      <DetailHeader
        leading={
          <span className="flex items-center gap-1.5">
            <BackButton label={t("containers.m.backToList")} />
            {busy ? <Loader2 size={12} className="shrink-0 animate-spin text-[var(--cf-text-muted)]" /> : <StateDot tone={stateTone(row.state, row.health)} title={row.status} />}
          </span>
        }
        title={
          <span className="flex items-center gap-2">
            {row.name}
            <PortChips ports={row.ports} />
          </span>
        }
        subtitle={[row.image, row.status, row.project && `${row.project}${row.service ? ` / ${row.service}` : ""}`].filter(Boolean).join(" · ")}
        menu={menu}
      >
        {running ? (
          <>
            {!ctr && <HeaderAction icon={<RotateCw size={11} />} label={t("containers.restart")} disabled={busy} onClick={() => run("restart", "containers.done.restart")} />}
            {!ctr && <HeaderAction icon={<Pause size={11} />} label={t("containers.pause")} disabled={busy} onClick={() => run("pause", "containers.done.pause")} />}
            <HeaderAction icon={<Square size={11} />} label={t("containers.stop")} disabled={busy} onClick={() => run("stop", "containers.done.stop")} />
          </>
        ) : row.state === "paused" ? (
          <HeaderAction primary icon={<Play size={11} />} label={t("containers.unpause")} disabled={busy} onClick={() => run("unpause", "containers.done.unpause")} />
        ) : (
          <HeaderAction primary icon={<Play size={11} />} label={t("containers.start")} disabled={busy} onClick={() => run("start", "containers.done.start")} />
        )}
        <HeaderAction
          danger
          icon={<Trash2 size={11} />}
          label={t("containers.remove")}
          disabled={busy}
          onClick={async () => {
            if (!(await confirmAction(t("containers.confirmRemoveContainer", { name: row.name, context: place }), true, t("containers.remove")))) return;
            const done = await act({ runtime: selection.runtime, context: selection.context, object: "container", action: "remove", ids: [row.id], label: t("containers.done.remove", { name: row.name }) });
            if (done !== null) select(null);
          }}
        />
      </DetailHeader>
      <DetailTabs
        tabs={tabs}
        value={current}
        onChange={setTab}
        trailing={
          current === "logs" ? (
            <span className="flex items-center gap-2 text-[11px] text-[var(--cf-text-muted)]">
              <label className="flex items-center gap-1">
                <Checkbox checked={timestamps} onChange={setTimestamps} />
                {t("containers.timestamps")}
              </label>
              <div className="w-[124px]">
                <Select
                  size="sm"
                  value={tail}
                  onChange={setTail}
                  options={[
                    { value: "100", label: t("containers.tail", { count: 100 }) },
                    { value: "500", label: t("containers.tail", { count: 500 }) },
                    { value: "2000", label: t("containers.tail", { count: 2000 }) },
                    { value: "100000", label: t("containers.tailAll") },
                  ]}
                  ariaLabel={t("containers.tailLabel")}
                />
              </div>
            </span>
          ) : current === "config" ? (
            <Segmented
              layoutId="container-config-view"
              size="sm"
              value={raw ? "json" : "summary"}
              onChange={(view) => setRaw(view === "json")}
              options={[
                { value: "summary", label: t("containers.m.config.summary") },
                { value: "json", label: "JSON" },
              ]}
            />
          ) : null
        }
      />
      <div className="relative flex min-h-0 flex-1">
        {!ctr && visited.has("logs") && (
          <SessionPane
            visible={current === "logs"}
            liveToken={running ? "up" : "down"}
            request={{ kind: "logs", runtime: selection.runtime, context: selection.context, target: row.id, tail: Number(tail), timestamps }}
          />
        )}
        {!ctr && visited.has("terminal") && (running ? (
          <SessionPane visible={current === "terminal"} request={{ kind: "exec", runtime: selection.runtime, context: selection.context, target: row.id }} />
        ) : (
          current === "terminal" && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
              {t("containers.notRunningContainer")}
              <HeaderAction primary icon={<Play size={11} />} label={t("containers.start")} onClick={() => run("start", "containers.done.start")} />
            </div>
          )
        ))}
        {current === "stats" && <ContainerStats runtime={selection.runtime} context={selection.context} id={row.id} running={running} memoryLimit={null} cpuLimit={null} />}
        {current === "files" && <ContainerFiles runtime={selection.runtime} context={selection.context} id={row.id} running={running} />}
        {current === "config" && (raw ? <InspectView selection={selection} object="container" id={row.id} /> : <ContainerInfo selection={selection} row={row} />)}
      </div>
    </>
  );
}

function ContainerInfo({ selection, row }: { selection: ContainerSelection; row: ContainerRow }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [summary, setSummary] = useState<ContainerSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Set<string>>(new Set());
  const running = row.state === "running";
  useInterval(
    () => {
      containersContainerDetail(selection.runtime, selection.context, row.id, running)
        .then((s) => {
          setSummary(s);
          setError(null);
        })
        .catch((e: unknown) => setError(String(e)));
    },
    running ? 5000 : 60000,
    true,
  );
  if (error && !summary) return <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>;
  if (!summary)
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--cf-text-muted)]">
        <Loader2 size={14} className="animate-spin" />
      </div>
    );
  const asText = (value: string[] | string | null) => (Array.isArray(value) ? value.join(" ") : value ?? "");
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <Facts
        rows={[
          [t("containers.fact.image"), summary.image],
          [t("containers.fact.command"), <span className="font-mono text-[11.5px]">{[asText(summary.entrypoint), asText(summary.command)].filter(Boolean).join(" ")}</span>],
          [t("containers.fact.workingDir"), summary.workingDir],
          [t("containers.fact.created"), summary.created ? `${new Date(summary.created).toLocaleString()} (${ago(summary.created, language)})` : null],
          [t("containers.fact.started"), running && summary.startedAt ? `${new Date(summary.startedAt).toLocaleString()} (${ago(summary.startedAt, language)})` : null],
          [t("containers.fact.finished"), !running && summary.finishedAt && !summary.finishedAt.startsWith("0001") ? new Date(summary.finishedAt).toLocaleString() : null],
          [t("containers.fact.exitCode"), !running && summary.exitCode !== null ? `${summary.exitCode}${summary.oomKilled ? " · OOMKilled" : ""}` : null],
          [t("containers.fact.restarts"), summary.restartCount ? String(summary.restartCount) : null],
          [t("containers.fact.restartPolicy"), summary.restartPolicy || null],
          [t("containers.fact.health"), summary.health],
          [t("containers.fact.id"), <span className="font-mono text-[11px]">{row.id}</span>],
        ]}
      />
      {summary.healthLog.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.healthLog")}</SectionTitle>
          <ul className="flex flex-col gap-1 font-mono text-[11px] text-[var(--cf-text-muted)]">
            {summary.healthLog.map((entry, i) => (
              <li key={i} className="truncate" title={entry.output}>
                <span className={entry.exitCode === 0 ? "text-[var(--cf-success)]" : "text-[var(--cf-danger)]"}>{entry.exitCode}</span> {entry.output}
              </li>
            ))}
          </ul>
        </>
      )}
      {summary.ports.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.ports")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 font-mono text-[11.5px]">
            {summary.ports.map((p) => (
              <li key={`${p.containerPort}/${p.protocol}-${p.hostPort}`} className="flex items-center gap-2">
                <span className="text-[var(--cf-text)]">
                  {p.containerPort}/{p.protocol}
                </span>
                {p.hostPort ? (
                  <button onClick={() => void openExternalUrl(`http://localhost:${p.hostPort}`)} className="text-[var(--cf-accent)] hover:underline">
                    → {p.hostIp && p.hostIp !== "0.0.0.0" ? p.hostIp : "localhost"}:{p.hostPort}
                  </button>
                ) : (
                  <span className="text-[var(--cf-text-muted)]">{t("containers.notPublished")}</span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {summary.mounts.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.mounts")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 text-[11.5px]">
            {summary.mounts.map((m) => (
              <li key={`${m.source}->${m.destination}`} className="flex min-w-0 items-center gap-2">
                <span className="shrink-0 rounded bg-[var(--cf-hover)] px-1 text-[10.5px] text-[var(--cf-text-muted)]">{m.type}</span>
                <span className="min-w-0 truncate font-mono text-[var(--cf-text)]" title={m.source}>
                  {m.source}
                </span>
                <span className="shrink-0 text-[var(--cf-text-muted)]">→</span>
                <span className="min-w-0 truncate font-mono text-[var(--cf-text)]">{m.destination}</span>
                {m.readOnly && <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">ro</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {summary.networks.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.networks")}</SectionTitle>
          <Facts rows={summary.networks.map((n) => [n.name, <span className="font-mono text-[11.5px]">{n.ip || "—"}</span>] as [string, ReactNode])} />
        </>
      )}
      {summary.env.length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.env")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 font-mono text-[11.5px]">
            {summary.env.map((v) => (
              <li key={v.name} className="flex min-w-0 items-center gap-1">
                <span className="shrink-0 text-[var(--cf-text-muted)]">{v.name}=</span>
                <span className="min-w-0 truncate text-[var(--cf-text)]">{v.secret && !reveal.has(v.name) ? "••••••" : v.value}</span>
                {v.secret && (
                  <RowAction
                    label={reveal.has(v.name) ? t("containers.hideValue") : t("containers.showValue")}
                    onClick={() =>
                      setReveal((r) => {
                        const next = new Set(r);
                        if (next.has(v.name)) next.delete(v.name);
                        else next.add(v.name);
                        return next;
                      })
                    }
                  >
                    {reveal.has(v.name) ? <EyeOff size={10} /> : <Eye size={10} />}
                  </RowAction>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {Object.keys(summary.labels ?? {}).length > 0 && (
        <>
          <SectionTitle>{t("containers.fact.labels")}</SectionTitle>
          <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
            {Object.entries(summary.labels).map(([k, v]) => (
              <li key={k} className="truncate" title={`${k}=${v}`}>
                {k}=<span className="text-[var(--cf-text)]">{v}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** An engine object's inspect document, read once (and again on demand). */
function InspectView({ selection, object, id }: { selection: ContainerSelection; object: string; id: string }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    containersText({ runtime: selection.runtime, context: selection.context, object, id, view: "inspect" })
      .then((value) => !cancelled && setText(value))
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [selection.runtime, selection.context, object, id, tick]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 justify-end gap-1 px-2 pt-1">
        <RowAction label={t("containers.copyAll")} onClick={() => text && void navigator.clipboard.writeText(text)}>
          <Copy size={11} />
        </RowAction>
        <RowAction label={t("containers.refresh")} onClick={() => setTick((n) => n + 1)}>
          <RefreshCw size={11} />
        </RowAction>
      </div>
      {error ? <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p> : text === null ? null : <TextView value={text} language="json" />}
    </div>
  );
}

// ----------------------------------------------------------------------------------- project

type ProjectTab = "logs" | "containers";

function ProjectDetail({ selection }: { selection: ContainerSelection }) {
  const t = useT();
  const all = useContainersStore((s) => s.lists[listKey(selection.runtime, selection.context, null, "containers")]?.rows as ContainerRow[] | undefined);
  // Filtered outside the selector: a `.filter` inside it is a new array on every read, which zustand
  // takes for a change — the pane re-rendered until React stopped it, taking the window down.
  const rows = useMemo(() => (all ?? NO_ROWS).filter((r) => r.project === selection.id), [all, selection.id]);
  const act = useContainersStore((s) => s.act);
  const select = useContainersStore((s) => s.select);
  const [tab, setTab] = useState<ProjectTab>("logs");
  const [visited, setVisited] = useState<Set<ProjectTab>>(new Set(["logs"]));
  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set([...v, tab]))), [tab]);
  const options = useMemo(() => projectOptions(rows), [rows]);
  if (rows.length === 0) return <Gone />;
  const name = selection.id;
  const up = rows.filter((r) => r.state === "running").length;
  const run = (action: string, label: TranslationKey) => void act({ runtime: selection.runtime, context: selection.context, object: "project", action, ids: [name], options, label: t(label, { name }) });
  const menu = engineMenu({ runtime: selection.runtime, context: selection.context, object: "project", project: { name, rows }, t, act, select: () => select(selection) });
  return (
    <>
      <DetailHeader
        leading={<StateDot tone={up === rows.length ? "ok" : up === 0 ? "idle" : "warn"} />}
        title={name}
        subtitle={[t("containers.projectCount", { up, total: rows.length }), options.projectDir].filter(Boolean).join(" · ")}
        menu={menu}
      >
        {options.configFiles && <HeaderAction icon={<ArrowUpFromLine size={11} />} label={t("containers.project.up")} onClick={() => menu.find((i) => i.label === t("containers.project.up"))?.onClick()} />}
        {up > 0 ? (
          <>
            <HeaderAction icon={<RotateCw size={11} />} label={t("containers.project.restart")} onClick={() => run("restart", "containers.done.restart")} />
            <HeaderAction icon={<Square size={11} />} label={t("containers.project.stop")} onClick={() => run("stop", "containers.done.stop")} />
          </>
        ) : (
          <HeaderAction primary icon={<Play size={11} />} label={t("containers.project.start")} onClick={() => run("start", "containers.done.start")} />
        )}
        <HeaderAction danger icon={<ArrowDownToLine size={11} />} label={t("containers.project.down")} onClick={() => menu.find((i) => i.danger)?.onClick()} />
      </DetailHeader>
      <DetailTabs
        tabs={[
          { id: "logs", label: t("containers.tab.logs") },
          { id: "containers", label: t("containers.section.containers") },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="relative flex min-h-0 flex-1">
        {visited.has("logs") && (
          <SessionPane
            visible={tab === "logs"}
            liveToken={up > 0 ? "up" : "down"}
            request={{ kind: "projectLogs", runtime: selection.runtime, context: selection.context, target: name, tail: 300, projectDir: options.projectDir, configFiles: options.configFiles }}
          />
        )}
        {tab === "containers" && (
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <table className="w-full text-[12px]">
              <tbody>
                {rows
                  .slice()
                  .sort((a, b) => a.service.localeCompare(b.service))
                  .map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => select({ runtime: selection.runtime, context: selection.context, namespace: null, object: "container", id: row.id, name: row.name })}
                      className="cursor-default hover:bg-[var(--cf-hover)]"
                    >
                      <td className="w-4 py-1 pl-1">
                        <StateDot tone={stateTone(row.state, row.health)} />
                      </td>
                      <td className="py-1 pr-3 text-[var(--cf-text)]">{row.service || row.name}</td>
                      <td className="py-1 pr-3 text-[var(--cf-text-muted)]">{row.image}</td>
                      <td className="py-1 pr-3 text-[var(--cf-text-muted)]">{row.status}</td>
                      <td className="py-1">
                        <PortChips ports={row.ports} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------------ image / volume / net

function ObjectDetail({ selection }: { selection: ContainerSelection }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const what = selection.object === "image" ? "images" : selection.object === "volume" ? "volumes" : "networks";
  const row = useContainersStore((s) => {
    const rows = (s.lists[listKey(selection.runtime, selection.context, null, what)]?.rows ?? []) as (ImageRow | VolumeRow | NetworkRow)[];
    return rows.find((r) => ("reference" in r ? r.reference === selection.id : r.name === selection.id));
  });
  const containers = (useContainersStore((s) => s.lists[listKey(selection.runtime, selection.context, null, "containers")]?.rows) ?? NO_ROWS) as ContainerRow[];
  const act = useContainersStore((s) => s.act);
  const select = useContainersStore((s) => s.select);
  if (!row) return <Gone />;
  const object = selection.object as "image" | "volume" | "network";
  const menu = engineMenu({
    runtime: selection.runtime,
    context: selection.context,
    object,
    id: selection.id,
    image: object === "image" ? (row as ImageRow) : undefined,
    network: object === "network" ? (row as NetworkRow) : undefined,
    t,
    act,
    select: () => select(selection),
  });
  const removable = menu.find((i) => i.danger);
  const image = object === "image" ? (row as ImageRow) : null;
  const usedBy = image ? containers.filter((c) => c.image === image.reference || c.image === `${image.repository}:${image.tag}` || (image.tag === "latest" && c.image === image.repository)) : [];
  const runItem = menu.find((i) => i.icon === CirclePlay || i.label === t("containers.image.run"));
  return (
    <>
      <DetailHeader
        title={selection.id}
        subtitle={
          image
            ? [image.size, image.created && ago(image.created, language), image.id.slice(0, 12)].filter(Boolean).join(" · ")
            : object === "volume"
              ? [(row as VolumeRow).driver, (row as VolumeRow).project].filter(Boolean).join(" · ")
              : [(row as NetworkRow).driver, (row as NetworkRow).scope].filter(Boolean).join(" · ")
        }
        menu={menu}
      >
        {runItem && <HeaderAction icon={<Play size={11} />} label={t("containers.image.run")} onClick={runItem.onClick} />}
        {removable && <HeaderAction danger icon={<Trash2 size={11} />} label={t("containers.remove")} onClick={removable.onClick} />}
      </DetailHeader>
      {image && usedBy.length > 0 && (
        <div className="shrink-0 border-b border-[var(--cf-border)] px-3 py-2 text-[12px]">
          <span className="mr-2 text-[var(--cf-text-muted)]">{t("containers.fact.usedBy")}</span>
          {usedBy.map((c) => (
            <button
              key={c.id}
              onClick={() => select({ runtime: selection.runtime, context: selection.context, namespace: null, object: "container", id: c.id, name: c.name })}
              className="mr-2 inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline"
            >
              <StateDot tone={stateTone(c.state, c.health)} />
              {c.name}
            </button>
          ))}
        </div>
      )}
      {selection.runtime === "ctr" ? (
        <div className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("containers.ctrLimited")}</div>
      ) : (
        <InspectView selection={selection} object={object} id={image ? (image.dangling ? image.id : image.reference) : selection.id} />
      )}
    </>
  );
}
