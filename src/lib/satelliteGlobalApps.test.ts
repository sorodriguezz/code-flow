import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}), emit: () => Promise.resolve() }));

import { APPS, appKey } from "./railApps";
import { GLOBAL_APP_REFS } from "./satelliteGlobalApps";

describe("satellite global apps", () => {
  it("lists exactly the rail apps flagged global", () => {
    const fromRail = APPS.filter((a) => a.global).map((a) => appKey(a));
    expect([...GLOBAL_APP_REFS].sort()).toEqual(fromRail.sort());
  });
});
