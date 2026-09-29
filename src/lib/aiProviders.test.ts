import { describe, expect, it } from "vitest";
import { PROVIDER_MODELS, modelDisplayLabel } from "./aiProviders";

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
});
