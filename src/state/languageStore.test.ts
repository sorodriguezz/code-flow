import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The first run's language. It was always English, whatever the machine spoke; with nothing chosen
 * it now follows the system — Spanish for any `es*` locale — and a choice, once made, wins.
 */

const settings: Record<string, string | null> = {};
let locale: string | null = null;

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (name: string, args: Record<string, string>) => {
    if (name === "get_setting") return settings[args.key] ?? null;
    if (name === "system_locale") return locale;
    if (name === "set_setting") {
      settings[args.key] = args.value;
      return null;
    }
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { languageFromLocale, useLanguageStore } = await import("./languageStore");

beforeEach(() => {
  for (const key of Object.keys(settings)) delete settings[key];
  locale = null;
  useLanguageStore.setState({ language: "en" });
});

describe("languageFromLocale", () => {
  it("is Spanish for any Spanish locale and English otherwise", () => {
    expect(languageFromLocale("es")).toBe("es");
    expect(languageFromLocale("es-CL")).toBe("es");
    expect(languageFromLocale("ES_mx")).toBe("es");
    expect(languageFromLocale("en-US")).toBe("en");
    expect(languageFromLocale("pt-BR")).toBe("en");
    expect(languageFromLocale(null)).toBe("en");
  });
});

describe("the first run", () => {
  it("speaks the system's language when nothing was chosen, without recording it", async () => {
    locale = "es-419";
    await useLanguageStore.getState().init();
    expect(useLanguageStore.getState().language).toBe("es");
    expect(settings.app_language).toBeUndefined();
  });

  it("keeps a choice over the system's language", async () => {
    locale = "es-CL";
    settings.app_language = "en";
    await useLanguageStore.getState().init();
    expect(useLanguageStore.getState().language).toBe("en");
  });
});
