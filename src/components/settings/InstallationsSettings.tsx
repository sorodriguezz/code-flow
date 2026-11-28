import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { tabsFor } from "../../lib/settingsCatalog";
import { useSwapFade } from "../../lib/useSwapFade";
import { useT } from "../../state/languageStore";
import { useToolSetupStore } from "../../state/toolSetupStore";
import { useUiStore } from "../../state/uiStore";
import { SettingsHeader } from "../api/settingsChrome";
import { Button } from "../common/Button";
import { fieldClass, sectionLabelClass } from "../common/recipes";
import { ToolInstallRow } from "../common/ToolInstallRow";
import { SettingsRail } from "./settingsNav";
import { SonarInstallation } from "./SonarInstallation";

const TABS = tabsFor("installations");
const SEARCH_ALIASES: Record<string, string> = {
  gemini: "agy antigravity gemini",
  az: "azure az",
  "gke-auth-plugin": "gke-gcloud-auth-plugin",
};

export function InstallationsSettings() {
  const t = useT();
  const tools = useToolSetupStore((state) => state.tools);
  const loading = useToolSetupStore((state) => state.loading);
  const loadError = useToolSetupStore((state) => state.loadError);
  const load = useToolSetupStore((state) => state.load);
  const pending = useUiStore((state) => state.settingsTab);
  const clearSettingsTab = useUiStore((state) => state.clearSettingsTab);
  const [selection, setSelection] = useState<{ tab: string; tool: string | null }>({ tab: "system", tool: null });
  const [query, setQuery] = useState("");
  const pane = useRef<HTMLDivElement>(null);
  const search = query.trim().toLowerCase();

  useEffect(() => {
    void load();
  }, [load]);

  useLayoutEffect(() => {
    if (!pending) return;
    const isCategory = TABS.some((tab) => tab.id === pending);
    const tab = isCategory ? pending : pending === "sonarqube" ? "analysis" : tools?.find((tool) => tool.id === pending)?.group;
    if (!tab && !tools) return;

    if (tab) {
      setSelection({ tab, tool: isCategory ? null : pending });
      setQuery("");
    }
    clearSettingsTab();
  }, [pending, tools, clearSettingsTab]);

  useLayoutEffect(() => {
    if (!pane.current) return;
    pane.current.scrollTop = 0;
    if (selection.tool && !search) {
      document.getElementById(`cf-installation-${selection.tool}`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [selection, search]);
  useSwapFade(pane, search ? "search" : selection.tab);

  const visible = TABS.flatMap((tab) => {
    if (!search && selection.tab !== tab.id) return [];
    const title = t(tab.labelKey);
    const entries = (tools ?? []).filter((tool) => {
      if (tool.group !== tab.id) return false;
      const label = `${tool.label} ${tool.id} ${SEARCH_ALIASES[tool.id] ?? ""} ${title}`.toLowerCase();
      return label.includes(search);
    });
    const sonar = tab.id === "analysis" && `${t("installations.searchAnalysis")} ${title}`.toLowerCase().includes(search);
    return entries.length > 0 || sonar ? [{ id: tab.id, title, entries, sonar }] : [];
  });

  const showInventory = Boolean(search) || selection.tab !== "analysis";

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("installations.title")} hint={t("installations.hint")} />
      </div>
      <div className="flex min-h-0 flex-1 gap-4">
        <SettingsRail
          tabs={TABS}
          active={search ? "" : selection.tab}
          layoutId="cf-installations-settings-pill"
          onSelect={(tab) => {
            if (pending) clearSettingsTab();
            setSelection({ tab, tool: null });
            setQuery("");
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mb-3 flex max-w-[740px] shrink-0 flex-wrap items-center gap-2">
            <label className="relative min-w-[160px] flex-1">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]" />
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  if (pending) clearSettingsTab();
                  setQuery(event.target.value);
                  if (selection.tool) setSelection({ tab: selection.tab, tool: null });
                }}
                aria-label={t("installations.search")}
                placeholder={t("installations.search")}
                className={fieldClass({ className: "w-full pl-8" })}
              />
            </label>
            <Button disabled={loading} onClick={() => void load()}>
              <RefreshCw size={13} className={loading ? "animate-spin" : undefined} />
              {t("installations.refresh")}
            </Button>
          </div>

          <div ref={pane} className="min-h-0 flex-1 overflow-y-scroll pb-6" aria-busy={showInventory && loading}>
            <div className="max-w-[740px] space-y-4">
              {showInventory && loadError && <p role="alert" className="text-[12px] text-[var(--cf-danger)]">{t("installations.loadError")}</p>}
              {showInventory && !tools && !loadError && (
                <p role="status" className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
                  <Loader2 size={13} className="animate-spin" />
                  {t("toolSetup.checking")}
                </p>
              )}
              {tools && visible.length === 0 && <p role="status" className="text-[12px] text-[var(--cf-text-muted)]">{t("installations.empty")}</p>}
              {visible.map(({ id, title, entries, sonar }) => (
                <section key={id} aria-label={title}>
                  {search && <h4 className={`${sectionLabelClass} mb-1.5`}>{title}</h4>}
                  <div className="space-y-1.5">
                    {entries.map((tool) => <ToolInstallRow key={tool.id} tool={tool} highlighted={selection.tool === tool.id} />)}
                    {sonar && <SonarInstallation highlighted={selection.tool === "sonarqube"} />}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
