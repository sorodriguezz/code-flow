import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { fieldClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import {
  buildChart,
  COUNT_ROWS,
  defaultCategoryColumn,
  defaultValueColumns,
  niceTicks,
  numericColumns,
} from "../../lib/db/chartData";
import type { DbColumn } from "../../types/database";

/** Series colours, from the theme so a chart reads in light and dark alike. */
const PALETTE = [
  "var(--cf-accent)",
  "var(--cf-success)",
  "var(--cf-warning)",
  "var(--cf-danger)",
  "color-mix(in oklab, var(--cf-accent) 50%, var(--cf-success))",
  "color-mix(in oklab, var(--cf-warning) 50%, var(--cf-danger))",
];

type Kind = "bar" | "line" | "pie";

/**
 * A result drawn as a chart — bars, a line or a pie — from a category column and up to four numeric
 * ones. Hand-drawn SVG: three shapes do not justify a charting library in the bundle, and an SVG
 * scales with the panel for free. What it draws is `lib/db/chartData`; this is only the picture.
 */
export function ResultChart({ columns, rows }: { columns: DbColumn[]; rows: (string | null)[][] }) {
  const t = useT();
  const numeric = useMemo(() => numericColumns(columns, rows), [columns, rows]);
  const [kind, setKind] = useState<Kind>("bar");
  const [x, setX] = useState(() => defaultCategoryColumn(columns, rows));
  const [ys, setYs] = useState<number[]>(() => defaultValueColumns(columns, rows, x));

  // A new result is new columns: the picks made against the last one may name nothing here.
  useEffect(() => {
    const nextX = defaultCategoryColumn(columns, rows);
    setX(nextX);
    setYs(defaultValueColumns(columns, rows, nextX));
  }, [columns, rows]);

  const countLabel = t("db.chart.count");
  const data = useMemo(() => {
    const built = buildChart(rows, x, ys, columns);
    return { ...built, series: built.series.map((series, at) => (ys[at] === COUNT_ROWS ? { ...series, name: countLabel } : series)) };
  }, [rows, x, ys, columns, countLabel]);

  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 600, height: 240 });
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const toggleY = (index: number) =>
    setYs((current) =>
      current.includes(index) ? current.filter((entry) => entry !== index) : [...current, index].slice(-4),
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1 text-[11px] text-[var(--cf-text-muted)]">
        <Segmented
          size="sm"
          layoutId="cf-db-chart-kind"
          value={kind}
          onChange={(value) => setKind(value as Kind)}
          options={[
            { value: "bar", label: t("db.chart.bar") },
            { value: "line", label: t("db.chart.line") },
            { value: "pie", label: t("db.chart.pie") },
          ]}
        />
        {/* Both axes are searchable dropdowns: a result of a hundred fields used to lay every
            numeric one out as a chip in this bar, which wrapped into a wall (user, 2026-11-19). */}
        <span>{t("db.chart.x")}</span>
        <ColumnPicker
          label={columns[x]?.name ?? ""}
          options={columns.map((column, index) => ({ value: index, label: column.name }))}
          selected={[x]}
          onToggle={(index) => setX(index)}
          single
        />
        <span>{t("db.chart.y")}</span>
        <ColumnPicker
          label={
            ys.length === 0
              ? t("db.chart.none")
              : ys.length === 1
                ? ys[0] === COUNT_ROWS
                  ? t("db.chart.count")
                  : (columns[ys[0]]?.name ?? "")
                : t("db.chart.seriesN", { n: String(ys.length) })
          }
          options={[
            { value: COUNT_ROWS, label: t("db.chart.count") },
            ...numeric.filter((index) => index !== x).map((index) => ({ value: index, label: columns[index].name })),
          ]}
          selected={ys}
          onToggle={toggleY}
          swatch={(value) => {
            const at = ys.indexOf(value);
            return at >= 0 ? PALETTE[at % PALETTE.length] : null;
          }}
        />
        {data.clipped && <span className="text-[var(--cf-warning)]">{t("db.chart.clipped", { n: "200" })}</span>}
      </div>
      <div ref={box} className="relative min-h-0 flex-1 overflow-hidden">
        {ys.length === 0 || data.categories.length === 0 ? (
          <p className="flex h-full items-center justify-center text-[12px] text-[var(--cf-text-muted)]">
            {t("db.chart.pickY")}
          </p>
        ) : kind === "pie" ? (
          <Pie data={data} width={size.width} height={size.height} />
        ) : (
          <Axes data={data} kind={kind} width={size.width} height={size.height} />
        )}
      </div>
    </div>
  );
}

const PAD = { left: 48, right: 12, top: 12, bottom: 44 };

function Axes({
  data,
  kind,
  width,
  height,
}: {
  data: ReturnType<typeof buildChart>;
  kind: "bar" | "line";
  width: number;
  height: number;
}) {
  const values = data.series.flatMap((series) => series.values);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const low = ticks[0];
  const high = ticks[ticks.length - 1];
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = Math.max(10, height - PAD.top - PAD.bottom);
  const y = (value: number) => PAD.top + plotH - ((value - low) / (high - low || 1)) * plotH;
  const band = plotW / data.categories.length;
  const barW = Math.max(1, (band * 0.8) / data.series.length);
  // Label every nth category, so the axis never turns into a smear of overlapping names.
  const every = Math.max(1, Math.ceil(data.categories.length / Math.max(1, Math.floor(plotW / 60))));
  return (
    <svg width={width} height={height} className="block text-[10px]">
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--cf-border)" />
          <text x={PAD.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle" fill="var(--cf-text-muted)">
            {formatTick(tick)}
          </text>
        </g>
      ))}
      {data.categories.map((category, index) =>
        index % every === 0 ? (
          <text
            key={index}
            x={PAD.left + band * index + band / 2}
            y={height - PAD.bottom + 14}
            textAnchor="middle"
            fill="var(--cf-text-muted)"
          >
            <title>{category}</title>
            {category.length > 12 ? `${category.slice(0, 11)}…` : category}
          </text>
        ) : null,
      )}
      {data.series.map((series, at) =>
        kind === "bar" ? (
          series.values.map((value, index) => {
            const top = y(Math.max(0, value));
            const bottom = y(Math.min(0, value));
            return (
              <rect
                key={`${at}-${index}`}
                x={PAD.left + band * index + band * 0.1 + barW * at}
                y={top}
                width={barW}
                height={Math.max(1, bottom - top)}
                fill={PALETTE[at % PALETTE.length]}
                rx={1.5}
              >
                <title>{`${data.categories[index]} · ${series.name}: ${value}`}</title>
              </rect>
            );
          })
        ) : (
          <g key={at}>
            <polyline
              fill="none"
              stroke={PALETTE[at % PALETTE.length]}
              strokeWidth={2}
              points={series.values.map((value, index) => `${PAD.left + band * index + band / 2},${y(value)}`).join(" ")}
            />
            {series.values.map((value, index) => (
              <circle
                key={index}
                cx={PAD.left + band * index + band / 2}
                cy={y(value)}
                r={2.5}
                fill={PALETTE[at % PALETTE.length]}
              >
                <title>{`${data.categories[index]} · ${series.name}: ${value}`}</title>
              </circle>
            ))}
          </g>
        ),
      )}
      <Legend names={data.series.map((series) => series.name)} x={PAD.left} y={height - 12} />
    </svg>
  );
}

function Pie({ data, width, height }: { data: ReturnType<typeof buildChart>; width: number; height: number }) {
  const values = data.series[0].values.map((value) => Math.max(0, value));
  const total = values.reduce((sum, value) => sum + value, 0) || 1;
  const radius = Math.max(10, Math.min(width, height) / 2 - 24);
  const cx = width / 2;
  const cy = height / 2;
  let angle = -Math.PI / 2;
  return (
    <svg width={width} height={height} className="block text-[10px]">
      {values.map((value, index) => {
        const sweep = (value / total) * Math.PI * 2;
        const start = angle;
        angle += sweep;
        const large = sweep > Math.PI ? 1 : 0;
        const [x1, y1] = [cx + radius * Math.cos(start), cy + radius * Math.sin(start)];
        const [x2, y2] = [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
        const path =
          sweep >= Math.PI * 2 - 1e-9
            ? `M ${cx - radius} ${cy} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`
            : `M ${cx} ${cy} L ${x1} ${y1} A ${radius} ${radius} 0 ${large} 1 ${x2} ${y2} Z`;
        return (
          <path
            key={index}
            d={path}
            fill={PALETTE[index % PALETTE.length]}
            stroke="var(--cf-surface)"
            strokeWidth={1}
            opacity={0.55 + 0.45 * ((index % 3) / 2)}
          >
            <title>{`${data.categories[index]}: ${value} (${((value / total) * 100).toFixed(1)} %)`}</title>
          </path>
        );
      })}
    </svg>
  );
}

function Legend({ names, x, y }: { names: string[]; x: number; y: number }) {
  let at = x;
  return (
    <g>
      {names.map((name, index) => {
        const left = at;
        at += 18 + name.length * 6;
        return (
          <g key={name}>
            <rect x={left} y={y - 7} width={8} height={8} rx={1.5} fill={PALETTE[index % PALETTE.length]} />
            <text x={left + 11} y={y} fill="var(--cf-text-muted)">
              {name}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(0)}k`;
  return String(value);
}

/**
 * A column dropdown with a search box: one pick for X, several for Y (`single` off — the list stays
 * open and each click toggles). Portalled, so the chart's own clipping never cuts it short.
 */
function ColumnPicker({
  label,
  options,
  selected,
  onToggle,
  single = false,
  swatch,
}: {
  label: string;
  options: { value: number; label: string }[];
  selected: number[];
  onToggle: (value: number) => void;
  single?: boolean;
  swatch?: (value: number) => string | null;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.bottom + 4, left: Math.min(rect.left, window.innerWidth - 268) });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!popRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const needle = query.trim().toLowerCase();
  const filtered = needle ? options.filter((option) => option.label.toLowerCase().includes(needle)) : options;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => {
          setQuery("");
          setOpen((value) => !value);
        }}
        className="flex h-[22px] max-w-[220px] items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 text-[11px] text-[var(--cf-text)] hover:border-[var(--cf-accent)]"
      >
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
      </button>
      {open &&
        createPortal(
          <div
            ref={popRef}
            style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
            className="fixed z-[9999] flex max-h-[min(360px,60vh)] w-[260px] flex-col rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            <div className="relative shrink-0 p-1.5">
              <Search size={12} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && filtered.length > 0) {
                    onToggle(filtered[0].value);
                    if (single) setOpen(false);
                  }
                }}
                placeholder={t("db.chart.searchColumns")}
                spellCheck={false}
                className={fieldClass({ size: "sm", className: "w-full pl-6" })}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1 pt-0">
              {filtered.map((option) => {
                const on = selected.includes(option.value);
                const color = swatch?.(option.value) ?? null;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      onToggle(option.value);
                      if (single) setOpen(false);
                    }}
                    className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[11.5px] hover:bg-[var(--cf-hover)] ${
                      on ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
                    }`}
                  >
                    {swatch ? (
                      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color ?? "var(--cf-border)" }} />
                    ) : (
                      <Check size={11} className={`shrink-0 ${on ? "text-[var(--cf-accent)]" : "opacity-0"}`} />
                    )}
                    <span className="min-w-0 truncate">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
