import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from "framer-motion";
import { Check, Plus, Search, X } from "lucide-react";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { useT } from "../../state/languageStore";
import { Button } from "../common/Button";
import { chipClass, fieldClass, sectionLabelClass } from "../common/recipes";

/**
 * A project's dependencies — Spring's starters, NestJS's integrations, Quarkus's extensions: what is
 * picked as chips, the usual ones a click away under them, and «+ Add» for the whole list.
 *
 * The list is a menu floating over the form, not a panel opened inside it. The panel it replaces
 * pushed the rest of the form down, hid the suggestions while it was open, and closed only from the
 * button that opened it — while Escape, which everyone reaches for, closed the whole dialog. Now
 * nothing under it moves: Escape, a click outside it or «Done» put the form back as it was, with
 * the focus on «+ Add»; and it opens over the fields above when there is room, so a chip added
 * while it is open never moves it (the chips grow downwards, away from it).
 */

export interface PickerItem {
  id: string;
  name: string;
  description?: string;
  /** The heading it is listed under. */
  group?: string;
  /** Why it cannot be added right now — a starter the chosen Boot version does not take. Listed
   *  greyed out; an already-picked one's chip turns amber with this as its title. */
  unavailable?: string | null;
}

/** How close to the window's edge the menu may sit. */
const EDGE = 8;
/** Between the field and the menu. */
const GAP = 6;
/** The tallest the menu grows. */
const TALLEST = 380;
/** Enough room to open on a side without looking cramped. */
const ROOM = 260;

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function DependencyPicker({
  items,
  selected,
  onToggle,
  popular = [],
  label,
  searchPlaceholder,
}: {
  items: PickerItem[];
  /** In the order the chips show them. */
  selected: string[];
  onToggle: (id: string) => void;
  /** Ids offered one click away under the chips while not picked. */
  popular?: string[];
  /** The field's name, for the menu's accessible name. */
  label: string;
  searchPlaceholder: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const fieldRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const quick = popular.filter((id) => byId.has(id) && !selected.includes(id) && !byId.get(id)?.unavailable).slice(0, 8);
  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) addRef.current?.focus();
  }, []);

  return (
    <div ref={fieldRef} className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((id) => {
          const item = byId.get(id);
          return (
            <span key={id} title={item?.unavailable || item?.description} className={chipClass(item?.unavailable ? "warn" : "accent", "pr-1")}>
              {item?.name ?? id}
              <button
                type="button"
                onClick={() => onToggle(id)}
                aria-label={`${t("scaffold.remove")} ${item?.name ?? id}`}
                className="rounded-[3px] p-px opacity-70 hover:opacity-100"
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
        <button
          ref={addRef}
          type="button"
          onClick={() => (open ? close(true) : setOpen(true))}
          aria-expanded={open}
          aria-haspopup="dialog"
          className={chipClass(open ? "accent" : "neutral", "cursor-pointer hover:text-[var(--cf-text)]")}
        >
          <Plus size={11} />
          {t("scaffold.deps.add")}
        </button>
      </div>
      {quick.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {quick.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => onToggle(id)}
              title={byId.get(id)?.description}
              className="rounded-[5px] px-1.5 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
            >
              + {byId.get(id)?.name}
            </button>
          ))}
        </div>
      )}
      <AnimatePresence>
        {open && (
          <PickerMenu
            key="menu"
            fieldRef={fieldRef}
            items={items}
            selected={selected}
            onToggle={onToggle}
            label={label}
            searchPlaceholder={searchPlaceholder}
            onClose={close}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

interface Place {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/**
 * The band of the window the menu may take: what the field's own scrolling pane shows — so it stays
 * over the form, never over the dialog's title or its buttons — or the window, without such a pane.
 */
function frameOf(field: HTMLElement): { top: number; bottom: number } {
  for (let el = field.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") {
      const rect = el.getBoundingClientRect();
      return { top: Math.max(0, rect.top) + EDGE, bottom: Math.min(window.innerHeight, rect.bottom) - EDGE };
    }
  }
  return { top: EDGE, bottom: window.innerHeight - EDGE };
}

/** Where the menu goes beside `field`: over it when `up`, under it otherwise. */
function placeBeside(field: HTMLElement, up: boolean): Place {
  const rect = field.getBoundingClientRect();
  const frame = frameOf(field);
  const width = Math.min(Math.max(rect.width, 320), 560, window.innerWidth - EDGE * 2);
  const left = Math.min(Math.max(rect.left, EDGE), window.innerWidth - EDGE - width);
  const room = up ? rect.top - GAP - frame.top : frame.bottom - rect.bottom - GAP;
  const maxHeight = Math.max(160, Math.min(TALLEST, room));
  return up ? { left, width, maxHeight, bottom: window.innerHeight - rect.top + GAP } : { left, width, maxHeight, top: rect.bottom + GAP };
}

/** Over the field when there is room there (or more than under it): see the module note. */
function opensUp(field: HTMLElement): boolean {
  const rect = field.getBoundingClientRect();
  const frame = frameOf(field);
  const above = rect.top - GAP - frame.top;
  const below = frame.bottom - rect.bottom - GAP;
  return above >= ROOM || above > below;
}

const samePlace = (a: Place, b: Place) =>
  a.left === b.left && a.width === b.width && a.maxHeight === b.maxHeight && a.top === b.top && a.bottom === b.bottom;

function PickerMenu({
  fieldRef,
  items,
  selected,
  onToggle,
  label,
  searchPlaceholder,
  onClose,
}: {
  fieldRef: RefObject<HTMLDivElement | null>;
  items: PickerItem[];
  selected: string[];
  onToggle: (id: string) => void;
  label: string;
  searchPlaceholder: string;
  onClose: (refocus: boolean) => void;
}) {
  const t = useT();
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const menuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // The side is chosen once, when it opens: flipping later would jump it across the field.
  const [up] = useState(() => (fieldRef.current ? opensUp(fieldRef.current) : false));
  const [place, setPlace] = useState<Place | null>(() => (fieldRef.current ? placeBeside(fieldRef.current, up) : null));

  // Its own layer: Tab stays in it, and the dialog under it neither takes the focus back nor
  // answers its keys while it is open.
  useFocusTrap(menuRef, true);

  // Pinned to the field while the form scrolls, the window resizes, or the chips wrap onto a new
  // line — which only moves it when it opened under the field.
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    const follow = () => {
      const next = placeBeside(field, up);
      setPlace((prev) => (prev && samePlace(prev, next) ? prev : next));
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(field);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
    };
  }, [fieldRef, up]);

  // Escape closes the menu, and only the menu: taken in the capture phase, before the dialog's own
  // listener, and marked handled so that listener leaves it alone.
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      onClose(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  // A press anywhere but the menu and its own field (the chips, the suggestions, «+ Add» — which
  // closes it itself) puts it away.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || fieldRef.current?.contains(target)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [fieldRef, onClose]);

  const needle = fold(query.trim());
  // Under each heading, the headings in the order they first appear: the order of a catalogue is
  // often its own business (the order packages are installed in), not the menu's.
  const groups = useMemo(() => {
    const byGroup = new Map<string, PickerItem[]>();
    for (const item of items) {
      if (needle && ![item.name, item.description ?? "", item.id, item.group ?? ""].some((text) => fold(text).includes(needle))) continue;
      const name = item.group ?? "";
      byGroup.set(name, [...(byGroup.get(name) ?? []), item]);
    }
    return [...byGroup].map(([name, members]) => ({ name, items: members }));
  }, [items, needle]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const indexOf = useMemo(() => new Map(flat.map((item, index) => [item.id, index])), [flat]);
  const pickable = (item: PickerItem) => !item.unavailable || selected.includes(item.id);

  useEffect(() => setActive(0), [needle]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const step = (direction: 1 | -1) => {
    if (flat.length === 0) return;
    let next = active;
    for (let n = 0; n < flat.length; n++) {
      next = (next + direction + flat.length) % flat.length;
      if (pickable(flat[next])) break;
    }
    setActive(next);
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      step(-1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = flat[active];
      if (item && pickable(item)) onToggle(item.id);
    }
  };

  if (!place) return null;
  const offset = reduced ? 0 : up ? 6 : -6;
  return createPortal(
    <motion.div
      ref={menuRef}
      role="dialog"
      aria-label={label}
      initial={{ opacity: 0, y: offset, scale: reduced ? 1 : 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: offset / 2, scale: reduced ? 1 : 0.98, transition: { duration: 0.1, ease: "easeIn" } }}
      transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
      style={{
        position: "fixed",
        left: place.left,
        width: place.width,
        top: place.top,
        bottom: place.bottom,
        maxHeight: place.maxHeight,
        transformOrigin: up ? "bottom left" : "top left",
        // Opened under the field, it follows a chip that wraps onto a new line: a glide, not a jump.
        transition: reduced ? undefined : "top 150ms ease",
        pointerEvents: present ? "auto" : "none",
      }}
      className="z-[9999] flex flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
    >
      <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] p-1.5">
        <div className="relative min-w-0 flex-1">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder={searchPlaceholder}
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
            className={fieldClass({ size: "sm", className: "w-full pl-7" })}
          />
        </div>
        <Button size="sm" variant="primary" onClick={() => onClose(true)}>
          {t("scaffold.deps.done")}
        </Button>
      </div>
      <div ref={listRef} id={listId} role="listbox" aria-multiselectable aria-label={label} className="min-h-0 flex-1 overflow-y-auto p-1">
        {groups.map((group) => (
          <div key={group.name} role="group" aria-label={group.name || undefined}>
            {group.name && <div className={`${sectionLabelClass} pt-2`}>{group.name}</div>}
            {group.items.map((item) => {
              const index = indexOf.get(item.id) ?? 0;
              const checked = selected.includes(item.id);
              const blocked = !pickable(item);
              return (
                <div
                  key={item.id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={checked}
                  aria-disabled={blocked || undefined}
                  data-index={index}
                  title={item.unavailable || item.description}
                  // Move, not enter: a list scrolling under a still pointer must not steal the row
                  // the arrows are on.
                  onMouseMove={() => !blocked && setActive(index)}
                  // The search field keeps the focus, so typing and the arrows go on working.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => !blocked && onToggle(item.id)}
                  className={`flex items-start gap-2 rounded-md px-2 py-1.5 ${blocked ? "opacity-45" : "cursor-pointer"} ${
                    index === active && !blocked ? "bg-[var(--cf-hover)]" : ""
                  }`}
                >
                  <Tick checked={checked} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-[var(--cf-text)]">{item.name}</span>
                    {item.description && <span className="block truncate text-[11px] text-[var(--cf-text-muted)]">{item.description}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {flat.length === 0 && <p className="px-2 py-3 text-[12px] text-[var(--cf-text-muted)]">{t("scaffold.deps.noMatch")}</p>}
      </div>
    </motion.div>,
    document.body,
  );
}

/** `Checkbox`'s box without its input: a row of the menu is one option the arrows move through, not
 *  a stop for Tab. */
function Tick({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden
      className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors duration-100"
      style={{
        borderColor: checked ? "var(--cf-accent)" : "var(--cf-field-border)",
        backgroundColor: checked ? "var(--cf-accent-fill)" : "transparent",
      }}
    >
      {checked && <Check size={11} strokeWidth={3} className="text-[var(--cf-on-accent)]" />}
    </span>
  );
}
