import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { Select } from "../common/Select";
import type { FlowLogLine } from "../../lib/tauri/flowsCommands";
import { useT } from "../../state/languageStore";

/**
 * A run's log: what its processes printed, what Code nodes logged, and the engine's own lines (a
 * request and its status, a retry). Live while the run goes, with the node each line came from.
 */

const STREAM_CLASS: Record<string, string> = {
  stdout: "text-[var(--cf-text)]",
  stderr: "text-[var(--cf-danger)]",
  console: "text-[var(--cf-blue)]",
  info: "text-[var(--cf-text-muted)]",
};

function clock(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

export function LogLines({ lines, names, onlyNode }: { lines: FlowLogLine[]; names: Record<string, string>; onlyNode?: string | null }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = useMemo(() => (onlyNode ? lines.filter((line) => line.nodeId === onlyNode) : lines), [lines, onlyNode]);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);
  return (
    <div
      ref={box}
      className="min-h-0 flex-1 overflow-auto px-3 py-1.5 font-mono text-[11.5px] leading-[1.55]"
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {shown.length === 0 ? (
        <p className="py-2 font-sans text-[12px] text-[var(--cf-text-muted)]">{t("flows.log.empty")}</p>
      ) : (
        shown.map((line, index) => (
          <div key={index} className="flex min-w-0 gap-2">
            <span className="shrink-0 text-[var(--cf-text-faint)]">{clock(line.ts)}</span>
            {!onlyNode && <span className="max-w-[160px] shrink-0 truncate text-[var(--cf-text-muted)]">{names[line.nodeId] ?? line.nodeId}</span>}
            <span className={`min-w-0 whitespace-pre-wrap break-all ${STREAM_CLASS[line.stream] ?? ""}`}>{line.text}</span>
          </div>
        ))
      )}
    </div>
  );
}

export function RunLog({ lines, names, onClose }: { lines: FlowLogLine[]; names: Record<string, string>; onClose: () => void }) {
  const t = useT();
  const [node, setNode] = useState("");
  const nodes = useMemo(() => [...new Set(lines.map((line) => line.nodeId))], [lines]);
  return (
    <div className="flex h-[220px] shrink-0 flex-col border-t border-[var(--cf-border)] bg-[var(--cf-surface)]" data-tour="flows-log">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--cf-border)] pl-3 pr-2">
        <span className="text-[12px] font-semibold">{t("flows.log.title")}</span>
        <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">{lines.length}</span>
        <span className="flex-1" />
        {nodes.length > 1 && (
          <div className="w-44">
            <Select
              value={node}
              onChange={setNode}
              options={[{ value: "", label: t("flows.log.allNodes") }, ...nodes.map((id) => ({ value: id, label: names[id] ?? id }))]}
              size="sm"
            />
          </div>
        )}
        <button type="button" className={iconButtonClass({ size: "sm" })} onClick={onClose} title={t("common.close")} aria-label={t("common.close")}>
          <X size={14} />
        </button>
      </div>
      <LogLines lines={lines} names={names} onlyNode={node || null} />
    </div>
  );
}
