import { describe, expect, it } from "vitest";
import { spokenChord, spokenStep, spokenText } from "./spoken";
import { TOURS } from "./steps";
import { translations, type TranslationKey } from "../i18n/translations";
import { es as translationsEs } from "../i18n/translations.es";

describe("a tour card said aloud", () => {
  it("reads a chord as its keys, in the platform's names", () => {
    expect(spokenChord("Mod+Shift+L", "es", true)).toBe("Comando Mayúsculas L");
    expect(spokenChord("Mod+Shift+L", "es", false)).toBe("Control Mayúsculas L");
    expect(spokenChord("Alt+ArrowLeft", "en", true)).toBe("Option left arrow");
    expect(spokenChord("F5", "en", false)).toBe("F5");
  });

  it("drops the copy's marks and says its symbols", () => {
    expect(spokenText("**Ejecutar** (⌘↵) corre el flujo", "es", true)).toBe("Ejecutar (Comando Enter) corre el flujo");
    expect(spokenText("Escribe `/new` —o `/export`— y Shift+Enter salta", "es", false)).toBe("Escribe /new, o /export, y Shift Enter salta");
    expect(spokenText("Abre *Configuración → Pipelines*", "es", true)).toBe("Abre Configuración, Pipelines");
    expect(spokenText("Primera idea.\n\nSegunda idea.", "en", true)).toBe("Primera idea. Segunda idea.");
    expect(spokenText("y el ⋮ de cada fila tiene el resto", "es", true)).toBe("y el menú de cada fila tiene el resto");
  });

  it("says every step of every tour without a mark, a brace or a symbol left over", () => {
    const es = (key: TranslationKey, params?: Record<string, string | number>) => {
      let text = (translationsEs as Record<string, string>)[key] ?? translations.en[key] ?? key;
      for (const [name, value] of Object.entries(params ?? {})) text = text.split(`{${name}}`).join(String(value));
      return text;
    };
    for (const steps of Object.values(TOURS)) {
      for (const step of steps) {
        const said = spokenStep(step, es, "es", true);
        expect(said, step.id).not.toMatch(/[*`{}⌘⌥⇧⌃↵→›—⋮⋯]/);
        expect(said.length, step.id).toBeGreaterThan(20);
      }
    }
  });
});
