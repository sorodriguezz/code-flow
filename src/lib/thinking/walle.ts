import type { CharacterMesh, Point3 } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { extrudeProfile, frontOval, frontPanel, type ProfilePoint } from "./cinemaGeometry";
import { blink } from "./face";
import { mix, type Rgb } from "./palette";

const SIDES = [-1, 1] as const;
const COLORS = {
  gold: [229, 162, 42], door: [246, 181, 57], highlight: [255, 208, 104],
  rust: [133, 79, 37], bronze: [176, 119, 59], steel: [143, 148, 140],
  silver: [196, 203, 191], rim: [93, 105, 105], rubber: [43, 43, 38],
  tread: [105, 99, 81], recess: [44, 50, 45], glass: [20, 34, 42],
  iris: [61, 91, 103], glint: [204, 237, 244], red: [200, 68, 48],
} satisfies Record<string, Rgb>;
const TRACK: readonly ProfilePoint[] = [
  [-0.197, 0.022], [-0.102, -0.103], [-0.038, -0.13], [0.04, -0.123],
  [0.184, 0.011], [0.21, 0.065], [0.171, 0.112], [-0.155, 0.112], [-0.204, 0.074],
];
const TRACK_WIDTH = 0.149;
const TRACK_Y = 0.283;
const TRACK_EDGES = TRACK.map(([x, y], index) => {
  const [nextX, nextY] = TRACK[(index + 1) % TRACK.length];
  const dx = nextX - x;
  const dy = nextY - y;
  const length = Math.hypot(dx, dy);
  return { x, y, length, tx: dx / length, ty: dy / length };
});
const BELT_LENGTH = TRACK_EDGES.reduce((length, edge) => length + edge.length, 0);
const BELT_STEP = BELT_LENGTH / 29;
const EYE: readonly ProfilePoint[] = [
  [-0.101, -0.054], [-0.062, -0.071], [0.049, -0.092], [0.086, -0.068],
  [0.101, -0.024], [0.095, 0.042], [0.066, 0.074], [-0.012, 0.066], [-0.09, 0.037],
];
const HEAD_JOINT: Point3 = [0, -0.195, -0.01];

function drawBelt(mesh: CharacterMesh, x: number, travel: number) {
  let distance = 0;
  for (const { x: z, y, length, tx, ty } of TRACK_EDGES) {
    const phase = ((distance - travel) % BELT_STEP + BELT_STEP) % BELT_STEP;
    for (let offset = -phase; offset < length; offset += BELT_STEP) {
      const start = Math.max(0, offset);
      const end = Math.min(length, offset + 0.015);
      if (end <= start) continue;
      const y1 = TRACK_Y + y + ty * start - tx * 0.0035;
      const y2 = TRACK_Y + y + ty * end - tx * 0.0035;
      const z1 = z + tx * start + ty * 0.0035;
      const z2 = z + tx * end + ty * 0.0035;
      const left = x - TRACK_WIDTH / 2 - 0.001;
      const right = x + TRACK_WIDTH / 2 + 0.001;
      mesh.polygon([[left, y1, z1], [right, y1, z1], [right, y2, z2], [left, y2, z2]], COLORS.tread, [0, -tx, ty]);
    }
    distance += length;
  }
}

function drawTracks(mesh: CharacterMesh, pose: CharacterPose) {
  const travel = pose.time * 0.19 * pose.work;
  for (const side of SIDES) {
    const x = side * 0.271;
    const pivot: Point3 = [x, TRACK_Y, 0];
    mesh.group(pivot, [0, -Math.PI / 2, 0], () => extrudeProfile(mesh, TRACK, pivot, TRACK_WIDTH, COLORS.rubber));
    drawBelt(mesh, x, travel);

    for (const [z, y, radius] of [[-0.124, 0.317, 0.057], [0.123, 0.317, 0.057], [-0.022, 0.221, 0.05]]) {
      const wheel: Point3 = [x + side * (TRACK_WIDTH / 2 + 0.004), y, z];
      mesh.group(wheel, [0, side * Math.PI / 2, 0], () => {
        frontOval(mesh, wheel, radius, radius, COLORS.tread);
        frontOval(mesh, [wheel[0], y, z + 0.002], radius * 0.75, radius * 0.75, COLORS.bronze);
        frontOval(mesh, [wheel[0], y, z + 0.004], radius * 0.34, radius * 0.34, COLORS.rim);
      });
    }
  }
}

function drawHead(mesh: CharacterMesh, pose: CharacterPose) {
  const neck: Point3 = [0, -0.112, -0.025];
  mesh.group(neck, [-0.24, 0, 0], () => {
    mesh.box([neck, [0.064, 0.172, 0.059]], COLORS.rim);
    for (const x of [-0.027, 0.027]) {
      mesh.box([[x, -0.113, 0.006], [0.013, 0.134, 0.016]], COLORS.silver);
    }
  });
  mesh.ellipsoid([HEAD_JOINT, [0.042, 0.031, 0.039]], COLORS.bronze);

  const nod = Math.sin(pose.time * 4) * pose.read * 0.075 - pose.speak * pose.signal * 0.14;
  const pitch = pose.gazeY * 0.26 + pose.quiet * 0.46 + pose.failed * 0.24 + nod;
  const roll = Math.sin(pose.time * 1.75) * 0.09 * (1 - Math.max(pose.work, pose.quiet))
    + pose.listen * 0.16 - pose.done * 0.14;
  mesh.group(HEAD_JOINT, [pitch, pose.gazeX * 0.49, roll], () => {
    mesh.box([[0, -0.234, 0.035], [0.146, 0.049, 0.076]], COLORS.rim);
    for (const side of SIDES) {
      const x = side * 0.11;
      const y = -0.266;
      const pivot: Point3 = [x, y, 0.014];
      const profile = side === 1 ? EYE : EYE.map(([px, py]): ProfilePoint => [-px, py]).reverse();
      const tilt = side * (-0.075 + pose.quiet * 0.22 + pose.failed * 0.26);
      mesh.group(pivot, [0, side * 0.052, tilt], () => {
        extrudeProfile(mesh, profile, [x, y, 0.016], 0.154, COLORS.steel);
        extrudeProfile(mesh, profile, [x, y, 0.094], 0.014, COLORS.silver);
        mesh.decal([x, y, 0.122], () => {
          const lensX = x + side * 0.011;
          const aperture = pose.quiet ? 0.48 : 0.26 + blink(pose.time, 4.7) * 0.74;
          frontOval(mesh, [lensX, y - 0.002, 0.102], 0.074, 0.07, COLORS.rim);
          frontOval(mesh, [lensX, y - 0.002, 0.104], 0.063, 0.059, mix(COLORS.rim, COLORS.glass, aperture));
          frontOval(mesh, [lensX + 0.004, y + 0.001, 0.105], 0.041 * aperture, 0.04 * aperture, COLORS.iris);
          frontOval(mesh, [lensX + 0.006, y + 0.004, 0.106], 0.03 * aperture, 0.029 * aperture, COLORS.glass);
          frontOval(mesh, [lensX - 0.021, y - 0.024, 0.107], 0.018, 0.011, COLORS.glint);
          frontOval(mesh, [lensX + 0.027, y + 0.023, 0.107], 0.007, 0.006, COLORS.silver);
        });
      });
    }
  });
}

function drawArms(mesh: CharacterMesh, pose: CharacterPose) {
  for (const side of SIDES) {
    const x = side * 0.232;
    const pivot: Point3 = [x, 0.029, 0.003];
    const reach = pose.work * (0.47 + Math.sin(pose.time * 5 + side) * 0.21)
      + pose.write * (0.63 + Math.sin(pose.time * 10 + side) * 0.085);
    const wave = side === 1 ? pose.done * (1.75 + 0.21 * Math.sin(pose.time * 9)) : 0;
    mesh.group(pivot, [0, 0, -side * wave], () => {
      mesh.box([[x, 0.051, 0], [0.062, 0.133, 0.096]], COLORS.gold);
      mesh.box([[x, 0.07, 0.087 + reach * 0.054], [0.039, 0.041, 0.108 + reach * 0.11]], COLORS.steel);
      mesh.box([[x, 0.082, 0.149 + reach * 0.106], [0.086, 0.05, 0.045]], COLORS.rim);
      for (const offset of [-0.029, 0, 0.029]) {
        mesh.box([[x + offset, 0.101, 0.175 + reach * 0.106], [0.019, 0.044, 0.045]], COLORS.silver);
      }
    });
  }
}

export function buildWalle(mesh: CharacterMesh, pose: CharacterPose) {
  drawTracks(mesh, pose);
  mesh.box([[0, 0.121, 0], [0.42, 0.312, 0.349]], COLORS.gold);
  mesh.box([[0, -0.038, 0], [0.436, 0.037, 0.362]], COLORS.steel);
  mesh.box([[0, 0.264, 0], [0.418, 0.035, 0.352]], COLORS.rust);

  const front = 0.183;
  mesh.decal([0, 0.11, 0.196], () => {
    frontPanel(mesh, [[0, 0.126, front], [0.402, 0.258, 0]], COLORS.rust);
    frontPanel(mesh, [[0, 0.165, front + 0.001], [0.373, 0.171, 0]], COLORS.door);
    frontPanel(mesh, [[0, 0.088, front + 0.002], [0.347, 0.012, 0]], COLORS.highlight);
    frontPanel(mesh, [[0, 0.027, front + 0.001], [0.381, 0.075, 0]], COLORS.recess);
    frontPanel(mesh, [[-0.123, 0.028, front + 0.003], [0.076, 0.042, 0]], COLORS.steel);
    frontPanel(mesh, [[0.099, 0.028, front + 0.003], [0.065, 0.043, 0]], COLORS.glass);
    const charge = Math.max(pose.done, pose.signal, pose.read * 0.55);
    for (const [index, x] of [0.079, 0.092, 0.105, 0.118].entries()) {
      const height = 0.015 + index * 0.005;
      const color = mix(COLORS.bronze, COLORS.highlight, index === 0 ? 0.8 : charge);
      frontPanel(mesh, [[x, 0.046 - height / 2, front + 0.004], [0.008, height, 0]], color);
    }
    frontPanel(mesh, [[0, 0.111, front + 0.003], [0.057, 0.018, 0]], COLORS.rim);
    frontPanel(mesh, [[-0.034, 0.214, front + 0.002], [0.107, 0.022, 0]], COLORS.rust);
    frontOval(mesh, [0.034, 0.214, front + 0.003], 0.014, 0.013, COLORS.red);
    for (const [x, y, width, height] of [[-0.143, 0.13, 0.008, 0.051], [-0.131, 0.169, 0.021, 0.007], [0.142, 0.212, 0.027, 0.009]]) {
      frontPanel(mesh, [[x, y, front + 0.002], [width, height, 0]], COLORS.bronze);
    }
  });

  drawArms(mesh, pose);
  drawHead(mesh, pose);
}
