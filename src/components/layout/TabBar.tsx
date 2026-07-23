import { Code2, GitBranch, History } from "lucide-react";
import { useUiStore, type MainView } from "../../state/uiStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";

const TABS: { id: MainView; labelKey: TranslationKey; icon: typeof GitBranch }[] = [
  { id: "graph", labelKey: "tabbar.graph", icon: History },
  { id: "changes", labelKey: "tabbar.changes", icon: GitBranch },
  { id: "editor", labelKey: "tabbar.editor", icon: Code2 },
];

export function TabBar() {
  const activeView = useUiStore((s) => s.activeView);
  const setActiveView = useUiStore((s) => s.setActiveView);
  const t = useT();

  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--cf-border)] bg-[var(--cf-surface)] px-3">
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const active = tab.id === activeView;
        return (
          <button
            key={tab.id}
            onClick={() => setActiveView(tab.id)}
            className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors ${
              active
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            }`}
          >
            <Icon size={14} />
            {t(tab.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
