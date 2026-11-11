import type { CharacterMesh, Point3 } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { extrudeProfile, frontOval, frontPanel, type ProfilePoint } from "./cinemaGeometry";
import { mix, type Rgb } from "./palette";

const COLORS = {
  white: [244, 242, 229], silver: [190, 204, 211], steel: [128, 146, 156],
  seam: [88, 110, 122], blue: [39, 85, 183], navy: [20, 45, 100],
  dark: [16, 26, 38], glint: [163, 217, 245], red: [248, 69, 58], copper: [172, 108, 61],
} satisfies Record<string, Rgb>;
const RADIUS = 0.207;
const DOME_BASE: Point3 = [0, -0.157, 0];
const DOME_HEIGHT = 0.217;
const FOOT: readonly ProfilePoint[] = [
  [-0.076, -0.047], [0.016, -0.047], [0.111, 0.025], [0.111, 0.044], [-0.099, 0.044], [-0.099, 0.019],
];
const STRUT: readonly ProfilePoint[] = [
  [-0.051, -0.159], [0.036, -0.159], [0.061, -0.11], [0.041, 0.133], [0.053, 0.174],
  [-0.058, 0.174], [-0.041, 0.131], [-0.056, -0.108],
];

function domeMaterial([x, y, z]: Point3): Rgb {
  const latitude = Math.acos(-y);
  const longitude = Math.atan2(x, z) + Math.PI;
  const crownSector = longitude % (Math.PI / 3);
  const skirtSector = longitude % (Math.PI / 5);
  const crown = latitude < 0.25 || (latitude < 0.91 && crownSector > 0.15 && crownSector < 0.77);
  const skirt = latitude > 1.24 && skirtSector > 0.08 && skirtSector < 0.53;
  return crown || skirt ? COLORS.blue : COLORS.silver;
}

function drawDome(mesh: CharacterMesh, pose: CharacterPose) {
  const scan = Math.sin(pose.time * 2.8);
  const resting = Math.max(pose.quiet, pose.done, pose.failed);
  const chirp = Math.sin(pose.time * 15) * pose.speak * pose.signal * 0.19;
  const yaw = pose.gazeX * 0.51 + scan * (0.09 * (1 - resting) + pose.read * 0.32)
    + chirp + pose.listen * 0.13 - pose.done * scan * 0.33 - pose.failed * 0.27;
  mesh.group(DOME_BASE, [0, yaw, 0], () => {
    mesh.ellipsoid([DOME_BASE, [RADIUS + 0.007, DOME_HEIGHT, RADIUS + 0.007]], COLORS.silver, true, domeMaterial);
    mesh.cylinder([[0, -0.154, 0], [0.216, 0.024, 0.216]], COLORS.navy);
    mesh.cylinder([[0, -0.169, 0], [0.217, 0.009, 0.217]], COLORS.silver);

    // The single dark radar eye sits high on the dome. The small holoprojector sits to its right.
    const radar: Point3 = [-0.047, -0.269, 0.174];
    mesh.group(radar, [-0.31, -0.16, 0], () => {
      mesh.box([radar, [0.1, 0.081, 0.026]], COLORS.blue);
      frontOval(mesh, [-0.047, -0.27, 0.189], 0.037, 0.036, COLORS.steel);
      frontOval(mesh, [-0.047, -0.27, 0.19], 0.031, 0.03, COLORS.dark);
      frontOval(mesh, [-0.057, -0.281, 0.191], 0.01, 0.007, COLORS.glint);
    });

    const projector: Point3 = [0.125, -0.202, 0.178];
    mesh.group(projector, [-0.16, 0.55, 0], () => {
      mesh.ellipsoid([projector, [0.027, 0.027, 0.021]], COLORS.steel);
      frontOval(mesh, [0.125, -0.202, 0.2], 0.019, 0.019, COLORS.silver);
      frontOval(mesh, [0.125, -0.202, 0.201], 0.012, 0.012, COLORS.dark);
    });

    const pulse = pose.signal * 0.43 + pose.write * 0.25 + (1 + Math.sin(pose.time * 8)) * 0.17;
    const lamp = mix(COLORS.navy, pose.read ? COLORS.glint : COLORS.red, pose.quiet ? 0.2 : 0.51 + pulse);
    frontOval(mesh, [0.018, -0.209, 0.211], 0.024, 0.024, COLORS.dark);
    frontOval(mesh, [0.018, -0.209, 0.212], 0.017 + pose.listen * pose.signal * 0.004, 0.017, lamp);
    for (const y of [-0.218, -0.207, -0.196]) {
      frontPanel(mesh, [[-0.085, y, 0.196], [0.027, 0.004, 0]], COLORS.glint);
    }
  });
}

// Paint raised panels along the curve of the cylinder so their edges stay on the shell as it turns.
function shellPanel(mesh: CharacterMesh, from: number, to: number, top: number, bottom: number, color: Rgb, depth = 0.004) {
  const radius = RADIUS + depth;
  const steps = Math.ceil((to - from) * 13);
  const upper: Point3[] = [];
  const lower: Point3[] = [];
  for (let i = 0; i <= steps; i++) {
    const angle = from + (to - from) * i / steps;
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    upper.push([x, top, z]);
    lower.push([x, bottom, z]);
  }
  const center = (from + to) / 2;
  mesh.polygon([...upper, ...lower.reverse()], color, [Math.sin(center), 0, Math.cos(center)]);
}

function drawShell(mesh: CharacterMesh, pose: CharacterPose) {
  mesh.cylinder([[0, 0.06, 0], [RADIUS, 0.43, RADIUS]], COLORS.white);
  mesh.cylinder([[0, 0.266, 0], [0.209, 0.021, 0.209]], COLORS.steel);
  mesh.decal([0, 0.06, RADIUS + 0.025], () => {
    for (const [y, width] of [[-0.117, 0.75], [-0.066, 0.64]]) {
      shellPanel(mesh, -width, width, y, y + 0.028, COLORS.blue);
      for (const side of [-1, 1]) {
        shellPanel(mesh, side * width - 0.055, side * width + 0.055, y - 0.008, y + 0.032, COLORS.blue);
      }
    }
    for (const side of [-1, 1]) {
      shellPanel(mesh, side * 0.66 - 0.21, side * 0.66 + 0.21, -0.012, 0.231, COLORS.seam);
      shellPanel(mesh, side * 0.66 - 0.184, side * 0.66 + 0.184, -0.004, 0.218, COLORS.white, 0.006);
    }
    shellPanel(mesh, -0.222, 0.222, -0.023, 0.156, COLORS.navy);
    for (const y of [0.018, 0.102]) {
      frontOval(mesh, [0, y, 0.215], 0.037, 0.034, COLORS.steel);
      frontOval(mesh, [0, y, 0.216], 0.028, 0.025, COLORS.dark);
      for (const offset of [-0.009, 0.003, 0.015]) {
        frontPanel(mesh, [[0, y + offset, 0.217], [0.042, 0.004, 0]], COLORS.steel);
      }
    }
    shellPanel(mesh, -0.255, 0.255, 0.173, 0.236, COLORS.blue);
    frontOval(mesh, [0, 0.205, 0.216], 0.023, 0.021, COLORS.silver);
    shellPanel(mesh, -0.83, -0.56, 0.137, 0.21, COLORS.blue, 0.008);
  });

  if (pose.write > 0) {
    const extension = pose.write * (0.045 + 0.025 * Math.sin(pose.time * 7));
    mesh.box([[0.088, 0.036, 0.194 + extension / 2], [0.022, 0.025, 0.054 + extension]], COLORS.steel);
    mesh.box([[0.088, 0.036, 0.222 + extension], [0.031, 0.028, 0.017]], COLORS.copper);
  }
}

function drawFoot(mesh: CharacterMesh, center: Point3, width: number) {
  const [x, y, z] = center;
  mesh.group(center, [0, -Math.PI / 2, 0], () => extrudeProfile(mesh, FOOT, center, width, COLORS.white));
  mesh.box([[x, y + 0.047, z + 0.006], [width + 0.006, 0.013, 0.211]], COLORS.seam);
  frontPanel(mesh, [[x, y + 0.033, z + 0.112], [width * 0.66, 0.012, 0]], COLORS.blue);
}

export function buildR2d2(mesh: CharacterMesh, pose: CharacterPose) {
  const pitch = 0.10 + pose.work * 0.12;
  const rock = Math.sin(pose.time * 5) * (pose.speak * pose.signal * 0.024 + pose.done * 0.055);
  mesh.group([0, 0.26, 0], [pitch, 0, rock], () => {
    drawShell(mesh, pose);
    drawDome(mesh, pose);
  });

  for (const x of [-0.252, 0.252]) {
    const shoulder: Point3 = [x, -0.058, -0.043];
    mesh.group(shoulder, [0, 0, Math.PI / 2], () => {
      mesh.cylinder([shoulder, [0.074, 0.094, 0.073]], COLORS.white);
      mesh.cylinder([shoulder, [0.054, 0.101, 0.054]], COLORS.steel);
      mesh.cylinder([shoulder, [0.039, 0.105, 0.039]], COLORS.white);
    });
    extrudeProfile(mesh, STRUT, [x, 0.141, -0.009], 0.114, COLORS.white);
    frontPanel(mesh, [[x, 0.11, 0.049], [0.047, 0.214, 0]], COLORS.blue);
    frontPanel(mesh, [[x, 0.11, 0.05], [0.013, 0.164, 0]], COLORS.steel);
    mesh.box([[x, 0.294, 0.005], [0.102, 0.061, 0.103]], COLORS.steel);
    for (const offset of [-0.028, 0.028]) {
      mesh.box([[x + offset, 0.31, 0.062], [0.009, 0.055, 0.012]], COLORS.copper);
    }
    drawFoot(mesh, [x, 0.36, 0.015], 0.151);
  }
  const stem: Point3 = [0, 0.307, 0.142];
  mesh.group(stem, [0.48, 0, 0], () => mesh.box([stem, [0.073, 0.16, 0.079]], COLORS.steel));
  drawFoot(mesh, [0, 0.36, 0.185], 0.122);
}
