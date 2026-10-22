import { it, vi } from "vitest";

/**
 * Writes the main window's catalogue as the backend receives it, when asked — the input of the Rust
 * router's cross-check (`codi::router`'s ignored test reads it): `CODEFLOW_DUMP_CATALOGUE=<file>`.
 * The language store is the real one, so the Spanish labels are what the window would register.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {}, emitTo: async () => {} }));

const target = process.env.CODEFLOW_DUMP_CATALOGUE;

it.skipIf(!target)("dumps the catalogue for the backend's router test", async () => {
  const { useLanguageStore } = await import("../../state/languageStore");
  await useLanguageStore.getState().setLanguage?.("es");
  const { catalogueFor } = await import("./actions");
  const { registerActions, actionSpecs, clearActionsForTests } = await import("./registry");
  clearActionsForTests();
  registerActions(catalogueFor({ label: "main", main: true, satellite: null, openedIn: null }));
  const fs = await import("node:fs");
  fs.writeFileSync(target!, JSON.stringify(actionSpecs(), null, 1));
});
