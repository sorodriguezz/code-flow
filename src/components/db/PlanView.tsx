import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Flame, ListTree, TextAlignStart } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import { ToolbarButton, formatCount } from "./dbChrome";
import { useT } from "../../state/languageStore";
import {
  hasActual,
  inclusiveMetric,
  parsePlan,
  planHotspot,
  selfMetric,
  totalOf,
  type PlanEngine,
  type PlanNode,
} from "../../lib/db/planTree";

type Mode = "tree" | "text";

/** An estimate this far from what the run counted is the planner guessing, and every choice above
 *  it was made on that guess. */
const BAD_ESTIMATE_RATIO = 10;

/**
 * The console's query plan: the engine's text drawn as a tree, with each node's own share of the
 * cost (or, after `ANALYZE`, of the time) as a bar, and the node that spends the most marked.
 *
 * The text stays one click away and is what Copy copies — it is the engine's own answer, and the
 * one to paste anywhere else. A plan `planTree` can't read opens on the text, without the switch.
 */
export function PlanView({ text, engine, analyzed }: { text: string; engine: PlanEngine; analyzed: boolean }) {
  const t = useT();
  const pillId = useId();
  const root = useMemo(() => parsePlan(text, engine), [text, engine]);
  const [mode, setMode] = useState<Mode>("tree");
  const showTree = root !== null && mode === "tree";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("db.queryPlan")}
        </span>
        {analyzed && (
          <Tooltip label={t("db.plan.analyzedHint")}>
            <span className="rounded px-1 text-[10px] font-medium text-[var(--cf-accent)]">
              {t("db.plan.analyzed")}
            </span>
          </Tooltip>
        )}
        <span className="flex-1" />
        {root && (
          <Segmented
            size="sm"
            layoutId={`cf-db-plan-${pillId}`}
            value={mode}
            onChange={setMode}
            options={[
              { value: "tree", icon: ListTree, label: t("db.plan.tree") },
              { value: "text", icon: TextAlignStart, label: t("db.plan.text") },
            ]}
          />
        )}
        <ToolbarButton onClick={() => void navigator.clipboard.writeText(text)} title={t("db.copy")}>
          <Copy size={12} />
        </ToolbarButton>
      </div>
      {showTree ? (
        <PlanTree root={root} />
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre p-2 font-mono text-[12px] text-[var(--cf-text)]">
          {text}
        </pre>
      )}
    </div>
  );
}

function PlanTree({ root }: { root: PlanNode }) {
  // By what the plan carries, not by the `analyzed` prop: an older MySQL answers `ANALYZE` with
  // the estimated plan, and its bars should show cost rather than nothing.
  const measured = useMemo(() => hasActual(root), [root]);
  const total = useMemo(() => totalOf(root), [root]);
  const hotspot = useMemo(() => planHotspot(root), [root]);
  // Folded nodes, by object: a new plan is new objects, so it opens fully expanded again.
  const [folded, setFolded] = useState<Set<PlanNode>>(() => new Set());
  const toggle = (node: PlanNode) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(node)) next.delete(node);
      else next.add(node);
      return next;
    });

  const rows: React.ReactNode[] = [];
  const visit = (node: PlanNode, depth: number, path: string) => {
    const open = !folded.has(node);
    rows.push(
      <PlanRow
        key={path}
        node={node}
        depth={depth}
        open={open}
        onToggle={() => toggle(node)}
        measured={measured}
        total={total}
        hot={node === hotspot}
      />,
    );
    if (open) node.children.forEach((child, index) => visit(child, depth + 1, `${path}.${index}`));
  };
  visit(root, 0, "0");

  return <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[12px]">{rows}</div>;
}

function PlanRow({
  node,
  depth,
  open,
  onToggle,
  measured,
  total,
  hot,
}: {
  node: PlanNode;
  depth: number;
  open: boolean;
  onToggle: () => void;
  measured: boolean;
  total: number | null;
  hot: boolean;
}) {
  const t = useT();
  const foldable = node.children.length > 0 || node.detail.length > 0;
  const self = selfMetric(node, measured);
  const inclusive = inclusiveMetric(node, measured);
  const share = total && self !== null ? Math.min(1, self / total) : null;
  const estimate = estimateRatio(node);
  const unit = measured ? " ms" : "";
  const indent = { paddingLeft: 6 + depth * 14 };

  const rowFigures = [
    node.rows !== null && `${t("db.plan.rowsEstimated")}: ${formatCount(node.rows)}`,
    node.actualRows !== null && `${t("db.plan.rowsActual")}: ${formatCount(node.actualRows)}`,
    node.loops !== null && node.loops !== 1 && `${t("db.plan.loops")}: ${formatCount(node.loops)}`,
  ].filter(Boolean);
  const figures = [
    inclusive !== null && `${t(measured ? "db.plan.time" : "db.plan.cost")}: ${formatFigure(inclusive)}${unit}`,
    self !== null && `${t("db.plan.self")}: ${formatFigure(self)}${unit}`,
    node.startupCost !== null && `${t("db.plan.startup")}: ${formatFigure(node.startupCost)}`,
    ...rowFigures,
  ].filter(Boolean);
  const badEstimate = estimate !== null && estimate >= BAD_ESTIMATE_RATIO;

  return (
    <div>
      <div
        className="group flex h-[22px] items-center gap-1.5 pr-2 hover:bg-[var(--cf-hover)]"
        style={indent}
        onClick={foldable ? onToggle : undefined}
      >
        {/* Two glyphs, not a rotated one: a `rotate` transition on an <svg> stalls in WKWebView. */}
        {open ? (
          <ChevronDown size={12} className={`shrink-0 text-[var(--cf-text-muted)] ${foldable ? "" : "invisible"}`} />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
        )}
        <Tooltip label={node.label} description={figures.length ? figures.join(" · ") : undefined}>
          <span
            className={`min-w-0 flex-1 truncate ${hot ? "font-semibold text-[var(--cf-warning)]" : "text-[var(--cf-text)]"}`}
          >
            {node.label}
          </span>
        </Tooltip>
        {hot && (
          <Tooltip label={t("db.plan.hotspot")}>
            <Flame size={12} className="shrink-0 text-[var(--cf-warning)]" aria-label={t("db.plan.hotspot")} />
          </Tooltip>
        )}
        {(node.rows !== null || node.actualRows !== null) && (
          <Tooltip
            label={badEstimate ? t("db.plan.badEstimate", { ratio: Math.round(estimate!) }) : t("db.plan.rows")}
            description={rowFigures.join(" · ")}
          >
            <span
              className={`shrink-0 tabular-nums ${badEstimate ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}
            >
              {node.actualRows !== null && `${formatCount(node.actualRows)} / `}
              {node.rows !== null ? formatCount(node.rows) : "?"}
            </span>
          </Tooltip>
        )}
        {share !== null && (
          <span className="flex w-[104px] shrink-0 items-center gap-1">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--cf-border)]">
              <span
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%`,
                  background: hot ? "var(--cf-warning)" : "var(--cf-accent)",
                }}
              />
            </span>
            <span className="w-[34px] text-right tabular-nums text-[var(--cf-text-muted)]">
              {Math.round(share * 100)}%
            </span>
          </span>
        )}
      </div>
      {open &&
        node.detail.map((line, index) => (
          <div
            key={index}
            className="whitespace-pre-wrap break-all pr-2 leading-[18px] text-[11px] text-[var(--cf-text-muted)]"
            style={{ paddingLeft: indent.paddingLeft + 18 }}
          >
            {line}
          </div>
        ))}
    </div>
  );
}

/** How many times off the row estimate was, either way; `null` until the run counted. */
function estimateRatio(node: PlanNode): number | null {
  if (node.rows === null || node.actualRows === null) return null;
  const high = Math.max(node.rows, node.actualRows);
  const low = Math.max(Math.min(node.rows, node.actualRows), 1);
  return high / low;
}

function formatFigure(value: number): string {
  if (value >= 100) return formatCount(Math.round(value));
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(2);
}
