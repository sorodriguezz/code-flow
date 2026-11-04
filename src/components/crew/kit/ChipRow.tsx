/**
 * A row of chips that may not fit: it scrolls sideways (the wheel too), fades and grows arrows at
 * the edge that has more, keeps the chosen chip in view, and — once it overflows — offers the whole
 * list with a search. Chips mark themselves with `data-chip={key}`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronLeft, ChevronRight, List, Search } from "lucide-react";
import { iconButtonClass } from "../../common/Button";
import { fieldClass } from "../../common/recipes";
import { useL } from "../state";

export interface ChipRowEntry {
  key: string;
  label: string;
  sub?: string;
  /** Drawn at the row's end in the list — a status, a count. */
  aside?: ReactNode;
  leading?: ReactNode;
}

export function ChipRow({
  children,
  entries,
  active,
  onPick,
  noun,
  className = "",
}: {
  children: ReactNode;
  entries: ChipRowEntry[];
  active?: string | null;
  onPick: (key: string) => void;
  /** What the entries are, for the list button: «equipos», «corridas». */
  noun: [string, string];
  className?: string;
}) {
  const l = useL();
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [open, setOpen] = useState(false);

  const measure = () => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    // A vertical wheel moves the row sideways — there is nothing to scroll up and down here.
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      observer.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, [entries.length]);

  useEffect(() => {
    if (!active) return;
    const chip = scroller.current?.querySelector<HTMLElement>(`[data-chip="${CSS.escape(active)}"]`);
    chip?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [active]);

  const by = (direction: 1 | -1) => {
    const el = scroller.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.7, behavior: "smooth" });
  };
  const overflowing = edges.left || edges.right;

  return (
    <div className={`relative flex min-w-0 flex-1 items-center gap-1 ${className}`}>
      {overflowing && (
        <button type="button" disabled={!edges.left} onClick={() => by(-1)} title={l("Ver los anteriores", "See the earlier ones")} aria-label={l("Anteriores", "Earlier")} className={iconButtonClass({ size: "sm" })}>
          <ChevronLeft className="h-4 w-4" />
        </button>
      )}
      <div className="relative min-w-0 flex-1">
        <div ref={scroller} onScroll={measure} className="flex min-w-0 gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {children}
        </div>
        {edges.left && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[var(--cf-surface)] to-transparent" />}
        {edges.right && <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[var(--cf-surface)] to-transparent" />}
      </div>
      {overflowing && (
        <>
          <button type="button" disabled={!edges.right} onClick={() => by(1)} title={l("Ver los siguientes", "See the next ones")} aria-label={l("Siguientes", "Next")} className={iconButtonClass({ size: "sm" })}>
            <ChevronRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            data-chiprow-toggle
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            title={l(`Ver todos los ${noun[0]}, con buscador`, `See all ${noun[1]}, with search`)}
            className="flex h-[26px] shrink-0 items-center gap-1 rounded-md border border-[var(--cf-border)] px-2 text-[11.5px] text-[var(--cf-text-muted)] hover:border-[var(--cf-border-strong)] hover:text-[var(--cf-text)]"
          >
            <List className="h-3.5 w-3.5" />
            {entries.length}
          </button>
        </>
      )}
      <AnimatePresence>
        {open && (
          <AllOf
            entries={entries}
            active={active}
            noun={noun}
            onClose={() => setOpen(false)}
            onPick={(key) => {
              onPick(key);
              setOpen(false);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function AllOf({ entries, active, noun, onClose, onPick }: { entries: ChipRowEntry[]; active?: string | null; noun: [string, string]; onClose: () => void; onPick: (key: string) => void }) {
  const l = useL();
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (box.current && !box.current.contains(target) && !target.closest("[data-chiprow-toggle]")) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("pointerdown", away);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", away);
      window.removeEventListener("keydown", esc);
    };
  }, [onClose]);
  const q = query.trim().toLowerCase();
  const shown = entries.filter((e) => !q || e.label.toLowerCase().includes(q) || (e.sub ?? "").toLowerCase().includes(q));
  return (
    <motion.div
      ref={box}
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.12 }}
      className="absolute right-0 top-full z-30 mt-2 flex max-h-[min(420px,60vh)] w-[min(380px,90vw)] flex-col overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-lg,0_12px_32px_rgba(0,0,0,0.18))]"
    >
      <div className="relative shrink-0 border-b border-[var(--cf-border)] p-2">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--cf-text-faint)]" />
        <input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder={l(`Buscar ${noun[0]}`, `Search ${noun[1]}`)} className={fieldClass({ size: "sm", className: "w-full pl-7" })} />
      </div>
      <div className="min-h-0 overflow-y-auto p-1">
        {shown.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => onPick(entry.key)}
            className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left ${entry.key === active ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"}`}
          >
            {entry.leading}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12.5px] font-medium">{entry.label}</span>
              {entry.sub && <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{entry.sub}</span>}
            </span>
            {entry.aside}
          </button>
        ))}
        {shown.length === 0 && <p className="m-0 p-3 text-center text-[12px] text-[var(--cf-text-muted)]">{l("Nada coincide.", "Nothing matches.")}</p>}
      </div>
    </motion.div>
  );
}
