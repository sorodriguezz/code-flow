import { describe, expect, it } from "vitest";
import { AI_TASKS, AI_TASK_AREAS } from "./aiTasks";
import { tabsFor } from "./settingsCatalog";

describe("the task areas", () => {
  it("give every pane of «Tareas y prompts» its own rows", () => {
    for (const area of AI_TASK_AREAS) {
      expect(AI_TASKS.some((task) => task.area === area.id), `${area.id} has no task`).toBe(true);
    }
  });

  it("are the panes of the tasks section, in the same order", () => {
    expect(tabsFor("tasks").map((tab) => tab.id)).toEqual(AI_TASK_AREAS.map((area) => area.id));
  });
});
