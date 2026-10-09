import { AiTasksSettings } from "./AiTasksSettings";
import { RailSection } from "./settingsNav";
import { useT } from "../../state/languageStore";
import type { AiTaskArea } from "../../lib/aiTasks";

/**
 * «Tareas y prompts»: which engine does each AI action and what it is told, one pane per area of the
 * app. A section of its own since 2026-10-09 — it was one list of twenty-five rows inside the AI
 * section. The search box in each pane still searches every area, so a task is found by name from
 * wherever you are standing.
 */
export function TasksSettings() {
  const t = useT();
  return (
    <RailSection section="tasks" title={t("settings.tasksTitle")} hint={t("settings.tasksSectionHint")} fallback="git">
      {/* Keyed by the area, so each pane opens with its own rows closed and its search empty. */}
      {(tab) => <AiTasksSettings key={tab} area={tab as AiTaskArea} />}
    </RailSection>
  );
}
