import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The review screen works on Azure, Jira and monday items alike, and every sentence about where a
 * write lands used to say "Azure DevOps" — a Jira publish announced itself as published to Azure.
 */

let calls: { name: string; args: Record<string, unknown> }[] = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push({ name, args });
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("./notificationStore", () => ({ notify: () => {} }));

const { useWorkItemReviewStore } = await import("./workItemReviewStore");
const { useToastStore } = await import("./toastStore");

const item = {
  id: 7,
  url: "https://example.invalid/browse/WEB-7",
  key: "WEB-7",
  work_item_type: "Story",
  title: "Exportar",
  state: "To Do",
  team_project: "Web",
  container_id: "WEB",
  description_html: "",
  repro_steps_html: "",
  system_info_html: "",
  acceptance_criteria_html: "",
  effort: 0,
  effort_field: "",
  tags: "",
  area_path: "",
  iteration_path: "",
  children: [],
};

beforeEach(() => {
  calls = [];
  useToastStore.setState({ toasts: [] });
});

describe("publishing a staged part", () => {
  it("names the item's own board", async () => {
    useWorkItemReviewStore.setState({
      item,
      provider: "jira",
      org: "https://example.atlassian.net",
      itemKey: "WEB-7",
      publishing: null,
      draft: { ...useWorkItemReviewStore.getState().draft, criteria: ["Dado que exporto"] },
    } as never);

    await useWorkItemReviewStore.getState().publish("criteria");

    const write = calls.find((call) => call.name === "board_update_work_item");
    expect(write?.args).toMatchObject({ provider: "jira", key: "WEB-7" });
    const said = useToastStore.getState().toasts.map((toast) => toast.message).join(" ");
    expect(said).toContain("Jira");
    expect(said).not.toContain("Azure");
  });
});
