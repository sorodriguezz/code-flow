import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { remoteActionKeys } from "./remoteActions";
import { translations } from "./i18n/translations";
import { es } from "./i18n/translations.es";

/**
 * What a paired device did is announced by the backend as a key, and this window renders only the
 * keys it knows. Three lists have to agree for that to say anything: the backend's (`announce_for`),
 * this window's, and the strings.
 */
describe("the acts a device can be announced for", () => {
  const source = readFileSync("src-tauri/src/remotectl/dispatch.rs", "utf8");
  const start = source.indexOf("pub fn announce_for(");
  const backend = new Set(
    [...source.slice(start, source.indexOf("\n}\n", start)).matchAll(/Some\("(remote\.action\.[A-Za-z]+)"\)/g)].map(
      (match) => match[1],
    ),
  );

  it("are the ones the backend names", () => {
    expect(backend.size).toBeGreaterThan(25);
    expect(remoteActionKeys().sort()).toEqual([...backend].sort());
  });

  it("all have a string in both languages", () => {
    for (const key of remoteActionKeys()) {
      expect(translations.en, `en: ${key}`).toHaveProperty([key]);
      expect(es, `es: ${key}`).toHaveProperty([key]);
    }
  });
});
