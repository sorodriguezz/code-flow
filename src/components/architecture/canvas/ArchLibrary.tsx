/**
 * The component library beside the canvas: zones, the generic pieces by what they stand for, and
 * every official Azure, AWS and Google Cloud icon, grouped as each provider groups them — dragged
 * onto the canvas (it lands where it is let go, inside the zone under the pointer) or clicked (it
 * lands in the middle of the view).
 *
 * A list rather than a grid of tiles: a name reads whole on one line, and the eye runs down one
 * edge of icons instead of hopping across three columns of centred, hyphenated labels. Folded, it is
 * a rail of its sections' marks — one click opens it on that section, as the Flujos palette does.
 *
 * Dragged with pointer events rather than HTML drag and drop, for the reason the Flujos palette
 * gives: the window keeps Tauri's native file-drop handler, and with it WebKit never starts an HTML
 * drag. A provider's pack loads the first time its section opens or a search needs it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronsLeft, ChevronsRight, Info, Plus, Search, X } from "lucide-react";
import { GENERIC, ZONE_KINDS, categoryFor } from "../../../lib/architecture/catalog";
import { PROVIDERS, listPackIcons, searchArchIcons, type PackEntry, type ProviderId } from "../../../lib/architecture/icons";
import type { Category } from "../../../lib/architecture/types";
import type { TranslationKey } from "../../../lib/i18n/translations";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { useT } from "../../../state/languageStore";
import { iconButtonClass } from "../../common/Button";
import { fieldClass } from "../../common/recipes";
import { Tooltip } from "../../common/Tooltip";
import { ArchIconGlyph } from "../ArchIconGlyph";
import { useCanvasActions, type LibraryItem } from "./canvasState";

const DRAG_SLOP = 4;
const PROVIDER_LABEL: Record<ProviderId, string> = { azure: "Azure", aws: "AWS", gcp: "Google Cloud" };
const PROVIDER_MARK: Record<ProviderId, string> = { azure: "logos:microsoft-azure", aws: "logos:aws", gcp: "logos:google-cloud" };
/** The generic pieces' order: who uses the system, what runs it, how it is reached, what it keeps. */
const CATEGORY_ORDER: Category[] = ["actor", "compute", "network", "data", "messaging", "identity", "security", "observability", "external"];

const humanize = (group: string) => group.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const iconOf = (item: LibraryItem) => (item.kind === "component" ? item.icon : item.icon ?? "group");
const labelOf = (item: LibraryItem) => (item.kind === "component" ? item.name : item.title);

function providerItem(entry: PackEntry, provider: ProviderId): LibraryItem {
  return { kind: "component", icon: entry.id, name: entry.label, type: PROVIDER_LABEL[provider], category: categoryFor(entry.label, entry.group) };
}

/** `narrow`: the canvas is short of room, so the library shows as its rail unless opened from it — a
 *  look that does not change the open-or-folded the person chose for a wider window. */
export function ArchLibrary({ narrow = false }: { narrow?: boolean }) {
  const t = useT();
  const chosen = useArchitectureViewStore((s) => s.paletteOpen);
  const togglePalette = useArchitectureViewStore((s) => s.togglePalette);
  const [peek, setPeek] = useState(false);
  useEffect(() => { if (!narrow) setPeek(false); }, [narrow]);
  const open = chosen && (!narrow || peek);
  const unfold = () => {
    if (!chosen) togglePalette();
    if (narrow) setPeek(true);
  };
  const fold = () => (narrow ? setPeek(false) : togglePalette());
  const actions = useCanvasActions();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ zones: true, generic: true });
  const [packs, setPacks] = useState<Partial<Record<ProviderId, PackEntry[]>>>({});
  const [hits, setHits] = useState<LibraryItem[] | null>(null);
  const [ghost, setGhost] = useState<{ item: LibraryItem; x: number; y: number; over: boolean } | null>(null);
  const press = useRef<{ item: LibraryItem; pointerId: number; x: number; y: number; dragging: boolean } | null>(null);
  const dragged = useRef(false);
  const sections = useRef<Record<string, HTMLDivElement | null>>({});
  const scrollTo = useRef<string | null>(null);

  // A provider section's icons arrive when it is first opened.
  useEffect(() => {
    for (const p of PROVIDERS) {
      if (expanded[p.id] && !packs[p.id]) void listPackIcons(p.id).then((list) => setPacks((cur) => ({ ...cur, [p.id]: list })));
    }
  }, [expanded, packs]);

  // Opened from the rail: the section it was opened on comes to the top.
  useEffect(() => {
    if (!open || !scrollTo.current) return;
    const key = scrollTo.current;
    scrollTo.current = null;
    sections.current[key]?.scrollIntoView({ block: "start" });
  }, [open, expanded]);

  useEffect(() => {
    const q = query.trim();
    if (!q) { setHits(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      void searchArchIcons(q, 90).then((found) => {
        if (!live) return;
        setHits(found.map((h): LibraryItem => {
          if (h.group === "generic") {
            const g = GENERIC.find((x) => x.icon === h.id);
            return { kind: "component", icon: h.id, name: t(`arch.glyph.${h.id}` as TranslationKey), category: g?.category ?? categoryFor(h.label) };
          }
          if (h.group === "logos") return { kind: "component", icon: h.id, name: humanize(h.label), category: categoryFor(h.label) };
          return { kind: "component", icon: h.id, name: h.label, type: PROVIDER_LABEL[h.group as ProviderId] ?? h.group, category: categoryFor(h.label) };
        }));
      });
    }, 120);
    return () => { live = false; clearTimeout(timer); };
  }, [query, t]);

  const zones = useMemo<LibraryItem[]>(() => ZONE_KINDS.map((z) => ({ kind: "zone", style: z.style, icon: z.icon, title: t(`arch.zoneStyle.${z.style}` as TranslationKey) })), [t]);
  const generic = useMemo(() => CATEGORY_ORDER.map((category) => ({
    category,
    items: GENERIC.filter((g) => g.category === category).map((g): LibraryItem => ({ kind: "component", icon: g.icon, name: t(`arch.glyph.${g.icon}` as TranslationKey), category: g.category })),
  })).filter((g) => g.items.length), [t]);

  const handlers = (item: LibraryItem) => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      press.current = { item, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
      dragged.current = false;
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const current = press.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.dragging) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_SLOP) return;
        current.dragging = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      setGhost({ item, x: event.clientX, y: event.clientY, over: !!actions?.isOverCanvas(event.clientX, event.clientY) });
    },
    onPointerUp: (event: React.PointerEvent) => {
      const current = press.current;
      press.current = null;
      setGhost(null);
      if (!current?.dragging) return;
      dragged.current = true;
      actions?.dropAt(current.item, event.clientX, event.clientY);
    },
    onPointerCancel: () => { press.current = null; setGhost(null); },
    onClick: () => {
      if (dragged.current) { dragged.current = false; return; }
      actions?.addCentered(item);
    },
  });

  const row = (item: LibraryItem, key: string) => (
    <button
      key={key}
      type="button"
      title={item.kind === "component" && item.type ? `${item.name} · ${item.type}` : labelOf(item)}
      className="group/lib flex h-[30px] w-full min-w-0 cursor-grab touch-none select-none items-center gap-2.5 rounded-md pl-2 pr-1.5 text-left text-[12.5px] text-[var(--cf-text)] transition-colors duration-100 hover:bg-[var(--cf-hover)] active:cursor-grabbing"
      {...handlers(item)}
    >
      <span className="grid w-5 shrink-0 place-items-center text-[var(--cf-text-muted)]"><ArchIconGlyph id={iconOf(item)} size={18} /></span>
      <span className="min-w-0 flex-1 truncate">{labelOf(item)}</span>
      <Plus size={13} aria-hidden className="shrink-0 text-[var(--cf-text-faint)] opacity-0 transition-opacity duration-100 group-hover/lib:opacity-100" />
    </button>
  );

  const section = (key: string, title: string, body: () => React.ReactNode, opts: { count?: number; mark?: string; nested?: boolean } = {}) => {
    const isOpen = !!expanded[key];
    return (
      <div key={key} ref={(el) => { sections.current[key] = el; }} className="grid scroll-mt-1">
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setExpanded((cur) => ({ ...cur, [key]: !isOpen }))}
          className={`flex w-full items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-[var(--cf-hover)] ${opts.nested ? "h-7 text-[12px] text-[var(--cf-text-muted)]" : "h-8 text-[12.5px] font-semibold text-[var(--cf-text)]"}`}
        >
          <ChevronRight size={13} className={`shrink-0 text-[var(--cf-text-faint)] transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`} />
          {opts.mark ? <ArchIconGlyph id={opts.mark} size={14} /> : null}
          <span className="min-w-0 flex-1 truncate">{title}</span>
          {opts.count ? <span className="text-[11px] font-normal tabular-nums text-[var(--cf-text-faint)]">{opts.count}</span> : null}
        </button>
        {isOpen ? <div className={`grid pb-1.5 ${opts.nested ? "pl-3" : "pl-1"}`}>{body()}</div> : null}
      </div>
    );
  };

  const subhead = (label: string, first: boolean) => (
    <div className={`px-2 pb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)] ${first ? "pt-0.5" : "pt-2.5"}`}>{label}</div>
  );

  const providerBody = (provider: ProviderId) => () => {
    const list = packs[provider];
    if (!list) return <p className="m-0 px-2 py-1 text-[11.5px] text-[var(--cf-text-faint)]">{t("arch.lib.loading")}</p>;
    const groups = new Map<string, PackEntry[]>();
    for (const e of list) (groups.get(e.group) ?? groups.set(e.group, []).get(e.group)!).push(e);
    return [...groups.entries()].map(([group, entries]) =>
      section(`${provider}:${group}`, humanize(group), () => entries.map((e, i) => row(providerItem(e, provider), `${provider}:${group}:${i}`)), { count: entries.length, nested: true }),
    );
  };

  // Folded: the sections' marks, each opening the library on itself.
  if (!open) {
    const jump = (key: string) => {
      scrollTo.current = key;
      setExpanded((cur) => ({ ...cur, [key]: true }));
      unfold();
    };
    const marks: Array<{ key: string; label: string; icon: string }> = [
      { key: "zones", label: t("arch.lib.zones"), icon: "group" },
      { key: "generic", label: t("arch.lib.generic"), icon: "container" },
      ...PROVIDERS.map((p) => ({ key: p.id, label: p.label, icon: PROVIDER_MARK[p.id] })),
    ];
    return (
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 border-r border-[var(--cf-border)] bg-[var(--cf-surface)] py-2" data-tour="arch-library">
        <Tooltip label={t("arch.lib.open")} side="right">
          <button type="button" className={iconButtonClass({ size: "md" })} onClick={unfold} aria-label={t("arch.lib.open")}><ChevronsRight size={15} /></button>
        </Tooltip>
        <span aria-hidden className="my-1 h-px w-5 bg-[var(--cf-border)]" />
        {marks.map((m) => (
          <Tooltip key={m.key} label={m.label} side="right">
            <button type="button" className={iconButtonClass({ size: "md" })} onClick={() => jump(m.key)} aria-label={m.label}><ArchIconGlyph id={m.icon} size={17} /></button>
          </Tooltip>
        ))}
      </div>
    );
  }

  return (
    <div className="flex w-[240px] shrink-0 flex-col border-r border-[var(--cf-border)] bg-[var(--cf-surface)]" data-tour="arch-library">
      <div className="flex h-10 shrink-0 items-center gap-1 pl-3 pr-1.5">
        <span className="truncate text-[13px] font-semibold text-[var(--cf-text)]">{t("arch.lib.title")}</span>
        <Tooltip label={t("arch.lib.title")} description={t("arch.lib.hint")}>
          <span className="grid h-5 w-5 cursor-help place-items-center text-[var(--cf-text-faint)] hover:text-[var(--cf-text-muted)]"><Info size={13} /></span>
        </Tooltip>
        <span className="flex-1" />
        <Tooltip label={t("arch.lib.close")}>
          <button type="button" className={iconButtonClass({ size: "sm" })} onClick={fold} aria-label={t("arch.lib.close")}><ChevronsLeft size={15} /></button>
        </Tooltip>
      </div>
      <div className="relative mx-2.5 mb-2 shrink-0">
        <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-faint)]" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} placeholder={t("arch.lib.search")} aria-label={t("arch.lib.search")} spellCheck={false} className={fieldClass({ size: "sm", className: "w-full pl-7 pr-6" })} />
        {query ? (
          <button type="button" onClick={() => setQuery("")} aria-label={t("arch.clearSearch")} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"><X size={12} /></button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {hits ? (
          hits.length ? <div className="grid">{hits.map((item, i) => row(item, `hit-${i}`))}</div> : <p className="m-0 px-2 py-1 text-[12px] text-[var(--cf-text-faint)]">{t("arch.noMatches")}</p>
        ) : (
          <>
            {section("zones", t("arch.lib.zones"), () => zones.map((item, i) => row(item, `zone-${i}`)))}
            {section("generic", t("arch.lib.generic"), () => generic.map((g, gi) => (
              <div key={g.category} className="grid">
                {subhead(t(`arch.cat.${g.category}` as TranslationKey), gi === 0)}
                {g.items.map((item, i) => row(item, `${g.category}-${i}`))}
              </div>
            )))}
            <div aria-hidden className="mx-1.5 my-1.5 h-px bg-[var(--cf-border)]" />
            {PROVIDERS.map((p) => section(p.id, p.label, providerBody(p.id), { count: packs[p.id]?.length, mark: PROVIDER_MARK[p.id] }))}
          </>
        )}
      </div>
      {ghost ? (
        <div className="pointer-events-none fixed z-[10000] flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] py-1.5 pl-2 pr-2.5 text-[12px] shadow-[var(--cf-shadow)]" style={{ left: ghost.x, top: ghost.y, opacity: ghost.over ? 1 : 0.6 }}>
          <ArchIconGlyph id={iconOf(ghost.item)} size={20} />
          <span className="max-w-[160px] truncate">{labelOf(ghost.item)}</span>
        </div>
      ) : null}
    </div>
  );
}
