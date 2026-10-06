import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { Braces, ChevronRight, Table2, ListTree } from "lucide-react";
import { segItemClass, segTrackClass } from "../common/recipes";
import { DRAG_THRESHOLD } from "../../lib/pointerDrag";
import { KIND_MARK, jsPath, kindOf } from "../../lib/flows/exprAssist";
import { useFlowFieldDragStore } from "../../state/flowFieldDragStore";
import { useT } from "../../state/languageStore";

/**
 * Items, three ways: a schema of their fields, a table, or the JSON itself.
 *
 * The schema is the default because it is what an expression needs — which fields exist, and what
 * kind of value each holds — and on the input side every field in it (and every table header) can
 * be dragged onto a parameter, where it is written the way that field reads it (`{{ $json.path }}`
 * in a text box, `item["path"]` in Python…; `flowFieldDragStore`). The JSON is the honest view:
 * what the next node receives, byte for byte.
 */

export type DataMode = "schema" | "table" | "json";

/** How a path is written inside an expression: dots where they are safe, brackets where not. */
export const pathExpression = (path: (string | number)[]): string => jsPath("$json", path);

/**
 * The pointer handlers that pick a field up — a press that travels `DRAG_THRESHOLD` is a drag (the
 * click it would otherwise be does nothing here). Pointer capture is held from the press so the
 * travel is heard, and let go once it is a drag, so the field under the pointer gets its own
 * enter/leave and can light up.
 */
function fieldDragHandlers(path: (string | number)[], label: string) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      // No text selection out of the press — it is a grab.
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      useFlowFieldDragStore.getState().press({ path, label }, event.clientX, event.clientY);
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      if (event.buttons === 0) return;
      const { origin, drag, begin } = useFlowFieldDragStore.getState();
      if (!origin || drag) return;
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) < DRAG_THRESHOLD) return;
      begin();
      event.currentTarget.releasePointerCapture(event.pointerId);
    },
  };
}

/** The dragged field, following the pointer — drawn once, by whoever hosts the drop targets. */
export function FieldDragGhost() {
  const drag = useFlowFieldDragStore((s) => s.drag);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!drag) {
      setAt(null);
      return;
    }
    const move = (event: PointerEvent) => setAt({ x: event.clientX, y: event.clientY });
    window.addEventListener("pointermove", move, true);
    return () => window.removeEventListener("pointermove", move, true);
  }, [drag]);
  if (!drag || !at) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed z-[10000] rounded-[5px] border border-[var(--cf-accent)] bg-[var(--cf-surface-raised)] px-1.5 py-[1px] font-mono text-[11.5px] text-[var(--cf-text)] shadow-[var(--cf-shadow)]"
      style={{ left: at.x + 12, top: at.y + 10 }}
    >
      {pathExpression(drag.path)}
    </div>,
    document.body,
  );
}

function preview(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return text.length > 120 ? `${text.slice(0, 117)}…` : text;
  }
  return String(value);
}

interface SchemaField {
  key: string | number;
  path: (string | number)[];
  kind: string;
  sample: unknown;
  children: SchemaField[];
}

/** The union of the fields of the first items, nested, with one sample value each. */
function schemaOf(items: unknown[]): SchemaField[] {
  const merge = (into: SchemaField[], value: unknown, path: (string | number)[], depth: number) => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    const entries: [string | number, unknown][] = Array.isArray(value)
      ? value.length
        ? [[0, value[0]]]
        : []
      : Object.entries(value as Record<string, unknown>);
    for (const [key, child] of entries) {
      let field = into.find((f) => f.key === key);
      if (!field) {
        field = { key, path: [...path, key], kind: kindOf(child), sample: child, children: [] };
        into.push(field);
      } else if (field.sample === null || field.sample === undefined) {
        field.sample = child;
        field.kind = kindOf(child);
      }
      merge(field.children, child, field.path, depth + 1);
    }
  };
  const root: SchemaField[] = [];
  for (const item of items.slice(0, 50)) merge(root, item, [], 0);
  return root;
}

function SchemaRows({ fields, depth, drag }: { fields: SchemaField[]; depth: number; drag: boolean }) {
  const [open, setOpen] = useState<Set<string | number>>(() => new Set(depth === 0 ? fields.map((f) => f.key) : []));
  return (
    <>
      {fields.map((field) => {
        const nested = field.children.length > 0;
        const isOpen = open.has(field.key);
        return (
          <div key={String(field.key)}>
            <div
              className="cf-flow-field group flex h-[26px] min-w-0 items-center gap-1.5 rounded-md pr-2 text-[12px] hover:bg-[var(--cf-hover)]"
              style={{ paddingLeft: 6 + depth * 14 }}
            >
              {nested ? (
                <button
                  type="button"
                  className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--cf-text-faint)]"
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(field.key)) next.delete(field.key);
                      else next.add(field.key);
                      return next;
                    })
                  }
                  aria-expanded={isOpen}
                >
                  <ChevronRight size={12} className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
                </button>
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <span
                {...(drag ? fieldDragHandlers(field.path, String(field.key)) : {})}
                className={`inline-flex min-w-0 select-none items-center gap-1.5 rounded-[5px] bg-[var(--cf-hover)] px-1.5 py-[1px] font-mono text-[11.5px] text-[var(--cf-text)] ${
                  drag ? "cursor-grab touch-none active:cursor-grabbing" : ""
                }`}
                title={`{{ ${pathExpression(field.path)} }}`}
              >
                <span className="w-3 shrink-0 text-center text-[10px] text-[var(--cf-text-faint)]">{KIND_MARK[field.kind] ?? "?"}</span>
                <span className="truncate">{String(field.key)}</span>
              </span>
              {!nested && (
                <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]">{preview(field.sample)}</span>
              )}
            </div>
            {nested && isOpen && <SchemaRows fields={field.children} depth={depth + 1} drag={drag} />}
          </div>
        );
      })}
    </>
  );
}

function TableView({ items, drag }: { items: unknown[]; drag: boolean }) {
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const item of items.slice(0, 50)) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const key of Object.keys(item)) if (!keys.includes(key)) keys.push(key);
      }
    }
    return keys.slice(0, 40);
  }, [items]);
  return (
    <div className="min-h-0 overflow-auto">
      <table className="cf-flow-table">
        <thead>
          <tr>
            <th className="w-8 text-right text-[var(--cf-text-faint)]">#</th>
            {columns.map((key) => (
              <th key={key}>
                <span
                  {...(drag ? fieldDragHandlers([key], key) : {})}
                  className={drag ? "cursor-grab touch-none select-none" : ""}
                  title={`{{ ${pathExpression([key])} }}`}
                >
                  {key}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td className="text-right text-[var(--cf-text-faint)]">{index}</td>
              {columns.map((key) => (
                <td key={key} title={preview((item as Record<string, unknown>)?.[key])}>
                  {preview((item as Record<string, unknown>)?.[key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DataModeSwitch({ mode, onChange }: { mode: DataMode; onChange: (mode: DataMode) => void }) {
  const t = useT();
  const options: { value: DataMode; icon: typeof Braces; label: string }[] = [
    { value: "schema", icon: ListTree, label: t("flows.data.schema") },
    { value: "table", icon: Table2, label: t("flows.data.table") },
    { value: "json", icon: Braces, label: t("flows.data.json") },
  ];
  return (
    <div className={segTrackClass()} role="tablist">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={mode === value}
          title={label}
          aria-label={label}
          className={segItemClass(mode === value, { size: "sm", className: mode === value ? "bg-[var(--cf-surface)] shadow-[var(--cf-shadow-lift)]" : "" })}
          onClick={() => onChange(value)}
        >
          <Icon size={12} />
        </button>
      ))}
    </div>
  );
}

/**
 * One list of items in the chosen mode. `total` is how many there were before the cut; `fieldDrag`
 * lets its fields be dragged into the parameters — the input's, never an output's.
 */
export function ItemsView({ items, total, mode, fieldDrag = false }: { items: unknown[]; total: number; mode: DataMode; fieldDrag?: boolean }) {
  const t = useT();
  const schema = useMemo(() => (mode === "schema" ? schemaOf(items) : []), [items, mode]);
  if (items.length === 0) {
    return <p className="px-3 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("flows.data.noItems")}</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {mode === "schema" && (
        <div className="min-h-0 flex-1 overflow-auto px-1.5 py-1.5">
          {schema.length === 0 ? (
            <p className="px-1.5 py-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("flows.data.noFields", { n: items.length })}</p>
          ) : (
            <SchemaRows fields={schema} depth={0} drag={fieldDrag} />
          )}
        </div>
      )}
      {mode === "table" && <TableView items={items} drag={fieldDrag} />}
      {mode === "json" && (
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-[var(--cf-text)]">
          {JSON.stringify(items, null, 2)}
        </pre>
      )}
      {total > items.length && (
        <p className="shrink-0 border-t border-[var(--cf-border)] px-3 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
          {t("flows.data.cut", { shown: items.length, total })}
        </p>
      )}
    </div>
  );
}
