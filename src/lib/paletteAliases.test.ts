import { describe, expect, it, vi } from "vitest";

// paletteItems pulls in the stores, and dbStore listens for events at import time.
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }));

import {
  SCOPE_GROUPS,
  aliasHint,
  filterPaletteItems,
  frequentItems,
  PALETTE_ALIASES,
  VIEW_ITEMS,
  type PaletteItem,
} from "./paletteItems";

/** The palette's rows as the builder keys them, with a label that matches nothing on purpose: a
 * query found here was found by its alias. */
function rows(): PaletteItem[] {
  return Object.entries(PALETTE_ALIASES).map(([key, keywords]) => ({
    key,
    icon: VIEW_ITEMS[0].icon,
    label: "·",
    group: key.startsWith("action:") ? "actions" : "views",
    onSelect: () => {},
    keywords,
  }));
}

const first = (query: string) => filterPaletteItems(rows(), SCOPE_GROUPS.all, query)[0]?.key;

describe("palette aliases", () => {
  it.each([
    ["postman", "view:api:requests"],
    ["endpoint", "view:api:requests"],
    ["probar api", "view:api:requests"],
    ["dbeaver", "view:api:database"],
    ["consulta sql", "view:api:database"],
    ["SSH", "view:remote:"],
    ["sftp", "view:remote:"],
    ["staging", "view:changes:"],
    ["git commit", "view:changes:"],
    ["pull request", "action:pr-from-link"],
    ["cron", "view:flows:"],
    ["automatizar", "view:flows:"],
    ["contraseñas", "view:vault:"],
    ["docker", "view:containers"],
  ])("%s → %s", (query, key) => {
    expect(first(query)).toBe(key);
  });

  it("names only keys the builder makes", () => {
    const views = new Set(VIEW_ITEMS.map(({ id, workspace }) => `view:${id}:${workspace ?? ""}`));
    const fixed = ["view:ai-panel", "view:terminal", "view:containers", "view:services"];
    for (const key of Object.keys(PALETTE_ALIASES)) {
      if (key.startsWith("view:")) expect(views.has(key) || fixed.includes(key), key).toBe(true);
    }
  });
});

describe("frequent rows", () => {
  const item = (key: string, group: PaletteItem["group"], label = key): PaletteItem => ({
    key,
    icon: VIEW_ITEMS[0].icon,
    label,
    group,
    onSelect: () => {},
  });
  const items = [
    item("view:graph:", "views"),
    item("view:api:database", "views"),
    item("action:push", "actions"),
    item("view:notes:", "views"),
  ];

  it("ranks by views opened plus palette picks, and skips what was never used", () => {
    const counts = new Map([
      ["view:databases", 3],
      ["command:view:api", 1],
      ["view:graph", 2],
      ["command:action:push", 5],
    ]);
    const rows = frequentItems(items, counts);
    expect(rows.map((r) => r.origin?.key)).toEqual(["action:push", "view:api:database", "view:graph:"]);
    expect(rows.every((r) => r.group === "frequent" && r.key.startsWith("frequent:"))).toBe(true);
  });

  it("shows only with an empty query", () => {
    const rows = [...frequentItems(items, new Map([["view:graph", 1]])), ...items];
    expect(filterPaletteItems(rows, SCOPE_GROUPS.all, "")[0].group).toBe("frequent");
    expect(filterPaletteItems(rows, SCOPE_GROUPS.all, "view:graph").some((r) => r.group === "frequent")).toBe(false);
  });
});

describe("alias hint", () => {
  const api: PaletteItem = {
    key: "view:api:requests",
    icon: VIEW_ITEMS[0].icon,
    label: "Cliente API",
    group: "views",
    onSelect: () => {},
    keywords: PALETTE_ALIASES["view:api:requests"],
  };
  it("names the hidden word a query landed on", () => {
    expect(aliasHint(api, "postman")).toBe("postman");
    expect(aliasHint(api, "probar api")).toBe("probar");
  });
  it("is silent when the label already says it", () => {
    expect(aliasHint(api, "cliente")).toBeNull();
    expect(aliasHint(api, "")).toBeNull();
  });
});
