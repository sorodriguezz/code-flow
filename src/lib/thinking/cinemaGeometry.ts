import { CharacterMesh, type Point3, type Solid } from "./characterMesh";
import type { Rgb } from "./palette";

export type ProfilePoint = readonly [number, number];
const ZERO = 0;
const ONE = 1;
const HALF = 0.5;
const X = 0;
const Y = 1;
const Z = 2;
const FRONT_NORMAL: Point3 = [0, 0, 1];
const BACK_NORMAL: Point3 = [0, 0, -1];

export function extrudeProfile(mesh: CharacterMesh, profile: readonly ProfilePoint[], center: Point3, depth: number, color: Rgb) {
  const frontZ = center[Z] + depth * HALF;
  const backZ = center[Z] - depth * HALF;
  const front = profile.map(([x, y]): Point3 => [center[X] + x, center[Y] + y, frontZ]);
  const back = profile.map(([x, y]): Point3 => [center[X] + x, center[Y] + y, backZ]);
  const reversedBack = [...back];
  reversedBack.reverse();
  mesh.polygon(front, color, FRONT_NORMAL);
  mesh.polygon(reversedBack, color, BACK_NORMAL);
  const count = profile.length;
  for (let index = ZERO; index < count; index += ONE) {
    const next = (index + ONE) % count;
    const dx = profile[next][X] - profile[index][X];
    const dy = profile[next][Y] - profile[index][Y];
    const length = Math.hypot(dx, dy);
    const normal: Point3 = [dy / length, -dx / length, ZERO];
    const points = [back[index], back[next], front[next], front[index]];
    mesh.polygon(points, color, normal);
  }
}

export function frontPanel(mesh: CharacterMesh, [center, size]: Solid, color: Rgb) {
  const left = center[X] - size[X] * HALF;
  const right = center[X] + size[X] * HALF;
  const top = center[Y] - size[Y] * HALF;
  const bottom = center[Y] + size[Y] * HALF;
  const points: Point3[] = [[left, top, center[Z]], [right, top, center[Z]], [right, bottom, center[Z]], [left, bottom, center[Z]]];
  mesh.polygon(points, color, FRONT_NORMAL);
}

export function frontOval(mesh: CharacterMesh, [x, y, z]: Point3, rx: number, ry: number, color: Rgb) {
  const points: Point3[] = [];
  const sides = 20;
  for (let index = 0; index < sides; index++) {
    const angle = index / sides * Math.PI * 2;
    points.push([x + Math.cos(angle) * rx, y + Math.sin(angle) * ry, z]);
  }
  mesh.polygon(points, color, FRONT_NORMAL);
}
