import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The rail's keyboard model: one toolbar, one roving tab stop. See `AppRail` and `lib/railKeyNav`.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../../state/languageStore", () => ({
  useT: () => (key: string, params?: Record<string, string>) => (params?.name ? `${key}:${params.name}` : key),
  translate: (key: string) => key,
  useLanguageStore: (select: (s: { language: string }) => unknown) => select({ language: "en" }),
}));

const { AppRail } = await import("./AppRail");
const { railTabStop } = await import("../../lib/railKeyNav");
const { APPS, appKey } = await import("../../lib/railApps");

const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
const appButtons = (html: string) => buttons(html).filter((b) => b.includes("data-rail-app="));
const tabIndexOf = (tag: string) => tag.match(/tabindex="(-?\d+)"/)?.[1];

describe("AppRail keyboard model", () => {
  const html = renderToStaticMarkup(<AppRail />);

  it("is a labelled vertical toolbar", () => {
    expect(html).toMatch(/role="toolbar"[^>]*aria-orientation="vertical"[^>]*aria-label="tabbar\.workspaceTools"/);
  });

  it("has exactly one tabbable app button and the rest out of the Tab order", () => {
    const apps = appButtons(html);
    expect(apps.length).toBe(APPS.length);
    expect(apps.filter((b) => tabIndexOf(b) === "0")).toHaveLength(1);
    expect(apps.filter((b) => tabIndexOf(b) === "-1")).toHaveLength(APPS.length - 1);
  });

  it("keeps the corner «open in window» buttons out of the Tab order", () => {
    const corners = buttons(html).filter((b) => b.includes("windows.openInWindow"));
    expect(corners.length).toBeGreaterThan(0);
    for (const c of corners) expect(tabIndexOf(c)).toBe("-1");
  });

  it("leaves the assistant, the tour and the workspace tile tabbable", () => {
    const rest = buttons(html).filter((b) => !b.includes("data-rail-app=") && !b.includes("windows.openInWindow"));
    expect(rest.length).toBeGreaterThanOrEqual(3);
    for (const b of rest) expect(tabIndexOf(b)).toBeUndefined();
  });

  it("puts no tabindex on anything that is not a button", () => {
    const stray = [...html.matchAll(/<(?!button\b)(\w+)\b[^>]*\btabindex=/g)];
    expect(stray).toHaveLength(0);
  });

  it("names and describes every app button for a screen reader", () => {
    for (const b of appButtons(html)) {
      expect(b).toMatch(/aria-label="[^"]+"/);
      const ref = b.match(/aria-describedby="([^"]+)"/)?.[1];
      expect(ref).toBeTruthy();
      expect(html).toContain(`id="${ref}"`);
    }
  });

  it("never lets a vanished remembered key take the stop away", () => {
    // (Server rendering reads a store's initial state, so the order is exercised via `ordered`'s
    // contract in the pure test below and the live render above.)
    expect(railTabStop(APPS.map(appKey), "ghost", null)).toBe(appKey(APPS[0]));
  });
});
