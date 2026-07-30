import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, CornerDownLeft, Loader2, Search, type LucideIcon } from "lucide-react";
import { useT } from "../../state/languageStore";

/**
 * The DATABASE / SCHEMA picker of the database workspace's toolbars.
 *
 * These were plain text inputs with a `<datalist>` behind them, which is the worst of both worlds:
 * it looks like a field you must type into, it only suggests names the tree happened to have been
 * expanded into, and the native dropdown it opens is drawn by the OS — unthemed, unsearchable and
 * (on macOS) not opened by clicking the field at all. So the common case, "point at a database I
 * already have", was the one the control was worst at.
 *
 * This is a combobox instead: a button showing the current scope, and a menu that **fetches the
 * list on open** (`onOpen`) rather than waiting for the tree, filters as you type, and still lets
 * you commit a name that isn't in the list — a database the connection can reach but the catalog
 * query didn't return is a real case, and ⏎ on the typed text keeps it a single keystroke.
 */
export function ScopePicker({
  label,
  icon: Icon,
  value,
  options,
  loading = false,
  error = null,
  disabled = false,
  disabledHint,
  width = 150,
  onChange,
  onOpen,
}: {
  /** The small uppercase caption in front of the control ("DATABASE"). */
  label: string;
  icon: LucideIcon;
  /** The current scope; `""` means "whatever the connection defaults to". */
  value: string;
  options: string[];
  /** The list is being fetched — the menu says so instead of looking empty. */
  loading?: boolean;
  /** Why the list couldn't be read (permission denied on a catalog query, say). */
  error?: string | null;
  disabled?: boolean;
  /** Shown in place of the list when `disabled` — "pick a database first". */
  disabledHint?: string;
  width?: number;
  onChange: (value: string) => void;
  /** Called when the menu opens, to load the list if it isn't loaded yet. */
  onOpen?: () => void;
}) {
  const t = useT();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ left: number; width: number; maxHeight: number; top?: number; bottom?: number } | null>(
    null,
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((name) => name.toLowerCase().includes(q)) : options;
  }, [options, query]);
  // A name typed in full that the catalog didn't return: offered as its own row rather than
  // silently dropped, since it's still a valid scope to run in.
  const custom = query.trim();
  const showCustom = custom.length > 0 && !options.some((name) => name.toLowerCase() === custom.toLowerCase());

  const reposition = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const below = spaceBelow >= 220 || spaceBelow >= spaceAbove;
    // Wider than the trigger — these are names, and the trigger is sized for a toolbar — so the
    // left edge is clamped to keep the menu on screen when the toolbar sits near the right edge.
    const menuWidth = Math.max(rect.width, 208);
    setPos({
      left: Math.max(4, Math.min(rect.left, window.innerWidth - menuWidth - 8)),
      width: menuWidth,
      maxHeight: Math.max(140, Math.min(300, (below ? spaceBelow : spaceAbove) - 12)),
      top: below ? rect.bottom + 4 : undefined,
      bottom: below ? undefined : window.innerHeight - rect.top + 4,
    });
  };

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const openMenu = () => {
    if (disabled) return;
    setQuery("");
    setOpen(true);
    onOpen?.();
    // The search field is the whole point of opening it — one keystroke should already filter.
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const commit = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const row = (key: string, text: string, selected: boolean, onClick: () => void, muted = false) => (
    <button
      key={key}
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)] ${
        selected ? "font-medium text-[var(--cf-accent)]" : muted ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"
      }`}
    >
      <span className="min-w-0 flex-1 truncate">{text}</span>
      {selected && <Check size={12} className="shrink-0" />}
    </button>
  );

  return (
    // A span rather than a label: what it captions is a button, and a label wrapping a button
    // labels nothing — the caption is decoration, the button carries its own accessible name.
    <span className="flex items-center gap-1">
      <span className="text-[10px] uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</span>
      <button
        type="button"
        ref={triggerRef}
        disabled={disabled}
        title={disabled ? disabledHint : value || t("db.default")}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        style={{ width }}
        className={`flex items-center gap-1 rounded-md border bg-[var(--cf-bg)] px-1.5 py-[3px] text-left text-[12px] outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
          open ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)] hover:border-[var(--cf-accent)]"
        }`}
      >
        <Icon size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className={`min-w-0 flex-1 truncate ${value ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}>
          {value || t("db.default")}
        </span>
        <ChevronDown
          size={12}
          className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{ position: "fixed", left: pos.left, width: pos.width, top: pos.top, bottom: pos.bottom }}
            className="z-[9999] overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            <div className="relative border-b border-[var(--cf-border)]">
              <Search
                size={11}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
              />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setOpen(false);
                    triggerRef.current?.focus();
                  }
                  if (e.key === "Enter") {
                    e.preventDefault();
                    // ⏎ takes the single match if the filter left one, otherwise what was typed.
                    if (filtered.length === 1) commit(filtered[0]);
                    else if (custom) commit(custom);
                  }
                }}
                placeholder={t("db.filterNames")}
                className="w-full bg-transparent py-1.5 pl-7 pr-2 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
              />
            </div>

            <div style={{ maxHeight: pos.maxHeight - 34 }} className="overflow-auto p-1">
              {row("__default__", t("db.default"), value === "", () => commit(""), true)}
              {filtered.map((name) => row(name, name, name === value, () => commit(name)))}

              {loading && (
                <p className="flex items-center gap-1.5 px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">
                  <Loader2 size={11} className="animate-spin" />
                  {t("db.loadingNames")}
                </p>
              )}
              {!loading && error && (
                <p className="flex items-start gap-1.5 px-2 py-1.5 text-[11px] text-[var(--cf-danger)]">
                  <AlertTriangle size={11} className="mt-[2px] shrink-0" />
                  <span className="min-w-0 break-words">{error}</span>
                </p>
              )}
              {!loading && !error && filtered.length === 0 && !showCustom && (
                <p className="px-2 py-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("db.noNames")}</p>
              )}

              {showCustom && (
                <button
                  type="button"
                  onClick={() => commit(custom)}
                  className="mt-0.5 flex w-full items-center gap-1.5 rounded border-t border-[var(--cf-border)] px-2 py-1.5 text-left text-[12px] text-[var(--cf-text)] hover:bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]"
                >
                  <CornerDownLeft size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                  <span className="min-w-0 truncate">{t("db.useName", { name: custom })}</span>
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </span>
  );
}
