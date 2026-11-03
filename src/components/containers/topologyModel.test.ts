import { describe, expect, it } from "vitest";
import { azureLayer, azureTone, azureTypeLabel, cellText, kubeLayer, layeredLayout, MAX_ROWS, NODE_W } from "./topologyModel";

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
    const other = positions.get("other")!;
    const [a] = bands;
    // Packed beside or under the first band, never inside it.
    expect(other.x >= a.x + a.width || other.y >= a.y + a.height).toBe(true);
  });

  it("wraps a tall layer and packs many bands into a wide grid", () => {
    const nodes = Array.from({ length: 40 }, (_, band) =>
      Array.from({ length: 25 }, (_, i) => ({ id: `${band}-${i}`, layer: i % 2, band: `g${String(band).padStart(2, "0")}` })),
    ).flat();
    const { positions, bands } = layeredLayout(nodes, []);
    const first = nodes.filter((n) => n.band === "g00").map((n) => positions.get(n.id)!);
    const rows = new Set(first.filter((p) => p.x === bands[0].x).map((p) => p.y)).size;
    expect(rows).toBeLessThanOrEqual(MAX_ROWS);
    const width = Math.max(...bands.map((b) => b.x + b.width));
    const height = Math.max(...bands.map((b) => b.y + b.height));
    expect(width / height).toBeGreaterThan(1);
    for (const b of bands) for (const c of bands) if (b !== c) expect(b.x + b.width <= c.x || c.x + c.width <= b.x || b.y + b.height <= c.y || c.y + c.height <= b.y).toBe(true);
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
