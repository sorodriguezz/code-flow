import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, isLegacyModel, modelDisplayLabel } from "./aiProviders";

const t = (key: string) => key;

describe("modelDisplayLabel", () => {
  // A run reports the dated id (`claude-sonnet-5-5-…`), and `sameModelFamily` matches it by prefix
  // in catalog order — so a shorter id listed first (`claude-sonnet-5`) would name a newer model
  // after an older one. Every catalog entry has to keep its own dated ids.
  it("names each Claude model's dated id after that model, not an older one", () => {
    for (const model of PROVIDER_MODELS.claude) {
      expect(modelDisplayLabel("claude", `${model.id}-20260901`, t)).toBe(model.label);
    }
  });

  it("tells Sonnet 5.5 from Sonnet 5", () => {
    expect(modelDisplayLabel("claude", "claude-sonnet-5-5", t)).toBe("Sonnet 5.5");
    expect(modelDisplayLabel("claude", "claude-sonnet-5", t)).toBe("Sonnet 5");
  });

  it("tells Fable 5.1 from Fable 5, dated ids included", () => {
    expect(modelDisplayLabel("claude", "claude-fable-5-1", t)).toBe("Fable 5.1");
    expect(modelDisplayLabel("claude", "claude-fable-5-1-20260901", t)).toBe("Fable 5.1");
    expect(modelDisplayLabel("claude", "claude-fable-5", t)).toBe("Fable 5");
  });

  it("keeps the model's name for a [1m] variant", () => {
    expect(modelDisplayLabel("claude", "claude-opus-4-6[1m]", t)).toBe("Opus 4.6 · 1M");
    expect(modelDisplayLabel("claude", "claude-sonnet-4-6[1M]", t)).toBe("Sonnet 4.6 · 1M");
    // An id the catalog does not know is still shown as it is.
    expect(modelDisplayLabel("claude", "opus[1m]", t)).toBe("opus[1m]");
  });
});

describe("the Claude catalog", () => {
  it("lists every id once", () => {
    const ids = PROVIDER_MODELS.claude.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("offers the earlier generations as legacy, and never a retired model", () => {
    for (const id of ["claude-fable-5", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6"]) {
      expect(isLegacyModel("claude", id)).toBe(true);
    }
    expect(isLegacyModel("claude", "claude-opus-5-5")).toBe(false);
    // Retired 2026-01-05: offering it would make every turn fail.
    expect(PROVIDER_MODELS.claude.some((m) => m.id.startsWith("claude-3-opus"))).toBe(false);
  });

  it("lists the legacy models after the current ones", () => {
    const firstLegacy = PROVIDER_MODELS.claude.findIndex((m) => m.legacy);
    expect(firstLegacy).toBeGreaterThan(0);
    expect(PROVIDER_MODELS.claude.slice(firstLegacy).every((m) => m.legacy)).toBe(true);
  });
});
