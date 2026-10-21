import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

describe("returnToRepo", () => {
  beforeEach(() => useUiStore.setState({ activeView: "graph", lastRepoView: "graph", settingsOpen: false }));

  it("goes back to the repository tab that was left, not to the graph", () => {
    useUiStore.getState().setActiveView("editor");
    useUiStore.getState().setActiveView("notes");
    useUiStore.getState().returnToRepo();
    expect(useUiStore.getState().activeView).toBe("editor");
  });

  // The tour sets the view straight on the store, past every action.
  it("remembers a tab set without an action", () => {
    useUiStore.setState({ activeView: "codemap" });
    useUiStore.setState({ activeView: "diagrams" });
    useUiStore.getState().returnToRepo();
    expect(useUiStore.getState().activeView).toBe("codemap");
  });

  it("never returns to an app, however many were visited", () => {
    useUiStore.getState().setActiveView("changes");
    useUiStore.getState().setActiveView("notes");
    useUiStore.getState().setActiveView("chat");
    useUiStore.getState().returnToRepo();
    expect(useUiStore.getState().activeView).toBe("changes");
  });
});
