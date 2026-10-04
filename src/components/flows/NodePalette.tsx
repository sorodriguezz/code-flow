import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
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
 * A drawer over the canvas's right edge rather than a modal, so the flow stays in view while you
 * choose what goes into it. Typing filters every family at once; Enter adds the highlighted result,
 * the arrows move the highlight, Escape closes.
 */
export function NodePalette({
  catalog,
  initialFamily,
  onPick,
  onClose,
}: {
  catalog: FlowNodeDescriptor[];
  /** The family to start unfolded — triggers for a flow that has none yet. */
  initialFamily: FlowFamily | null;
  onPick: (typeId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [unfolded, setUnfolded] = useState<Set<FlowFamily>>(() => new Set(initialFamily ? [initialFamily] : []));
  const [active, setActive] = useState(0);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

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
        onClick={() => onPick(d.typeId)}
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

  return (
    <div
      role="dialog"
      aria-label={t("flows.addNode")}
      data-tour="flows-palette"
      className="absolute inset-y-0 right-0 z-20 flex w-[320px] flex-col border-l border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[-12px_0_28px_-16px_rgba(0,0,0,0.35)]"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 pl-3.5 pr-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{t("flows.addNode")}</span>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          onClick={onClose}
          aria-label={t("common.close")}
          title={t("common.close")}
        >
          <X size={14} />
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
    </div>
  );
}
