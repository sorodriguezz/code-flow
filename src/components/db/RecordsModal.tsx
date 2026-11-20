import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Copy, Rows3, Search, X } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { fieldClass } from "../common/recipes";
import { IdentityBadge } from "./dbChrome";
import { referenceLabel } from "./ResultGrid";
import { fieldFacts, recordModel, type EngineRecordModel } from "../../lib/db/engineModel";
import { useFrameThrottle } from "../../lib/frameThrottle";
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

/** Width of the pinned field column and of each record column, in px. Fixed so the record columns
 * can be windowed: only the ones in view are rendered. */
const FIELD_WIDTH = 240;
const RECORD_WIDTH = 240;
/** How wide a record column may grow when there are few rows and room to spare. */
const RECORD_WIDTH_MAX = 720;
/** A value taller than this many lines is shown folded, with «ver todo» to open it in place. */
const FOLD_LINES = 8;
/** Record columns rendered either side of the viewport, so a fast sideways scroll doesn't flash gaps. */
const OVERSCAN = 3;

/**
 * The selected rows read down instead of across: field names pinned on the left, one column per
 * row, and a search over field names *and* values. The marks on fields whose values differ were
 * taken out too (user, 2026-11-19): they did not say much. The «ocultar
 * NULL» and «solo diferencias» switches were taken out (user, 2026-11-19): the search is the filter.
 *
 * The «Ficha» view (one row at a time, its fields as cards) is gone: it showed what a single column
 * here shows, in more space, and never two rows at once (user, 2026-11-19).
 *
 * **Windowed sideways.** Five hundred selected rows by fifty fields were 25 000 table cells, all
 * mounted and all re-rendered on every keystroke in the search box — the modal froze. Only the record
 * columns in view (plus `OVERSCAN`) are rendered now, the way `RecordGrid` does it.
 *
 * **Opaque hover.** The hover tint is a see-through colour; laid on the pinned field cell it let the
 * values scrolled under that cell show through, the hovered row's label and values drawn on top of
 * each other. The pinned cell mixes the tint into its own surface, so it stays solid. The copy button
 * shows for the cell under the pointer, not for the whole row.
 */
export function RecordsModal({ modal, onClose }: { modal: RecordsModalData; onClose: () => void }) {
  const t = useT();
  const model = recordModel(modal.engine);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const onScrollLeft = useFrameThrottle(setScrollLeft);
  const [viewportWidth, setViewportWidth] = useState(1200);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setViewportWidth(element.clientWidth));
    observer.observe(element);
    setViewportWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const facts = useMemo(
    () => modal.columns.map((column) => fieldFacts(model, column, { primaryKeys: modal.primaryKeys, foreignKeys: modal.foreignKeys })),
    [modal.columns, model, modal.primaryKeys, modal.foreignKeys],
  );

  /** The fields shown, as indexes into `columns`, after the search. */
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return modal.columns
      .map((_, index) => index)
      .filter((index) => {
        if (!needle) return true;
        return (
          modal.columns[index].name.toLowerCase().includes(needle) ||
          modal.records.some((r) => {
            const value = r.values[index] ?? null;
            return value !== null && value.toLowerCase().includes(needle);
          })
        );
      });
  }, [query, modal.columns, modal.records]);

  const total = modal.records.length;
  // Few rows, wide window: the columns share the room instead of leaving it empty — one record's
  // long JSON read in a 240px strip beside a screen of nothing (user, 2026-11-19).
  const recordWidth = Math.round(
    Math.min(RECORD_WIDTH_MAX, Math.max(RECORD_WIDTH, (viewportWidth - FIELD_WIDTH) / Math.max(1, total))),
  );
  const first = Math.max(0, Math.floor(scrollLeft / recordWidth) - OVERSCAN);
  const last = Math.min(total, Math.ceil((scrollLeft + viewportWidth) / recordWidth) + OVERSCAN);
  const shown = modal.records.slice(first, last);
  const leadingGap = first * recordWidth;
  const trailingGap = Math.max(0, total - last) * recordWidth;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const copyAll = () =>
    void navigator.clipboard.writeText(
      modal.records
        .map((r) => modal.columns.map((column, index) => `${column.name}: ${r.values[index] ?? "NULL"}`).join("\n"))
        .join("\n\n"),
    );

  const headerCell =
    "flex shrink-0 items-center border-b border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";
  const gapHeader = "shrink-0 border-b border-[var(--cf-border)] bg-[var(--cf-surface-raised)]";

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
          <span className="text-[11px] text-[var(--cf-text-faint)]">{t("db.records.searchHint")}</span>
          <span className="flex items-center gap-2">
            <GhostButton onClick={copyAll}>{t("db.copy")}</GhostButton>
            <GhostButton onClick={onClose}>{t("common.close")}</GhostButton>
          </span>
        </div>
      }
    >
      {/* The toolbar: what to look for, and which fields to leave out. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
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
        <span className="text-[11px] tabular-nums text-[var(--cf-text-faint)]">
          {t("db.records.shown", { n: String(visible.length), total: String(modal.columns.length) })}
        </span>
      </div>

      <div
        ref={scrollRef}
        className="isolate min-h-0 flex-1 overflow-auto text-[12px]"
        // Coalesced to one write per painted frame: `scrollLeft` decides which record columns exist.
        onScroll={(e) => onScrollLeft(e.currentTarget.scrollLeft)}
      >
        {visible.length === 0 ? (
          <p className="p-8 text-center text-[12px] text-[var(--cf-text-muted)]">{t("db.records.noMatch")}</p>
        ) : (
          <div style={{ width: FIELD_WIDTH + total * recordWidth, minWidth: "100%" }}>
            {/* The row headers, pinned to the top; the corner pinned both ways. */}
            <div className="sticky top-0 z-20 flex h-[34px]">
              <div className={`${headerCell} sticky left-0 z-30 border-r`} style={{ width: FIELD_WIDTH }}>
                {t("db.records.field")}
              </div>
              {leadingGap > 0 && <div className={gapHeader} style={{ width: leadingGap }} />}
              {shown.map((r) => (
                <div key={r.index} className={headerCell} style={{ width: recordWidth }}>
                  {t(model.itemLabel, { n: String(r.index + 1) })}
                </div>
              ))}
              {trailingGap > 0 && <div className={gapHeader} style={{ width: trailingGap }} />}
              <div className={`${gapHeader} flex-1`} />
            </div>
            {visible.map((index) => {
              return (
                <div key={`${modal.columns[index].name}-${index}`} className="group flex">
                  <div
                    className={`sticky left-0 z-10 flex shrink-0 items-start border-b border-r border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-1.5 group-hover:bg-[color-mix(in_oklab,var(--cf-text)_6%,var(--cf-surface))]`}
                    style={{ width: FIELD_WIDTH }}
                  >
                    <FieldLabel column={modal.columns[index]} facts={facts[index]} model={model} query={query} />
                  </div>
                  {leadingGap > 0 && <div className="shrink-0 border-b border-[var(--cf-border)]" style={{ width: leadingGap }} />}
                  {shown.map((r) => (
                    <div
                      key={r.index}
                      className={`group/cell min-w-0 shrink-0 border-b border-[var(--cf-border)] px-3 py-1.5 group-hover:bg-[var(--cf-hover)]`}
                      style={{ width: recordWidth }}
                    >
                      <Value value={r.values[index] ?? null} query={query} />
                    </div>
                  ))}
                  {trailingGap > 0 && <div className="shrink-0 border-b border-[var(--cf-border)]" style={{ width: trailingGap }} />}
                  <div className="flex-1 border-b border-[var(--cf-border)] group-hover:bg-[var(--cf-hover)]" />
                </div>
              );
            })}
          </div>
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
    <div className="w-full min-w-0" title={facts.type ? `${column.name} · ${facts.type}` : column.name}>
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

/** JSON pretty-printed for reading — an object on one wrapped line is a wall of braces. The raw
 * text is what gets copied and searched; this only changes how it is laid out. */
function readable(value: string): string {
  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("[")) || trimmed.length < 2) return value;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

/**
 * One value, wrapped rather than cut, with its own copy button while the pointer is on its cell.
 *
 * A long one (more than `FOLD_LINES` lines, as laid out) is folded to that height with a fade, and
 * «ver todo» opens it in place — nothing is cut away, the row just stops being a screen tall until
 * you ask for all of it (user, 2026-11-19).
 */
function Value({ value, query }: { value: string | null; query: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const textRef = useRef<HTMLSpanElement>(null);
  const empty = value === "";
  const text = useMemo(() => (value === null || empty ? "" : readable(value)), [value, empty]);
  const lines = useMemo(() => text.split("\n").length, [text]);

  // Measured rather than guessed from the character count: how many lines a value takes depends on
  // the column's width, which depends on the window.
  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight) || 18;
      setOverflows(element.scrollHeight > lineHeight * FOLD_LINES + 2);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  // A search hit hidden in the folded part would be a match you cannot see: open it.
  const needle = query.trim().toLowerCase();
  const hit = needle.length > 0 && text.toLowerCase().includes(needle);
  const folded = overflows && !open && !hit;
  return (
    <div className="relative min-w-0">
      <div className="flex min-w-0 items-start gap-1">
        <span
          ref={textRef}
          style={folded ? { maxHeight: `calc(${FOLD_LINES} * 1.5em)` } : undefined}
          className={`min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.5] ${
            value === null || empty ? "italic text-[var(--cf-text-faint)]" : "text-[var(--cf-text)]"
          } ${folded ? "overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" : ""}`}
        >
          {value === null ? "NULL" : empty ? t("db.records.empty") : <Highlight text={text} query={query} />}
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
            className="shrink-0 rounded p-0.5 text-[var(--cf-text-faint)] opacity-0 hover:text-[var(--cf-text)] focus:opacity-100 group-hover/cell:opacity-100"
          >
            {copied ? <Check size={12} className="text-[var(--cf-success)]" /> : <Copy size={12} />}
          </button>
        )}
      </div>
      {overflows && !hit && (
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[var(--cf-accent)] hover:underline"
        >
          {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
          {open
            ? t("db.records.showLess")
            : lines > FOLD_LINES
              ? t("db.records.showAll", { n: String(lines) })
              : t("db.records.showAllShort")}
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
