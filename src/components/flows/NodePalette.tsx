import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, Search } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { FAMILIES, FAMILY_ICON, familyColor, nodeIcon } from "../../lib/flows/nodeIcons";
import type { FlowFamily, FlowNodeDescriptor } from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT } from "../../state/languageStore";

/** Accents and case out of the way, so "aprobacion" finds "Pedir aprobación". */
const fold = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

/**
 * The node palette: the catalogue by family, and a search across names and descriptions.
 *
 * **A panel docked at the canvas's right edge, collapsible** (the user's ask, 2026-10-05). It used
 * to be a drawer laid *over* the canvas, and it covered whatever else lives in that corner — the AI
 * builder's window ended up underneath it. Docked, it takes its own strip and the canvas gives way.
 * Folded, it is a rail of the families' marks along the edge: one click opens it on that family.
 * It stays open while nodes are added, so a flow can be built from it; the toolbar's `+`, Tab and the
 * chevron fold it. Typing filters every family at once; Enter adds the highlighted result, the
 * arrows move the highlight, Escape folds it.
 *
 * **A node is dragged onto the canvas, or clicked** (the user's ask, 2026-10-05). Dragged with pointer
 * events rather than HTML drag and drop: the window keeps Tauri's native file-drop handler, and with
 * it on, WebView2 never delivers an HTML drop on Windows. A press that moves more than a few pixels is
 * a drag — the node follows the pointer and lands where it is let go, if that is the canvas
 * (`canDropAt`/`onDropAt`); one that doesn't is the click it always was.
 */

/** How far a press travels before it is a drag rather than a click. */
const DRAG_SLOP = 5;
export function NodePalette({
  catalog,
  initialFamily,
  expanded,
  disabled = false,
  onPick,
  canDropAt,
  onDropAt,
  onExpand,
  onCollapse,
}: {
  catalog: FlowNodeDescriptor[];
  /** The family to start unfolded — triggers for a flow that has none yet. */
  initialFamily: FlowFamily | null;
  expanded: boolean;
  /** Folded and inert — while an AI proposal is on the canvas, nothing is added under it. */
  disabled?: boolean;
  onPick: (typeId: string) => void;
  /** Whether a node let go at this client point would land on the canvas. */
  canDropAt: (x: number, y: number) => boolean;
  /** Places a dragged node where it was let go. */
  onDropAt: (typeId: string, x: number, y: number) => void;
  onExpand: () => void;
  onCollapse: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [unfolded, setUnfolded] = useState<Set<FlowFamily>>(() => new Set(initialFamily ? [initialFamily] : []));
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const open = expanded && !disabled;
  /** The press on a row, until it is let go — a drag once it has travelled `DRAG_SLOP`. */
  const press = useRef<{ typeId: string; pointerId: number; x: number; y: number; dragging: boolean } | null>(null);
  /** Set by a drag's release, so the click the browser sends after it is not a second add. */
  const dragged = useRef(false);
  const [ghost, setGhost] = useState<{ descriptor: FlowNodeDescriptor; x: number; y: number; over: boolean } | null>(null);

  const dragHandlers = (d: FlowNodeDescriptor) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      press.current = { typeId: d.typeId, pointerId: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
      dragged.current = false;
    },
    onPointerMove: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = press.current;
      if (!current || current.pointerId !== event.pointerId) return;
      if (!current.dragging) {
        if (Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_SLOP) return;
        current.dragging = true;
        // Captured once it is a drag, so the release is heard over the canvas as well.
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      setGhost({ descriptor: d, x: event.clientX, y: event.clientY, over: canDropAt(event.clientX, event.clientY) });
    },
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const current = press.current;
      press.current = null;
      if (!current?.dragging) return;
      dragged.current = true;
      setGhost(null);
      if (canDropAt(event.clientX, event.clientY)) onDropAt(current.typeId, event.clientX, event.clientY);
    },
    onPointerCancel: () => {
      press.current = null;
      setGhost(null);
    },
  });

  // Opening it is reaching for the search — from the toolbar, Tab or a family on the rail.
  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  const nameOf = (d: FlowNodeDescriptor) => t(`flows.node.${d.typeId}` as TranslationKey);
  const descriptionOf = (d: FlowNodeDescriptor) => t(`flows.nodeDesc.${d.typeId}` as TranslationKey);

  const hits = useMemo(() => {
    const needle = fold(query.trim());
    if (!needle) return null;
    return catalog.filter((d) => fold(`${nameOf(d)} ${descriptionOf(d)} ${d.typeId}`).includes(needle));
    // `t` changes identity with the language, which is exactly when the names do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, catalog, t]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const row = (d: FlowNodeDescriptor, index: number | null) => {
    const Icon = nodeIcon(d.icon);
    const highlighted = index !== null && index === active;
    return (
      <button
        key={d.typeId}
        type="button"
        data-index={index ?? undefined}
        {...dragHandlers(d)}
        onClick={() => {
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          onPick(d.typeId);
        }}
        onMouseEnter={() => index !== null && setActive(index)}
        className={`flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors ${
          highlighted ? "bg-[var(--cf-hover)]" : "hover:bg-[var(--cf-hover)]"
        }`}
        style={{ "--node-color": familyColor(d.family) } as CSSProperties}
      >
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-[color-mix(in_oklab,var(--node-color)_12%,var(--cf-surface))] text-[var(--node-color)]">
          <Icon size={14} />
        </span>
        <span className="min-w-0">
          <span className="block text-[12.5px] font-semibold text-[var(--cf-text)]">{nameOf(d)}</span>
          <span className="block text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{descriptionOf(d)}</span>
        </span>
      </button>
    );
  };

  if (!open) {
    return (
      <aside
        aria-label={t("flows.addNode")}
        data-tour="flows-palette"
        className="flex w-10 shrink-0 flex-col items-center gap-1 border-l border-[var(--cf-border)] bg-[var(--cf-surface)] py-2"
      >
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          onClick={onExpand}
          disabled={disabled}
          aria-label={t("flows.addNode")}
          title={`${t("flows.addNode")} (Tab)`}
        >
          <ChevronsLeft size={15} />
        </button>
        <span className="my-1 h-px w-5 bg-[var(--cf-border)]" />
        {FAMILIES.map((family) => {
          const FamilyIcon = FAMILY_ICON[family];
          return (
            <button
              key={family}
              type="button"
              disabled={disabled}
              onClick={() => {
                setUnfolded((current) => new Set(current).add(family));
                onExpand();
              }}
              aria-label={t(`flows.family.${family}` as TranslationKey)}
              title={t(`flows.family.${family}` as TranslationKey)}
              className="flex h-7 w-7 items-center justify-center rounded-[7px] transition-colors hover:bg-[var(--cf-hover)] disabled:opacity-40"
              style={{ "--node-color": familyColor(family) } as CSSProperties}
            >
              <span className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-[color-mix(in_oklab,var(--node-color)_12%,var(--cf-surface))] text-[var(--node-color)]">
                <FamilyIcon size={14} />
              </span>
            </button>
          );
        })}
      </aside>
    );
  }

  return (
    <aside
      aria-label={t("flows.addNode")}
      data-tour="flows-palette"
      className="flex w-[300px] shrink-0 flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCollapse();
        }
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pl-3.5 pr-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t("flows.addNode")}</span>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          onClick={onCollapse}
          aria-label={t("flows.paletteCollapse")}
          title={`${t("flows.paletteCollapse")} (Tab)`}
        >
          <ChevronsRight size={15} />
        </button>
      </div>
      <div className="relative mx-2.5 mb-2 shrink-0">
        <Search
          size={13}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]"
        />
        <input
          ref={field}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (!hits) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, Math.max(hits.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter" && hits[active]) {
              event.preventDefault();
              onPick(hits[active].typeId);
            }
          }}
          placeholder={t("flows.paletteSearch")}
          aria-label={t("flows.paletteSearch")}
          spellCheck={false}
          className={fieldClass({ className: "w-full pl-7" })}
        />
      </div>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
        {hits ? (
          hits.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-[var(--cf-text-muted)]">
              {t("flows.paletteNoMatch", { query: query.trim() })}
            </p>
          ) : (
            FAMILIES.map((family) => {
              const inFamily = hits.filter((d) => d.family === family);
              if (inFamily.length === 0) return null;
              return (
                <div key={family}>
                  <div className="px-2 pb-1 pt-2.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                    {t(`flows.family.${family}` as TranslationKey)}
                  </div>
                  {inFamily.map((d) => row(d, hits.indexOf(d)))}
                </div>
              );
            })
          )
        ) : (
          FAMILIES.map((family) => {
            const FamilyIcon = FAMILY_ICON[family];
            const nodes = catalog.filter((d) => d.family === family);
            const open = unfolded.has(family);
            return (
              <div key={family}>
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() =>
                    setUnfolded((current) => {
                      const next = new Set(current);
                      if (next.has(family)) next.delete(family);
                      else next.add(family);
                      return next;
                    })
                  }
                  className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-[12.5px] font-semibold text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
                  style={{ "--node-color": familyColor(family) } as CSSProperties}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] bg-[color-mix(in_oklab,var(--node-color)_12%,var(--cf-surface))] text-[var(--node-color)]">
                    <FamilyIcon size={14} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{t(`flows.family.${family}` as TranslationKey)}</span>
                  <span className="text-[11px] font-medium tabular-nums text-[var(--cf-text-faint)]">{nodes.length}</span>
                  {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                {open && <div className="pb-1">{nodes.map((d) => row(d, null))}</div>}
              </div>
            );
          })
        )}
      </div>
      {ghost &&
        createPortal(
          <div
            aria-hidden
            className="pointer-events-none fixed z-[10000] flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 transition-opacity"
            style={{ left: ghost.x, top: ghost.y, opacity: ghost.over ? 0.95 : 0.55, "--node-color": familyColor(ghost.descriptor.family) } as CSSProperties}
          >
            <GhostTile descriptor={ghost.descriptor} />
            <span className="rounded bg-[var(--cf-surface)] px-1.5 text-[11px] font-semibold text-[var(--cf-text)] shadow-[var(--cf-shadow-lift)]">
              {nameOf(ghost.descriptor)}
            </span>
          </div>,
          document.body,
        )}
    </aside>
  );
}

/** What is carried while a node is dragged: its tile, the way the canvas will draw it. */
function GhostTile({ descriptor }: { descriptor: FlowNodeDescriptor }) {
  const Icon = nodeIcon(descriptor.icon);
  return (
    <span className="flex h-12 w-12 items-center justify-center rounded-[11px] border border-[var(--cf-border-strong)] bg-[color-mix(in_oklab,var(--node-color)_14%,var(--cf-surface))] text-[var(--node-color)] shadow-[var(--cf-shadow)]">
      <Icon size={22} strokeWidth={1.75} />
    </span>
  );
}
