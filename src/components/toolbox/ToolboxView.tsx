/**
 * «Herramientas» — the developer toolbox: a searchable list of tools on the left, grouped by what
 * they do, and the open tool on the right.
 *
 * Everything runs in the webview and nothing leaves the machine — the reason to have these in the
 * app rather than on the websites people paste production tokens into (user, 2026-10-23: «métele
 * un montón de herramientas altiro para que en verdad valga la pena»).
 *
 * The list (2026-11-23): favourites and the recently opened on top, arrow keys through the results,
 * a seam to resize it and fold it to a bar like the other side panels, and two ways in that start
 * from the data rather than from the tool's name — «Pegar y detectar», and the search box offering
 * «Abrir en …» when what was typed into it is a token, a timestamp or a JSON document.
 */
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ClipboardPaste, ScanSearch, Search, Star, Wrench } from "lucide-react";
import { useT } from "../../state/languageStore";
import { ensureToolboxLoaded, useToolboxStore, useToolField } from "../../state/toolboxStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useToastStore } from "../../state/toastStore";
import { CATEGORY_LABEL_KEY, searchTools, TOOL_CATEGORIES, toolById, type ToolEntry } from "../../lib/toolbox/catalog";
import { detectTools, type Detection } from "../../lib/toolbox/detect";
import { clipboardReadText } from "../../lib/tauri/commands";
import { explorerClass, explorerHeadClass, explorerTitleClass, fieldClass, rowClass, sectionLabelClass } from "../common/recipes";
import { iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { ErrorBoundary } from "../common/ErrorBoundary";
import { ResizeHandle } from "../common/ResizeHandle";
import { CollapsedPanelBar, useCollapsiblePanel } from "../common/CollapsedPanelBar";
import { useFindShortcut } from "../../lib/useFindShortcut";
import { TOOL_COMPONENTS } from "./registry";
import type { TranslationKey } from "../../lib/i18n/translations";

const LIST_MIN = 200;
const LIST_MAX = 400;

/** Opens what was detected, with the text in the tool's input. */
function openDetection(detection: Detection, text: string) {
  useToolboxStore.getState().sendTo(detection.tool, text, detection.extra);
}

export function ToolboxView() {
  const t = useT();
  const activeId = useToolboxStore((s) => s.activeId);
  const open = useToolboxStore((s) => s.open);
  const recent = useToolboxStore((s) => s.recent);
  const favorites = useToolboxStore((s) => s.favorites);
  const toggleFavorite = useToolboxStore((s) => s.toggleFavorite);
  const [query, setQuery] = useToolField("_view", "query", "");
  const searchRef = useRef<HTMLInputElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const listWidth = Math.max(LIST_MIN, useLayoutStore((s) => s.sizes.toolboxListWidth));
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const fold = useCollapsiblePanel("toolboxListWidth");
  /** Which result the arrow keys are on; -1 is none, and Enter then opens the first. */
  const [cursor, setCursor] = useState(-1);

  useEffect(() => {
    ensureToolboxLoaded();
  }, []);
  useFindShortcut(searchRef);

  const searching = query.trim().length > 0;
  const hits = useMemo(() => searchTools(query, (tool) => `${t(tool.titleKey)} ${t(tool.descriptionKey)}`), [query, t]);
  // Data typed or pasted into the search box rather than a tool's name: offer to open it.
  const detections = useMemo(() => (searching ? detectTools(query) : []), [query, searching]);
  const active = toolById(activeId) ?? hits[0];
  const Tool = active ? TOOL_COMPONENTS[active.id] : null;

  // The rows in the order they are drawn — what the arrow keys walk. Favourites and recents only
  // while browsing: a search is a question, and its answer is the matching tools.
  const sections = useMemo(() => {
    const out: { key: string; label: string; tools: ToolEntry[] }[] = [];
    if (!searching) {
      const fav = favorites.map(toolById).filter((tool): tool is ToolEntry => Boolean(tool));
      if (fav.length) out.push({ key: "fav", label: t("toolbox.favorites"), tools: fav });
      const rec = recent
        .filter((id) => !favorites.includes(id))
        .map(toolById)
        .filter((tool): tool is ToolEntry => Boolean(tool));
      if (rec.length) out.push({ key: "recent", label: t("toolbox.recent"), tools: rec });
    }
    for (const cat of TOOL_CATEGORIES) {
      const tools = hits.filter((tool) => tool.category === cat);
      if (tools.length) out.push({ key: cat, label: t(CATEGORY_LABEL_KEY[cat]), tools });
    }
    return out;
  }, [searching, favorites, recent, hits, t]);
  const flat = useMemo(() => sections.flatMap((section) => section.tools.map((tool) => ({ section: section.key, tool }))), [sections]);

  useEffect(() => setCursor(-1), [query]);
  useEffect(() => {
    if (cursor < 0) return;
    navRef.current?.querySelector<HTMLElement>(`[data-cursor="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const detectClipboard = () => {
    void clipboardReadText()
      .then((text) => {
        const toast = useToastStore.getState().pushToast;
        if (!text.trim()) return toast(t("toolbox.detectEmpty"), "info");
        const [best] = detectTools(text);
        if (!best) return toast(t("toolbox.detectNone"), "info");
        openDetection(best, text);
        toast(t("toolbox.detected", { kind: t(`toolbox.kind.${best.kind}` as TranslationKey) }), "success");
      })
      .catch(() => {});
  };

  let index = -1;
  const row = (tool: ToolEntry, section: string) => {
    const Icon = tool.icon;
    const at = ++index;
    const starred = favorites.includes(tool.id);
    return (
      <div key={`${section}:${tool.id}`} className="group relative">
        <button
          type="button"
          data-cursor={at}
          className={`${rowClass(tool.id === active?.id, "h-[30px] pr-7")} ${at === cursor ? "ring-1 ring-inset ring-[var(--cf-accent)]" : ""}`}
          aria-current={tool.id === active?.id ? "true" : undefined}
          onClick={() => open(tool.id)}
        >
          <Icon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 truncate">{t(tool.titleKey)}</span>
        </button>
        {/* The star sits over the row's right end: lit when the tool is a favourite, otherwise only
            under the pointer, so the list stays a list of names. */}
        <button
          type="button"
          onClick={() => toggleFavorite(tool.id)}
          aria-label={starred ? t("toolbox.unfavorite") : t("toolbox.favorite")}
          title={starred ? t("toolbox.unfavorite") : t("toolbox.favorite")}
          aria-pressed={starred}
          className={`absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-[var(--cf-text-faint)] hover:text-[var(--cf-warning)] focus:opacity-100 ${
            starred ? "text-[var(--cf-warning)] opacity-100" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <Star size={12} className={starred ? "fill-current" : ""} />
        </button>
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      {fold.collapsed ? (
        <CollapsedPanelBar label={t("tabbar.toolbox")} title={t("common.expandPanel")} onExpand={fold.expand} />
      ) : (
        <>
          <aside style={{ width: listWidth }} className={explorerClass}>
            <div className={explorerHeadClass}>
              <span className={explorerTitleClass}>
                <Wrench size={15} />
                {t("tabbar.toolbox")}
              </span>
              <span className="flex-1" />
              <Tooltip label={t("toolbox.detect")} description={t("toolbox.detectHint")}>
                <button type="button" onClick={detectClipboard} aria-label={t("toolbox.detect")} className={iconButtonClass({ size: "xs" })}>
                  <ClipboardPaste size={13} />
                </button>
              </Tooltip>
            </div>
            <div className="relative shrink-0 px-2.5 pb-2">
              <Search size={13} className="pointer-events-none absolute left-[18px] top-[9px] text-[var(--cf-text-faint)]" />
              <input
                ref={searchRef}
                className={fieldClass({ size: "sm", className: "w-full pl-7" })}
                value={query}
                placeholder={t("toolbox.search")}
                spellCheck={false}
                role="combobox"
                aria-expanded
                aria-controls="toolbox-tool-list"
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    if (!flat.length) return;
                    const step = e.key === "ArrowDown" ? 1 : -1;
                    setCursor((c) => (c < 0 ? (step > 0 ? 0 : flat.length - 1) : (c + step + flat.length) % flat.length));
                  } else if (e.key === "Enter") {
                    const picked = cursor >= 0 ? flat[cursor]?.tool : undefined;
                    // Data rather than a name, with no tool matching it by name: open what it is.
                    if (!picked && !hits.length && detections[0]) openDetection(detections[0], query);
                    else if (picked ?? hits[0]) open((picked ?? hits[0]).id);
                  } else if (e.key === "Escape") {
                    setQuery("");
                  }
                }}
              />
            </div>
            <nav ref={navRef} id="toolbox-tool-list" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {detections.length > 0 && (
                <div className="pb-1">
                  <div className={sectionLabelClass}>{t("toolbox.detected", { kind: t(`toolbox.kind.${detections[0].kind}` as TranslationKey) })}</div>
                  {detections.slice(0, 3).map((detection) => {
                    const tool = toolById(detection.tool);
                    if (!tool) return null;
                    const Icon = tool.icon;
                    return (
                      <button
                        key={`detect:${detection.tool}`}
                        type="button"
                        className={rowClass(false, "h-[30px]")}
                        onClick={() => openDetection(detection, query)}
                      >
                        <ScanSearch size={14} className="shrink-0 text-[var(--cf-accent)]" />
                        <span className="min-w-0 flex-1 truncate">{t("toolbox.openIn", { tool: t(tool.titleKey) })}</span>
                        <Icon size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
                      </button>
                    );
                  })}
                </div>
              )}
              {sections.map((section) => (
                <div key={section.key}>
                  <div className={sectionLabelClass}>{section.label}</div>
                  {section.tools.map((tool) => row(tool, section.key))}
                </div>
              ))}
            </nav>
          </aside>
          <ResizeHandle
            axis="x"
            value={listWidth}
            min={LIST_MIN}
            max={LIST_MAX}
            onChange={(value) => setSize("toolboxListWidth", value)}
            onCommit={(value) => commitSize("toolboxListWidth", value)}
            {...fold.handleProps}
            // The explorer draws its own right border; a second line a pixel away read as doubled.
            seamless
          />
        </>
      )}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {active ? (
          <>
            <header className="flex shrink-0 items-baseline gap-3 border-b border-[var(--cf-border)] px-5 py-3">
              <h1 className="text-[15px] font-semibold text-[var(--cf-text)]">{t(active.titleKey)}</h1>
              <p className="min-w-0 truncate text-[12.5px] text-[var(--cf-text-muted)]">{t(active.descriptionKey)}</p>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
              <ErrorBoundary resetKey={active.id}>
                <Suspense fallback={null}>{Tool ? <Tool /> : null}</Suspense>
              </ErrorBoundary>
            </div>
          </>
        ) : null}
      </main>
    </div>
  );
}
