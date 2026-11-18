import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Columns3, Copy, LayoutGrid, Rows3, Search, X } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Segmented } from "../common/Segmented";
import { fieldClass } from "../common/recipes";
import { IdentityBadge } from "./dbChrome";
import { referenceLabel } from "./ResultGrid";
import { fieldFacts, recordModel, type EngineRecordModel } from "../../lib/db/engineModel";
import { useT } from "../../state/languageStore";
import type { DbColumn, DbForeignKey, DbKind } from "../../types/database";

export interface RecordsModalData {
  title: string;
  engine: DbKind;
  columns: DbColumn[];
  records: { index: number; values: (string | null)[] }[];
  primaryKeys?: Set<string>;
  foreignKeys?: Map<string, DbForeignKey>;
}

type Mode = "card" | "compare";

/**
 * Rows read down instead of across — redone for the tables this is actually opened on: forty, eighty
 * columns, several rows selected. The stacked list it replaced was one long column of `name: value`
 * lines per row, a scroll of thousands of pixels with nothing to find a field by (user report,
 * 2026-11-18). Now:
 *
 * - **Ficha** — one row at a time, its fields laid out in as many columns as the window holds, with
 *   ← → (and the arrows) to walk the selection. Reading a record is looking, not scrolling.
 * - **Comparar** — the selected rows side by side, one column each, the field names pinned on the
 *   left; a field whose values differ is marked, and «solo diferencias» leaves only those.
 * - A search over field names *and* values, and «ocultar NULL», so eighty fields come down to the
 *   few the user came for.
 *
 * The row's own number stays on everything: a record read here is worth much less if you can't find
 * the row it came from back in the grid.
 */
export function RecordsModal({ modal, onClose }: { modal: RecordsModalData; onClose: () => void }) {
  const t = useT();
  const model = recordModel(modal.engine);
  const many = modal.records.length > 1;
  const [mode, setMode] = useState<Mode>("card");
  const [at, setAt] = useState(0);
  const [query, setQuery] = useState("");
  const [hideNull, setHideNull] = useState(false);
  const [onlyDiff, setOnlyDiff] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const record = modal.records[Math.min(at, modal.records.length - 1)];

  const facts = useMemo(
    () => modal.columns.map((column) => fieldFacts(model, column, { primaryKeys: modal.primaryKeys, foreignKeys: modal.foreignKeys })),
    [modal.columns, model, modal.primaryKeys, modal.foreignKeys],
  );
  /** Fields whose value is not the same in every selected row — what «comparar» is for. */
  const differs = useMemo(
    () => modal.columns.map((_, index) => modal.records.some((r) => (r.values[index] ?? null) !== (modal.records[0].values[index] ?? null))),
    [modal.columns, modal.records],
  );

  /** The fields shown, as indexes into `columns`, after the search and the switches. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = mode === "card" ? [record] : modal.records;
    return modal.columns
      .map((_, index) => index)
      .filter((index) => {
        const values = rows.map((r) => r.values[index] ?? null);
        if (hideNull && values.every((value) => value === null)) return false;
        if (mode === "compare" && onlyDiff && !differs[index]) return false;
        if (!needle) return true;
        return (
          modal.columns[index].name.toLowerCase().includes(needle) ||
          values.some((value) => value !== null && value.toLowerCase().includes(needle))
        );
      });
  }, [query, hideNull, onlyDiff, mode, record, modal.columns, modal.records, differs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (mode === "card" && !typing && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        setAt((current) => {
          const next = current + (e.key === "ArrowRight" ? 1 : -1);
          return Math.max(0, Math.min(modal.records.length - 1, next));
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, modal.records.length]);

  const asText = (rows: typeof modal.records) =>
    rows
      .map((r) => modal.columns.map((column, index) => `${column.name}: ${r.values[index] ?? "NULL"}`).join("\n"))
      .join("\n\n");
  const copyShown = () => void navigator.clipboard.writeText(asText(mode === "card" ? [record] : modal.records));

  return (
    <ApiModal
      icon={Rows3}
      title={modal.title}
      subtitle={`${t(model.countLabel, { n: String(modal.records.length) })} · ${t("db.records.fields", { n: String(modal.columns.length) })}`}
      // A workspace for wide rows, so sized to the window rather than to a reading column.
      width="max-w-[min(1600px,94vw)]"
      height="h-[88vh]"
      maxHeight="max-h-[88vh]"
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[11px] text-[var(--cf-text-faint)]">
            {mode === "card" && many ? t("db.records.keysHint") : t("db.records.searchHint")}
          </span>
          <span className="flex items-center gap-2">
            <GhostButton onClick={copyShown}>{mode === "card" ? t("db.records.copyRecord") : t("db.copy")}</GhostButton>
            <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
          </span>
        </div>
      }
    >
      {/* The toolbar: how to look, what to look for, which row. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
        {many && (
          <Segmented<Mode>
            layoutId="db-records-mode"
            size="sm"
            value={mode}
            onChange={setMode}
            options={[
              { value: "card", label: t("db.records.card"), icon: LayoutGrid },
              { value: "compare", label: t("db.records.compare"), icon: Columns3 },
            ]}
          />
        )}
        <div className="relative min-w-[200px] flex-1">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder={t("db.records.search")}
            spellCheck={false}
            className={fieldClass({ size: "sm", className: "w-full pl-7 pr-7" })}
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("common.clear")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)] hover:text-[var(--cf-text)]"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <Toggle on={hideNull} onChange={setHideNull} label={t("db.records.hideNull")} />
        {mode === "compare" && <Toggle on={onlyDiff} onChange={setOnlyDiff} label={t("db.records.onlyDiff")} />}
        <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">
          {t("db.records.shown", { n: String(visible.length), total: String(modal.columns.length) })}
        </span>
        {mode === "card" && many && (
          <span className="ml-auto flex items-center gap-1">
            <NavButton disabled={at === 0} onClick={() => setAt(at - 1)} label={t("db.records.previous")}>
              <ChevronLeft size={14} />
            </NavButton>
            <span className="min-w-[88px] text-center text-[12px] font-medium tabular-nums text-[var(--cf-text)]">
              {t(model.itemLabel, { n: String(record.index + 1) })}
              <span className="ml-1 font-normal text-[var(--cf-text-faint)]">
                ({at + 1}/{modal.records.length})
              </span>
            </span>
            <NavButton disabled={at >= modal.records.length - 1} onClick={() => setAt(at + 1)} label={t("db.records.next")}>
              <ChevronRight size={14} />
            </NavButton>
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {visible.length === 0 ? (
          <p className="p-8 text-center text-[12px] text-[var(--cf-text-muted)]">{t("db.records.noMatch")}</p>
        ) : mode === "card" ? (
          // As many columns of fields as the window holds: eighty fields read as a page, not a scroll.
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-2 p-4">
            {visible.map((index) => (
              <div key={modal.columns[index].name} className="group min-w-0 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2 hover:border-[color-mix(in_oklab,var(--cf-accent)_40%,var(--cf-border))]">
                <FieldLabel column={modal.columns[index]} facts={facts[index]} model={model} query={query} />
                <Value value={record.values[index] ?? null} query={query} />
              </div>
            ))}
          </div>
        ) : (
          <table className="w-max min-w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-20 border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {t("db.records.field")}
                </th>
                {modal.records.map((r) => (
                  <th key={r.index} className="sticky top-0 z-10 min-w-[200px] max-w-[360px] border-b border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                    {t(model.itemLabel, { n: String(r.index + 1) })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((index) => (
                <tr key={modal.columns[index].name} className="group">
                  <th
                    scope="row"
                    className={`sticky left-0 z-10 w-[220px] max-w-[260px] border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-1.5 text-left font-normal group-hover:bg-[var(--cf-hover)] ${
                      differs[index] ? "shadow-[inset_3px_0_0_var(--cf-accent)]" : ""
                    }`}
                  >
                    <FieldLabel column={modal.columns[index]} facts={facts[index]} model={model} query={query} />
                  </th>
                  {modal.records.map((r) => (
                    <td key={r.index} className={`max-w-[360px] border-b border-[var(--cf-border)] px-3 py-1.5 align-top group-hover:bg-[var(--cf-hover)] ${
                      differs[index] ? "bg-[color-mix(in_oklab,var(--cf-accent)_5%,transparent)]" : ""
                    }`}>
                      <Value value={r.values[index] ?? null} query={query} compact />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </ApiModal>
  );
}

function FieldLabel({
  column,
  facts,
  model,
  query,
}: {
  column: DbColumn;
  facts: ReturnType<typeof fieldFacts>;
  model: EngineRecordModel;
  query: string;
}) {
  const t = useT();
  return (
    <div className="min-w-0" title={facts.type ? `${column.name} · ${facts.type}` : column.name}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-[11.5px] font-medium text-[var(--cf-text-muted)]">
          <Highlight text={column.name} query={query} />
        </span>
        {facts.identity && model.identity && <IdentityBadge badge={model.identity.badge} title={t(model.identity.label)} />}
        {facts.type && (
          <span
            title={facts.typeFromRecord ? t("db.typeFromRecord") : undefined}
            className={`ml-auto shrink-0 truncate font-mono text-[10px] text-[var(--cf-text-faint)] ${facts.typeFromRecord ? "italic" : ""}`}
          >
            {facts.type}
          </span>
        )}
      </div>
      {facts.reference && (
        <span
          title={t("db.referencesField", { target: referenceLabel(facts.reference) })}
          className="mt-0.5 block truncate text-[10.5px] leading-tight text-[var(--cf-accent)]"
        >
          → {referenceLabel(facts.reference)}
        </span>
      )}
    </div>
  );
}

/** One value, wrapped rather than cut, with its own copy button on hover. */
function Value({ value, query, compact = false }: { value: string | null; query: string; compact?: boolean }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const empty = value === "";
  return (
    <div className={`relative flex min-w-0 items-start gap-1 ${compact ? "" : "mt-1"}`}>
      <span
        className={`min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12px] ${
          value === null || empty ? "italic text-[var(--cf-text-faint)]" : "text-[var(--cf-text)]"
        } ${compact ? "" : "max-h-[160px] overflow-auto"}`}
      >
        {value === null ? "NULL" : empty ? t("db.records.empty") : <Highlight text={value} query={query} />}
      </span>
      {value !== null && !empty && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          title={t("db.records.copyValue")}
          aria-label={t("db.records.copyValue")}
          className="shrink-0 rounded p-0.5 text-[var(--cf-text-faint)] opacity-0 hover:text-[var(--cf-text)] focus:opacity-100 group-hover:opacity-100"
        >
          {copied ? <Check size={12} className="text-[var(--cf-success)]" /> : <Copy size={12} />}
        </button>
      )}
    </div>
  );
}

/** The search's match marked inside a name or a value. */
function Highlight({ text, query }: { text: string; query: string }) {
  const needle = query.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[2px] bg-[color-mix(in_oklab,var(--cf-accent)_25%,transparent)] text-inherit">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`flex h-[26px] shrink-0 items-center rounded-md border px-2 text-[11.5px] transition-colors ${
        on
          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      {label}
    </button>
  );
}

function NavButton({ disabled, onClick, label, children }: { disabled: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={label}
      aria-label={label}
      className="flex h-[26px] w-[26px] items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)] disabled:opacity-35"
    >
      {children}
    </button>
  );
}
