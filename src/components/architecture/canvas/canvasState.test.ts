import { describe, expect, it } from "vitest";
import { carryOver } from "./canvasState";
import { LIGHT_PALETTE } from "../../../lib/architecture/svg";
import { samePalette } from "../palette";

type N = { id: string; position: { x: number; y: number }; measured?: { width?: number; height?: number }; dragging?: boolean; data?: string };

describe("carryOver", () => {
  it("keeps what React Flow measured, so the dots and the lines survive a new scene", () => {
    const prev: N[] = [{ id: "api", position: { x: 0, y: 0 }, measured: { width: 228, height: 66 } }];
    const [api] = carryOver<N>([{ id: "api", position: { x: 40, y: 10 }, data: "new" }], prev);
    expect(api.measured).toEqual({ width: 228, height: 66 });
    expect(api.position).toEqual({ x: 40, y: 10 });
    expect(api.data).toBe("new");
  });

  it("leaves a card being dragged where the pointer has it", () => {
    const prev: N[] = [{ id: "api", position: { x: 300, y: 120 }, dragging: true }];
    const [api] = carryOver<N>([{ id: "api", position: { x: 0, y: 0 } }], prev);
    expect(api.position).toEqual({ x: 300, y: 120 });
    expect(api.dragging).toBe(true);
  });

  it("takes the scene's place once the drag is over, and brings new nodes as they are", () => {
    const prev: N[] = [{ id: "api", position: { x: 300, y: 120 }, dragging: false, measured: { width: 228, height: 66 } }];
    const next: N[] = [{ id: "api", position: { x: 300, y: 124 } }, { id: "db", position: { x: 5, y: 5 } }];
    const out = carryOver<N>(next, prev);
    expect(out[0].position).toEqual({ x: 300, y: 124 });
    expect(out[1]).toBe(next[1]);
  });
});

describe("samePalette", () => {
  it("keeps the palette it had when nothing in it changed", () => {
    const prev = { ...LIGHT_PALETTE };
    expect(samePalette(prev, { ...LIGHT_PALETTE })).toBe(prev);
    const changed = { ...LIGHT_PALETTE, hot: "#ff0000" };
    expect(samePalette(prev, changed)).toBe(changed);
  });
});
