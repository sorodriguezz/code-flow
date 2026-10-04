import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Download, Search, Settings2 } from "lucide-react";
import { DriverGlyph } from "./dbChrome";
import { useDismissOnOutside } from "../../lib/useDismissOnOutside";
import {
  availableHere,
  driverGroup,
  groupDrivers,
  isJvmDriver,
  searchDrivers,
  type DriverDef,
  type DriverGroup,
} from "../../lib/db/drivers";
import { driverReadiness, useAllDrivers, useDriverStore } from "../../state/driverStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * "Which database?", asked before the connection dialog opens — and again from the dialog's own
 * driver field.
 *
 * It was a plain menu of ten engines. The catalogue is sixty-six drivers now, the length of
 * DataGrip's list, and a menu that long is read by scrolling; so it is a search box over the list,
 * which is how a list that long is actually used: type "snow", press Enter. With nothing typed it
 * shows the list under the same headings the Drivers list uses — complete support first, the ones
 * the explorer reads through JDBC metadata after, then the user's own.
 *
 * Each row says whether picking it will cost a download, because that is the one thing about a
 * driver a person deciding between two would want to know before choosing.
 */
export function DriverMenu({
  x,
  y,
  current,
  onPick,
  onManage,
  onClose,
}: {
  x: number;
  y: number;
  /** The driver the field already holds, ticked in the list. */
  current?: string;
  onPick: (driverId: string) => void;
  /** "Manage drivers…", when the opener can show the Drivers list. */
  onManage?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const drivers = useAllDrivers();
  const overview = useDriverStore((s) => s.overview);
  const settings = useDriverStore((s) => s.settings);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    void useDriverStore.getState().load();
  }, []);

  const offered = useMemo(() => drivers.filter((def) => availableHere(def)), [drivers]);

  /** The rows on screen, with the heading each one starts, when it starts one. */
  const rows = useMemo(() => {
    if (query.trim()) {
      return searchDrivers(offered, query).map((def) => ({ def, heading: null as DriverGroup | null }));
    }
    return groupDrivers(offered).flatMap((entry) =>
      entry.drivers.map((def, index) => ({ def, heading: index === 0 ? entry.group : null })),
    );
  }, [offered, query]);

  // A new search starts at its best match.
  useEffect(() => setActive(0), [query]);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - rect.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - rect.height - 4)),
    });
  }, [x, y]);

  useDismissOnOutside(true, onClose, [panelRef]);

  // Keeps the row the keyboard is on in view.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-row="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (def: DriverDef) => {
    onClose();
    onPick(def.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((index) => Math.min(rows.length - 1, index + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row.def);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("db.whichEngine")}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{ position: "fixed", left: pos.left, top: pos.top }}
      className="z-[9999] flex max-h-[min(460px,calc(100vh-16px))] w-[320px] flex-col rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
    >
      <div className="relative shrink-0 border-b border-[var(--cf-border)] p-1.5">
        <Search
          size={12}
          className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
        />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("db.drivers.search")}
          spellCheck={false}
          aria-label={t("db.drivers.search")}
          role="combobox"
          aria-expanded="true"
          aria-controls="cf-driver-menu-list"
          className="h-[28px] w-full rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] pl-7 pr-2 text-[12.5px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)]"
        />
      </div>

      <div ref={listRef} id="cf-driver-menu-list" role="listbox" className="min-h-0 flex-1 overflow-auto p-1">
        {rows.length === 0 && (
          <p className="px-2.5 py-3 text-[12px] text-[var(--cf-text-muted)]">
            {t("db.drivers.noMatch", { query: query.trim() })}
          </p>
        )}
        {rows.map(({ def, heading }, index) => {
          const ready = driverReadiness(def, overview, settings);
          return (
            <div key={def.id}>
              {heading && (
                <p className="px-2.5 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {t(GROUP_LABELS[heading])}
                </p>
              )}
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                data-row={index}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(def)}
                className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-[5px] text-left text-[13px] text-[var(--cf-text)] ${
                  index === active ? "bg-[var(--cf-hover)]" : ""
                }`}
              >
                <DriverGlyph driver={def} />
                <span className="min-w-0 flex-1 truncate">{def.name}</span>
                {query.trim() !== "" && (
                  <span className="shrink-0 text-[10.5px] text-[var(--cf-text-faint)]">
                    {t(GROUP_LABELS[driverGroup(def)])}
                  </span>
                )}
                {def.id === current ? (
                  <Check size={13} className="shrink-0 text-[var(--cf-accent)]" />
                ) : (
                  isJvmDriver(def) &&
                  !(ready.files && ready.runtime) &&
                  !ready.manual && (
                    <Download
                      size={12}
                      className="shrink-0 text-[var(--cf-text-faint)]"
                      aria-label={t("db.drivers.needsDownload")}
                    />
                  )
                )}
              </button>
            </div>
          );
        })}
      </div>

      {onManage && (
        <button
          type="button"
          onClick={() => {
            onClose();
            onManage();
          }}
          className="flex shrink-0 items-center gap-2 border-t border-[var(--cf-border)] px-3.5 py-2 text-left text-[12px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
        >
          <Settings2 size={13} className="opacity-70" />
          {t("db.drivers.manage")}
        </button>
      )}
    </div>,
    document.body,
  );
}

export const GROUP_LABELS: Record<DriverGroup, TranslationKey> = {
  complete: "db.drivers.groupComplete",
  basic: "db.drivers.groupBasic",
  user: "db.drivers.groupUser",
};

/** Where to open the menu so it hangs under the button that asked for it, not over it. */
export function menuAnchor(e: React.MouseEvent<HTMLElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom + 4 };
}
