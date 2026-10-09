import { describe, expect, it, vi } from "vitest";

// The stores `stage` moves subscribe to backend events when they load.
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => Promise.resolve(null), transformCallback: () => 0 }));
import { applyStage } from "./stage";
import { TOURS } from "./steps";
import { tabsFor } from "../settingsCatalog";
import { translations } from "../i18n/translations";
import { useUiStore } from "../../state/uiStore";

describe("the tours' settings steps", () => {
  it("land on a settings pane that exists", () => {
    for (const [tour, steps] of Object.entries(TOURS)) {
      for (const step of steps) {
        const section = step.stage?.settings;
        if (!section) continue;
        const tab = step.stage?.settingsTab;
        if (tab) expect(tabsFor(section).map((entry) => entry.id), `${tour}/${step.id}`).toContain(tab);
        expect(translations.en[step.titleKey], `${tour}/${step.id} title`).toBeTruthy();
        expect(translations.en[step.bodyKey], `${tour}/${step.id} body`).toBeTruthy();
      }
    }
  });

  it("open the voice step on the reading aloud, and leave no pane pending once closed", () => {
    const voice = TOURS.main.find((step) => step.id === "settingsVoice");
    expect(voice).toBeTruthy();
    applyStage(voice!.stage);
    expect(useUiStore.getState().settingsOpen).toBe(true);
    expect(useUiStore.getState().settingsSection).toBe("voice");
    expect(useUiStore.getState().settingsTab).toBe("reading");
    applyStage(undefined);
    expect(useUiStore.getState().settingsOpen).toBe(false);
    expect(useUiStore.getState().settingsTab).toBeNull();
  });
});
