import { forwardRef, useLayoutEffect, useRef, useState } from "react";
import { KeyRound, Table2 } from "lucide-react";
import type { DbmlSchema } from "../../lib/dbml";
import { useT } from "../../state/languageStore";
import { EmptyState } from "../common/EmptyState";

interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
}

export const DbmlDiagram = forwardRef<HTMLDivElement, { schema: DbmlSchema; onScroll?: () => void }>(
  function DbmlDiagram({ schema, onScroll }, ref) {
    const t = useT();
    const contentRef = useRef<HTMLDivElement>(null);
    const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
    const [lines, setLines] = useState<Line[]>([]);
    const [contentSize, setContentSize] = useState({ w: 0, h: 0 });

    useLayoutEffect(() => {
      const content = contentRef.current;
      if (!content) return;

      const recompute = () => {
        const next: Line[] = [];
        for (const r of schema.refs) {
          const fromEl = cardRefs.current.get(r.fromTable);
          const toEl = cardRefs.current.get(r.toTable);
          if (!fromEl || !toEl || fromEl === toEl) continue;
          next.push({
            x1: fromEl.offsetLeft + fromEl.offsetWidth / 2,
            y1: fromEl.offsetTop + fromEl.offsetHeight / 2,
            x2: toEl.offsetLeft + toEl.offsetWidth / 2,
            y2: toEl.offsetTop + toEl.offsetHeight / 2,
            label: `${r.fromField} → ${r.toField}`,
          });
        }
        setLines(next);
        setContentSize({ w: content.scrollWidth, h: content.scrollHeight });
      };

      recompute();
      const observer = new ResizeObserver(recompute);
      observer.observe(content);
      return () => observer.disconnect();
    }, [schema]);

    if (schema.error) {
      return (
        <div className="h-full overflow-auto p-4">
          <p className="rounded-md border border-[var(--cf-danger)] bg-[color-mix(in_oklab,var(--cf-danger)_10%,transparent)] p-3 font-mono text-[12px] text-[var(--cf-danger)]">
            {schema.error}
          </p>
        </div>
      );
    }

    if (schema.tables.length === 0) {
      return <EmptyState icon={Table2} title={t("editor.dbmlEmpty")} />;
    }

    return (
      <div ref={ref} onScroll={onScroll} className="h-full overflow-auto p-4">
        <div ref={contentRef} className="relative">
          <svg
            className="pointer-events-none absolute left-0 top-0"
            width={contentSize.w}
            height={contentSize.h}
            style={{ overflow: "visible" }}
          >
            {lines.map((l, i) => (
              <g key={i}>
                <line
                  x1={l.x1}
                  y1={l.y1}
                  x2={l.x2}
                  y2={l.y2}
                  stroke="var(--cf-accent)"
                  strokeOpacity={0.55}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                />
              </g>
            ))}
          </svg>
          <div className="relative flex flex-wrap gap-4">
            {schema.tables.map((table) => (
              <div
                key={table.name}
                ref={(el) => {
                  if (el) cardRefs.current.set(table.name, el);
                  else cardRefs.current.delete(table.name);
                }}
                className="w-[240px] shrink-0 overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-sm"
              >
                <div className="flex items-center gap-1.5 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-2.5 py-1.5">
                  <Table2 size={12} className="shrink-0 text-[var(--cf-accent)]" />
                  <span className="truncate text-[12px] font-semibold text-[var(--cf-text)]">{table.name}</span>
                </div>
                <div className="divide-y divide-[var(--cf-border)]">
                  {table.columns.map((col) => (
                    <div key={col.name} className="flex items-center justify-between gap-2 px-2.5 py-1 text-[11px]">
                      <span className="flex min-w-0 items-center gap-1 font-mono text-[var(--cf-text)]">
                        {col.pk && <KeyRound size={10} className="shrink-0 text-[var(--cf-warning)]" />}
                        <span className="truncate">{col.name}</span>
                        {col.notNull && <span className="shrink-0 text-[var(--cf-text-muted)]">*</span>}
                      </span>
                      <span className="shrink-0 font-mono text-[var(--cf-text-muted)]">{col.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  },
);
