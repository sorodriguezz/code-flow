import { describe, expect, it } from "vitest";
import { AI_PROMPTS, loadPromptDefault, promptsForTask, taskInstructionsKey } from "./aiPrompts";
import { AI_TASKS } from "./aiTasks";

describe("every task has a text to change", () => {
  it("gives each task at least one prompt", () => {
    for (const task of AI_TASKS) expect(promptsForTask(task.key).length, task.key).toBeGreaterThan(0);
  });

  it("adds «Instrucciones» only where a task has no prompt of its own", () => {
    const instructions = AI_PROMPTS.filter((prompt) => prompt.key.startsWith("task_instructions_"));
    for (const prompt of instructions) {
      expect(prompt.key).toBe(taskInstructionsKey(prompt.task));
      expect(prompt.scope).toBe("global");
      expect(promptsForTask(prompt.task)).toEqual([prompt]);
    }
    expect(instructions.map((prompt) => prompt.task)).toContain("chat");
    expect(instructions.map((prompt) => prompt.task)).not.toContain("commit");
  });

  it("starts the box empty", async () => {
    const chat = promptsForTask("chat")[0];
    expect(await loadPromptDefault(chat)).toBe("");
  });

  it("keeps ids unique", () => {
    expect(new Set(AI_PROMPTS.map((prompt) => prompt.id)).size).toBe(AI_PROMPTS.length);
  });
});
