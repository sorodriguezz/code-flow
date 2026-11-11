import { describe, expect, it, vi } from "vitest";
import { CharacterMesh, type Point3, type Solid } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { buildWalle } from "./walle";
import { buildBaymax } from "./baymax";
import { buildR2d2 } from "./r2d2";
import { frontPanel } from "./cinemaGeometry";
import type { Rgb } from "./palette";

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const SEGMENTS = 16;
const SIZE = 180;
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
const BAYMAX_FRAME_PX = 32;
const BAYMAX_ORIENTATION: Point3 = [-0.12, -0.12, 0];
const BAYMAX_SCALE = 0.96;
const BAYMAX_DEFLATION_RATIO = 0.65;
const BAYMAX_PARTIAL_FAILURE = 0.5;
const BAYMAX_HEAD_Y = -0.3;
const BAYMAX_GAZE_TEST = "B Max turns its head toward the pointer while keeping its feet planted";
const BAYMAX_ERROR_TEST = "B Max progressively deflates toward the floor when a run fails";
const BAYMAX_EYES_TEST = "B Max replaces its round eyes with two crosses on failure";
const BAYMAX_CROSS_VERTICES = 4;
const BAYMAX_FACE_INK: Rgb = [19, 23, 28];
const ELLIPSOID = "ellipsoid";
const POLYGON = "polygon";
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

function baymaxBounds(pose: CharacterPose) {
  const mesh = new CharacterMesh(SEGMENTS);
  const { ctx, points } = drawingContext();
  buildBaymax(mesh, pose);
  mesh.paint(ctx, BAYMAX_FRAME_PX, BAYMAX_ORIENTATION, ROOT, BAYMAX_SCALE, WHITE, ZERO, ONE);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    bottom: Math.max(...ys),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

describe(MECHANICS_SUITE, () => {
  it(BAYMAX_ERROR_TEST, () => {
    const standingPose = { ...POSE, quiet: ONE };
    const halfwayPose = { ...POSE, failed: BAYMAX_PARTIAL_FAILURE };
    const failedPose = { ...POSE, failed: ONE };
    const standing = baymaxBounds(standingPose);
    const halfway = baymaxBounds(halfwayPose);
    const deflated = baymaxBounds(failedPose);
    const maximumHeight = standing.height * BAYMAX_DEFLATION_RATIO;
    expect(halfway.height).toBeLessThan(standing.height);
    expect(halfway.height).toBeGreaterThan(deflated.height);
    expect(deflated.height).toBeLessThan(maximumHeight);
    expect(deflated.bottom).toBeCloseTo(standing.bottom, ONE);
  });

  it(BAYMAX_GAZE_TEST, () => {
    const restingMesh = new CharacterMesh(SEGMENTS);
    const restingParts = vi.spyOn(restingMesh, ELLIPSOID);
    buildBaymax(restingMesh, POSE);
    const lookingMesh = new CharacterMesh(SEGMENTS);
    const lookingParts = vi.spyOn(lookingMesh, ELLIPSOID);
    const groups = vi.spyOn(lookingMesh, GROUP);
    const lookingPose = { ...POSE, gazeX: LOOK_RIGHT, gazeY: ONE };
    buildBaymax(lookingMesh, lookingPose);
    const head = groups.mock.calls.find(([pivot]) => pivot[Y] < BAYMAX_HEAD_Y);
    const yaw = head?.[ONE][Y] ?? ZERO;
    expect(yaw).toBeGreaterThan(ZERO);
    const restingFeet = restingParts.mock.calls.slice(ZERO, TWO);
    const lookingFeet = lookingParts.mock.calls.slice(ZERO, TWO);
    expect(lookingFeet).toEqual(restingFeet);
  });

  it(BAYMAX_EYES_TEST, () => {
    const mesh = new CharacterMesh(SEGMENTS);
    const polygons = vi.spyOn(mesh, POLYGON);
    const failedPose = { ...POSE, failed: ONE };
    buildBaymax(mesh, failedPose);
    const eyeShapes = polygons.mock.calls.filter(([, color]) => {
      const matchingInk = color.every((channel, index) => channel === BAYMAX_FACE_INK[index]);
      return matchingInk;
    });
    const crosses = eyeShapes.filter(([points]) => points.length === BAYMAX_CROSS_VERTICES);
    const crossCount = crosses.length - ONE;
    expect(crossCount).toBe(TWO * TWO);
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
