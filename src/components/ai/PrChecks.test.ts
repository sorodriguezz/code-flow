import { describe, expect, it, vi } from "vitest";
import type { PrCheck } from "../../types/domain";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));

const { sortChecks, tallyChecks } = await import("./PrChecks");

const check = (name: string, state: string): PrCheck => ({
  kind: "check",
  name,
  state,
  raw_state: state,
  description: null,
  url: null,
  pipeline_run_id: null,
  required: null,
});

describe("the checks list", () => {
  it("reads failing first, then what is still running, the host's order within each", () => {
    const sorted = sortChecks([
      check("lint", "success"),
      check("unit", "failed"),
      check("e2e", "running"),
      check("docs", "skipped"),
      check("build", "failed"),
      check("deploy", "queued"),
    ]);
    expect(sorted.map((c) => c.name)).toEqual(["unit", "build", "e2e", "deploy", "docs", "lint"]);
  });

  it("adds up to passed of total, with what is failing and pending beside it", () => {
    expect(
      tallyChecks([check("a", "success"), check("b", "failed"), check("c", "queued"), check("d", "warning")]),
    ).toEqual({ total: 4, passed: 1, failing: 1, pending: 1 });
    expect(tallyChecks([])).toEqual({ total: 0, passed: 0, failing: 0, pending: 0 });
  });
});
