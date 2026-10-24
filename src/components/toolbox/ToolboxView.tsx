/**
 * «Herramientas» — the developer toolbox: a searchable list of tools on the left, grouped by what
 * they do, and the open tool on the right.
 *
 * Everything runs in the webview and nothing leaves the machine — the reason to have these in the
 * app rather than on the websites people paste production tokens into (user, 2026-10-23: «métele
 * un montón de herramientas altiro para que en verdad valga la pena»).
 */
import { Suspense, useEffect, useMemo, useRef } from "react";
import { Search, Wrench } from "lucide-react";
import { useT } from "../../state/languageStore";
import { ensureToolboxLoaded, useToolboxStore, useToolField } from "../../state/toolboxStore";
import { CATEGORY_LABEL_KEY, searchTools, TOOL_CATEGORIES, toolById, type ToolEntry } from "../../lib/toolbox/catalog";
import { explorerClass, explorerHeadClass, explorerTitleClass, fieldClass, rowClass, sectionLabelClass } from "../common/recipes";
import { ErrorBoundary } from "../common/ErrorBoundary";
import { useFindShortcut } from "../../lib/useFindShortcut";
import { TOOL_COMPONENTS } from "./registry";

export function ToolboxView() {
  const t = useT();
  const activeId = useToolboxStore((s) => s.activeId);
  const open = useToolboxStore((s) => s.open);
  const [query, setQuery] = useToolField("_view", "query", "");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ensureToolboxLoaded();
  }, []);
  // ⌘F / Ctrl+F finds a tool rather than opening the webview's find bar.
  useFindShortcut(searchRef);

  const hits = useMemo(() => searchTools(query, (tool) => `${t(tool.titleKey)} ${t(tool.descriptionKey)}`), [query, t]);
  const active = toolById(activeId) ?? hits[0];
  const Tool = active ? TOOL_COMPONENTS[active.id] : null;

  const row = (tool: ToolEntry, keyPrefix = "") => {
    const Icon = tool.icon;
    return (
      <button
        key={keyPrefix + tool.id}
        type="button"
        className={rowClass(tool.id === active?.id, "h-[30px]")}
        aria-current={tool.id === active?.id ? "true" : undefined}
        onClick={() => open(tool.id)}
      >
        <Icon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
        <span className="min-w-0 flex-1 truncate">{t(tool.titleKey)}</span>
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      <aside className={`${explorerClass} w-[244px]`}>
        <div className={explorerHeadClass}>
          <span className={explorerTitleClass}>
            <Wrench size={15} />
            {t("tabbar.toolbox")}
          </span>
        </div>
        <div className="relative shrink-0 px-2.5 pb-2">
          <Search size={13} className="pointer-events-none absolute left-[18px] top-[9px] text-[var(--cf-text-faint)]" />
          <input
            ref={searchRef}
            className={fieldClass({ size: "sm", className: "w-full pl-7" })}
            value={query}
            placeholder={t("toolbox.search")}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && hits[0]) open(hits[0].id);
              if (e.key === "Escape") setQuery("");
            }}
          />
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {TOOL_CATEGORIES.map((cat) => {
            const tools = hits.filter((tool) => tool.category === cat);
            if (!tools.length) return null;
            return (
              <div key={cat}>
                <div className={sectionLabelClass}>{t(CATEGORY_LABEL_KEY[cat])}</div>
                {tools.map((tool) => row(tool))}
              </div>
            );
          })}
        </nav>
      </aside>
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

