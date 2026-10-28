import { describe, expect, it } from "vitest";
import { azureLayer, azureTone, azureTypeLabel, cellText, kubeLayer, layeredLayout, NODE_W } from "./topologyModel";

describe("layeredLayout", () => {
  it("puts layers in columns and bands one under the other", () => {
    const { positions, bands } = layeredLayout(
      [
        { id: "ing", layer: 0, band: "a" },
        { id: "svc", layer: 1, band: "a" },
        { id: "other", layer: 1, band: "b" },
      ],
      [{ from: "ing", to: "svc" }],
    );
    expect(positions.get("svc")!.x).toBeGreaterThan(positions.get("ing")!.x + NODE_W - 1);
    expect(bands.map((b) => b.id)).toEqual(["a", "b"]);
    expect(positions.get("other")!.y).toBeGreaterThan(bands[0].y + bands[0].height);
    expect(positions.get("other")!.x).toBe(0);
  });

  it("orders a column after what it is linked to", () => {
    const { positions } = layeredLayout(
      [
        { id: "a", layer: 0, band: "x" },
        { id: "b", layer: 0, band: "x" },
        { id: "to-b", layer: 1, band: "x" },
        { id: "to-a", layer: 1, band: "x" },
      ],
      [
        { from: "a", to: "to-a" },
        { from: "b", to: "to-b" },
      ],
    );
    expect(positions.get("to-a")!.y).toBeLessThan(positions.get("to-b")!.y);
  });
});

describe("kinds and types", () => {
  it("places Kubernetes kinds left to right", () => {
    expect([kubeLayer("ingresses"), kubeLayer("services"), kubeLayer("deployments"), kubeLayer("secrets"), kubeLayer("pods")]).toEqual([0, 1, 2, 3, 4]);
  });

  it("names Azure types the way the portal does", () => {
    expect(azureTypeLabel("Microsoft.Web/sites", "functionapp,linux")).toBe("Function App");
    expect(azureTypeLabel("Microsoft.Web/sites", "app,linux")).toBe("App Service");
    expect(azureTypeLabel("Microsoft.Sql/servers/databases")).toBe("SQL database");
    expect(azureTypeLabel("Microsoft.Foo/bars")).toBe("bars");
    expect(azureLayer("Microsoft.Network/frontDoors")).toBe(0);
    expect(azureLayer("Microsoft.App/containerApps")).toBe(1);
    expect(azureLayer("Microsoft.KeyVault/vaults")).toBe(3);
  });

  it("takes health before the provisioning state", () => {
    expect(azureTone("Unavailable", "Succeeded")).toBe("bad");
    expect(azureTone(undefined, "Failed")).toBe("bad");
    expect(azureTone(undefined, "Updating")).toBe("warn");
    expect(azureTone(undefined, "Succeeded")).toBe("idle");
    expect(cellText({ a: 1 })).toBe('{"a":1}');
  });
});
