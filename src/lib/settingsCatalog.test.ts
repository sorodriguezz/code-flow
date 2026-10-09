import { describe, expect, it } from "vitest";
import {
  HORIZONTAL_TAB_SECTIONS,
  SELF_SCROLLING_SECTIONS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  searchSettings,
  tabsFor,
} from "./settingsCatalog";
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

  it("decides, for every section with panes, whether it scrolls its own pane", () => {
    // The bug this pins: a section can be given a vertical rail without being handed a definite
    // height, and the symptom is not a crash — it is the heading and the rail scrolling away with
    // the content they were meant to stay above, which only shows up by looking. Neither set may
    // merely omit a section: one of the two has to claim it, on purpose.
    for (const section of SETTINGS_SECTIONS) {
      if (!section.tabs?.length) continue;
      const rail = SELF_SCROLLING_SECTIONS.has(section.id);
      const strip = HORIZONTAL_TAB_SECTIONS.has(section.id);
      expect(
        rail !== strip,
        `${section.id} has panes but is in ${rail && strip ? "both" : "neither"} of ` +
          `SELF_SCROLLING_SECTIONS and HORIZONTAL_TAB_SECTIONS`,
      ).toBe(true);
    }
  });

  it("never claims a section that does not exist", () => {
    const ids = new Set(SETTINGS_SECTIONS.map((section) => section.id));
    for (const id of [...SELF_SCROLLING_SECTIONS, ...HORIZONTAL_TAB_SECTIONS]) {
      expect(ids.has(id), `${id} is not a section`).toBe(true);
    }
  });

  it("only lets a section scroll its own pane when it has panes to scroll", () => {
    for (const id of SELF_SCROLLING_SECTIONS) {
      expect(tabsFor(id).length, `${id} scrolls its own pane but declares no panes`).toBeGreaterThan(0);
    }
  });

  it("returns the panes of a section by id", () => {
    expect(tabsFor("tasks").map((tab) => tab.id)).toContain("git");
    expect(tabsFor("general").map((tab) => tab.id)).toContain("language");
    expect(tabsFor("voice").map((tab) => tab.id)).toEqual(["devices", "models", "dictation", "meetings", "reading"]);
  });

  it("files every section under one of the nav's four groups, in the groups' order", () => {
    const groups = SETTINGS_GROUPS.map((group) => group.id);
    expect(groups).toEqual(["app", "code", "ai", "apps"]);
    const order = SETTINGS_SECTIONS.map((section) => groups.indexOf(section.group));
    expect(order.every((index) => index >= 0)).toBe(true);
    // The nav draws the groups one after another, so the catalog lists them that way too.
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const group of SETTINGS_GROUPS) expect(translations.en[group.labelKey]).toBeTruthy();
  });

  it("translates every rail heading, and starts a headed rail with one", () => {
    for (const section of SETTINGS_SECTIONS) {
      const tabs = section.tabs ?? [];
      for (const tab of tabs) if (tab.headingKey) expect(translations.en[tab.headingKey], `${section.id}/${tab.id}`).toBeTruthy();
      // A rail that falls into parts names the first part too, or its first rows belong to no one.
      if (tabs.some((tab) => tab.headingKey)) expect(tabs[0].headingKey, `${section.id} starts without a heading`).toBeTruthy();
    }
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
    expect(all.some((hit) => hit.section.scope === "workspace")).toBe(true);
    expect(globalOnly.every((hit) => hit.section.scope !== "workspace")).toBe(true);
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchSettings("zzzzzz", t)).toEqual([]);
  });

  it("finds the sound and the thinking design by what people call them", () => {
    // Neither pane is looked for by its own name: people type "volume" or "orb".
    expect(searchSettings("volume", t).some((hit) => hit.section.id === "notifications" && hit.tab?.id === "sound")).toBe(true);
    expect(searchSettings("orb", t).some((hit) => hit.section.id === "appearance" && hit.tab?.id === "thinking")).toBe(true);
    // Synonyms live on the panes, not the section: "sound" no longer answers with every
    // notification pane.
    const sound = searchSettings("sound", t).filter((hit) => hit.section.id === "notifications");
    expect(sound.map((hit) => hit.tab?.id)).toEqual(["sound"]);
  });

  it("reaches the panes that used to be unreachable", () => {
    // Terminal, Remote and Backup were missing from the command palette's hand-written list; the
    // catalog is what makes forgetting one impossible.
    for (const wanted of ["terminal", "remote", "backup", "vault", "notifications", "voice", "tools", "databases"]) {
      const section = SETTINGS_SECTIONS.find((entry) => entry.id === wanted);
      expect(section, `${wanted} is not in the catalog`).toBeTruthy();
      const hits = searchSettings(t(section!.labelKey), t);
      expect(hits.some((hit) => hit.section.id === wanted), `${wanted} is not findable`).toBe(true);
    }
  });

  it("finds what moved by its old name and by what people call it", () => {
    // Pipelines is a pane of Integrations now; the speaker and the reading voice are under Voice & sound.
    expect(searchSettings("pipelines", t).some((hit) => hit.section.id === "azure" && hit.tab?.id === "pipelines")).toBe(true);
    expect(searchSettings("tts", t).some((hit) => hit.section.id === "voice" && hit.tab?.id === "reading")).toBe(true);
    expect(searchSettings("speaker", t).some((hit) => hit.section.id === "voice" && hit.tab?.id === "devices")).toBe(true);
    expect(searchSettings("whisper", t).some((hit) => hit.section.id === "voice" && hit.tab?.id === "models")).toBe(true);
    expect(searchSettings("commit", t).some((hit) => hit.section.id === "tasks" && hit.tab?.id === "git")).toBe(true);
  });
});
