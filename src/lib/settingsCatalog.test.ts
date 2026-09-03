import { describe, expect, it } from "vitest";
import { SETTINGS_SECTIONS, searchSettings, tabsFor } from "./settingsCatalog";
import { translations, type TranslationKey } from "./i18n/translations";
import { es as spanish } from "./i18n/translations.es";

/** The English dictionary, which is compiled in — see `translations.ts`. */
const t = (key: TranslationKey) => translations.en[key] ?? key;

const labelsOf = (hits: ReturnType<typeof searchSettings>) => hits.map((hit) => hit.label);

describe("the settings catalog", () => {
  it("gives every section a unique id", () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every pane inside a section a unique id", () => {
    for (const section of SETTINGS_SECTIONS) {
      const ids = (section.tabs ?? []).map((tab) => tab.id);
      expect(new Set(ids).size, `duplicate pane id in ${section.id}`).toBe(ids.length);
    }
  });

  it("has a real translation for every label it declares", () => {
    // The catalog is the one place the settings window, the search and the command palette all
    // read their names from, so a key with no string is three blank labels rather than one.
    for (const section of SETTINGS_SECTIONS) {
      expect(translations.en[section.labelKey], `${section.id} has no label`).toBeTruthy();
      for (const tab of section.tabs ?? []) {
        expect(translations.en[tab.labelKey], `${section.id}/${tab.id} has no label`).toBeTruthy();
        if (tab.hintKey) expect(translations.en[tab.hintKey]).toBeTruthy();
      }
      if (section.searchKey) expect(translations.en[section.searchKey]).toBeTruthy();
    }
  });

  it("returns the panes of a section by id", () => {
    expect(tabsFor("claude").map((tab) => tab.id)).toContain("tasks");
    expect(tabsFor("general")).toEqual([]);
  });
});

describe("searchSettings", () => {
  it("finds nothing for an empty query", () => {
    expect(searchSettings("", t)).toEqual([]);
    expect(searchSettings("   ", t)).toEqual([]);
  });

  it("finds a pane buried two levels down", () => {
    // The case the old command palette could not answer at all: "proxy" is not a section, it is a
    // pane inside the API client's settings.
    const hits = searchSettings("proxy", t);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].section.id).toBe("api");
    expect(hits[0].tab?.id).toBe("proxy");
  });

  it("names the section a pane lives in", () => {
    const hit = searchSettings("proxy", t)[0];
    // "Proxy" on its own does not say where to find it again tomorrow.
    expect(hit.breadcrumb).toBe(t("api.settings.title"));
  });

  it("ranks a name that starts with the query above one that merely contains it", () => {
    const labels = labelsOf(searchSettings("git", t));
    expect(labels[0].toLowerCase().startsWith("git")).toBe(true);
  });

  it("matches through the synonym list", () => {
    // Nobody types "Language servers"; they type LSP.
    const hits = searchSettings("lsp", t);
    expect(hits.some((hit) => hit.tab?.id === "languageServers")).toBe(true);
  });

  it("ignores case", () => {
    expect(labelsOf(searchSettings("GIT", t))).toEqual(labelsOf(searchSettings("git", t)));
  });

  it("ignores accents, which is what makes it usable in Spanish", () => {
    // The English labels carry no diacritics, so this is only a real test against the Spanish
    // dictionary — where half the section names have one and requiring the user to type it would
    // mean knowing the word before looking it up.
    const es = (key: TranslationKey) => spanish[key] ?? translations.en[key] ?? key;
    const accented = searchSettings("revisión", es);
    const plain = searchSettings("revision", es);
    expect(accented.length).toBeGreaterThan(0);
    expect(labelsOf(plain)).toEqual(labelsOf(accented));
  });

  it("surfaces a section's panes when the section itself is named", () => {
    const hits = searchSettings("backup", t);
    // Not just the section row — the five panes behind it, which is what makes the result useful.
    expect(hits.filter((hit) => hit.tab).length).toBeGreaterThan(1);
  });

  it("can leave the workspace sections out", () => {
    const all = searchSettings("review", t);
    const globalOnly = searchSettings("review", t, { includeWorkspace: false });
    expect(all.some((hit) => hit.section.group === "workspace")).toBe(true);
    expect(globalOnly.every((hit) => hit.section.group === "global")).toBe(true);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchSettings("zzzzzz", t)).toEqual([]);
  });

  it("reaches the panes that used to be unreachable", () => {
    // Terminal, Remote and Backup were missing from the command palette's hand-written list; the
    // catalog is what makes forgetting one impossible.
    for (const wanted of ["terminal", "remote", "backup", "vault", "notifications", "pipelines"]) {
      const section = SETTINGS_SECTIONS.find((entry) => entry.id === wanted);
      expect(section, `${wanted} is not in the catalog`).toBeTruthy();
      const hits = searchSettings(t(section!.labelKey), t);
      expect(hits.some((hit) => hit.section.id === wanted), `${wanted} is not findable`).toBe(true);
    }
  });
});
