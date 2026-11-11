import { describe, expect, it, vi } from "vitest";
import { CharacterMesh, type Point3, type Solid } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { buildWalle } from "./walle";
import { buildTars } from "./tars";
import { buildR2d2 } from "./r2d2";
import { frontPanel } from "./cinemaGeometry";
import type { Rgb } from "./palette";

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const SEGMENTS = 16;
const SIZE = 180;
const QUARTER_TURN = Math.PI / TWO;
const X = 0;
const Y = 1;
const Z = 2;
const GROUP = "group";
const BOX = "box";
const ROOT: Point3 = [0, 0, 0];
const LOOK_RIGHT = 0.7;
const TIME = 0.6;
const POSE: CharacterPose = {
  time: TIME, gazeX: ZERO, gazeY: ZERO, work: ZERO, read: ZERO,
  write: ZERO, speak: ZERO, listen: ZERO, quiet: ZERO, done: ZERO,
  failed: ZERO, signal: ZERO,
};
const RED: Rgb = [255, 0, 0];
const BLUE: Rgb = [0, 0, 255];
const WHITE: Rgb = [255, 255, 255];
const ORIENTATION: Point3 = [-0.12, -0.24, 0];
const SHELL: Solid = [[0, 0, 0], [0.4, 0.8, 0.1]];
const LABEL: Solid = [[0, -0.2, 0.051], [0.1, 0.04, 0.002]];
const SURFACE_ANCHOR: Point3 = [0, 0, 0.085];
const DOME: Solid = [[0, 0, 0], [0.2, 0.2, 0.2]];
const DOME_PAINT: Point3 = [-0.1, 0, 0];
const SCALE = 0.9;
const RED_PREFIX = "rgba(";
const BLUE_CHANNEL_PATTERN = /^rgba\(0,0,[1-9]/;
const RED_CHANNEL_PATTERN = /^rgba\([1-9]\d*,0,0,/;
const MECHANICS_SUITE = "cinema character articulation";
const TARS_GAIT = "TARS unfolds its four columns into a lower, wider running stance";
const TARS_FINISH = "TARS finishes without splaying its columns like arms";
const WALLE_GAZE = "WALL·E turns its binocular head while the tracks stay planted";
const R2_GAZE = "R2-D2 follows the pointer by rotating its dome without pitching it";
const DECAL_TEST = "keeps a front label above its sloping shell through a group transform";
const DOME_TEST = "colors the dome surface itself without overlapping blue patches";

function drawingContext() {
  const colors: string[] = [];
  const points: number[][] = [];
  const context = {
    fillStyle: RED_PREFIX,
    beginPath() {},
    moveTo(x: number, y: number) { points.push([x, y]); },
    lineTo(x: number, y: number) { points.push([x, y]); },
    closePath() {}, stroke() {},
    fill() { colors.push(this.fillStyle); },
  };
  return { ctx: context as unknown as CanvasRenderingContext2D, colors, points };
}

function tarsBounds(pose: CharacterPose) {
  const mesh = new CharacterMesh(SEGMENTS);
  const { ctx, points } = drawingContext();
  buildTars(mesh, pose);
  mesh.paint(ctx, 32, [-0.12, -0.22, 0], ROOT, 0.96, WHITE, ZERO, ONE);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

describe(MECHANICS_SUITE, () => {
  it(TARS_GAIT, () => {
    const standing = tarsBounds({ ...POSE, quiet: ONE });
    const running = tarsBounds({ ...POSE, work: ONE });
    expect(running.width - standing.width).toBeGreaterThan(8);
    expect(standing.height - running.height).toBeGreaterThan(3);
  });

  it("TARS alternates upright and spider gaits on the rail without a supplied activity", () => {
    const standing = tarsBounds({ ...POSE, time: 0 });
    const crawling = tarsBounds({ ...POSE, time: 1.8 });
    expect(crawling.width - standing.width).toBeGreaterThan(8);
    expect(standing.height - crawling.height).toBeGreaterThan(3);
  });

  it(TARS_FINISH, () => {
    const mesh = new CharacterMesh(SEGMENTS);
    const groups = vi.spyOn(mesh, GROUP);
    const pose = { ...POSE, done: ONE };
    buildTars(mesh, pose);
    for (const [, angles] of groups.mock.calls) {
      const pitch = Math.abs(angles[X]);
      expect(Math.abs(angles[Z])).toBe(ZERO);
      expect(pitch).toBeLessThan(QUARTER_TURN);
    }
  });

  it.each([
    { work: 1 }, { write: 1 }, { done: 1 }, { failed: 1 }, { listen: 1, gazeX: 1 },
  ])("keeps TARS made of four equal segmented columns for %j", (activity) => {
    const mesh = new CharacterMesh(SEGMENTS);
    const boxes = vi.spyOn(mesh, BOX);
    buildTars(mesh, { ...POSE, ...activity });
    const columns = new Map<number, number>();
    for (const [solid] of boxes.mock.calls) {
      const [center, size] = solid;
      columns.set(center[X], (columns.get(center[X]) ?? 0) + 1);
      expect(size[X]).toBeCloseTo(0.102);
      expect(size[Y]).toBeCloseTo(0.401);
    }
    expect([...columns.values()]).toEqual([2, 2, 2, 2]);
  });

  it(WALLE_GAZE, () => {
    const restingMesh = new CharacterMesh(SEGMENTS);
    const restingBoxes = vi.spyOn(restingMesh, BOX);
    buildWalle(restingMesh, POSE);
    const lookingMesh = new CharacterMesh(SEGMENTS);
    const lookingBoxes = vi.spyOn(lookingMesh, BOX);
    const groups = vi.spyOn(lookingMesh, GROUP);
    const looking = { ...POSE, gazeX: LOOK_RIGHT };
    buildWalle(lookingMesh, looking);
    const head = groups.mock.calls.find(([pivot]) => pivot[X] === ZERO && pivot[Y] < -0.16);
    const yaw = head?.[ONE][Y] ?? ZERO;
    expect(yaw).toBeGreaterThan(ZERO);
    const restingTreads = restingBoxes.mock.calls.filter(([solid]) => solid[ZERO][Y] > ZERO);
    const lookingTreads = lookingBoxes.mock.calls.filter(([solid]) => solid[ZERO][Y] > ZERO);
    expect(lookingTreads).toEqual(restingTreads);
  });

  it(R2_GAZE, () => {
    const mesh = new CharacterMesh(SEGMENTS);
    const groups = vi.spyOn(mesh, GROUP);
    const pose = { ...POSE, gazeX: LOOK_RIGHT, gazeY: ONE };
    buildR2d2(mesh, pose);
    const head = groups.mock.calls.find(([pivot]) => pivot[X] === ZERO && pivot[Y] < ZERO);
    const angles = head?.[ONE] ?? ROOT;
    expect(angles[X]).toBe(ZERO);
    expect(angles[Z]).toBe(ZERO);
    expect(angles[Y]).toBeGreaterThan(ZERO);
  });

  it(DECAL_TEST, () => {
    const mesh = new CharacterMesh(SEGMENTS);
    const { ctx, colors } = drawingContext();
    const drawFront = () => frontPanel(mesh, LABEL, RED);
    const drawModel = () => {
      mesh.box(SHELL, BLUE);
      mesh.decal(SURFACE_ANCHOR, drawFront);
    };
    mesh.group(ROOT, ORIENTATION, drawModel);
    mesh.paint(ctx, SIZE, ROOT, ROOT, SCALE, WHITE, ZERO, ONE);
    const last = colors[colors.length - ONE];
    expect(last).toMatch(RED_CHANNEL_PATTERN);
  });

  it("keeps layered lens details in front of their faceplate through a tilt", () => {
    const mesh = new CharacterMesh(SEGMENTS);
    const { ctx, colors } = drawingContext();
    mesh.decal(SURFACE_ANCHOR, () => {
      frontPanel(mesh, [[0, 0, 0.052], [0.3, 0.6, 0]], BLUE);
      frontPanel(mesh, [[0, 0.2, 0.053], [0.08, 0.08, 0]], RED);
    });
    mesh.paint(ctx, SIZE, ORIENTATION, ROOT, SCALE, WHITE, ZERO, ONE);
    expect(colors[colors.length - 1]).toMatch(RED_CHANNEL_PATTERN);
  });

  it(DOME_TEST, () => {
    const mesh = new CharacterMesh(SEGMENTS);
    const { ctx, colors } = drawingContext();
    const material = (normal: Point3) => normal[X] > ZERO ? RED : BLUE;
    mesh.ellipsoid(DOME, WHITE, true, material);
    mesh.paint(ctx, SIZE, DOME_PAINT, ROOT, SCALE, WHITE, ZERO, ONE);
    const red = colors.some((color) => RED_CHANNEL_PATTERN.test(color));
    const blue = colors.some((color) => BLUE_CHANNEL_PATTERN.test(color));
    expect(red).toBe(true);
    expect(blue).toBe(true);
  });
});
