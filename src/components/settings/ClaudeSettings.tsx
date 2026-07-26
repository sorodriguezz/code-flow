import { Cpu, FileText, Server } from "lucide-react";
import { useT } from "../../state/languageStore";
import { GroupCard } from "./GroupCard";
import { PromptTemplates } from "./PromptTemplates";
import { ProvidersSection } from "./ProvidersSection";
import { TaskRouting } from "./TaskRouting";

/**
 * The AI assistant settings, in the order you'd actually set them up:
 *   1. **Providers** — which engines exist, whether they're installed, how each is configured.
 *   2. **Model per task** — which of those engines (and model) handles each action.
 *   3. **Prompt templates** — shared instructions, independent of who runs them.
 *
 * Each provider row owns its own settings, so configuring one never shifts what another shows.
 */
export function ClaudeSettings() {
  const t = useT();

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.aiSectionTitle")}</h3>
      <p className="mb-4 text-[13px] text-[var(--cf-text-muted)]">{t("settings.aiSectionHint")}</p>

      <div className="space-y-4">
        {/* ── 1. Which engines exist and how each is set up ── */}
        <GroupCard
          icon={Server}
          title={t("settings.providersTitle")}
          subtitle={t("settings.providersHint")}
          collapsible
          defaultOpen={false}
        >
          <ProvidersSection />
        </GroupCard>

        {/* ── 2. Which engine + model handles each action ── */}
        <GroupCard
          icon={Cpu}
          title={t("settings.taskRoutingTitle")}
          subtitle={t("settings.taskRoutingHint")}
          collapsible
          defaultOpen={false}
        >
          <TaskRouting />
        </GroupCard>

        {/* ── 3. The prompt behind each action, shared across providers ── */}
        <GroupCard
          icon={FileText}
          title={t("settings.templatesTitle")}
          subtitle={t("settings.templatesSharedHint")}
          collapsible
          defaultOpen={false}
        >
          <PromptTemplates />
        </GroupCard>
      </div>
    </section>
  );
}
