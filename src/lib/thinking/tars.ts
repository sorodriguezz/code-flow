import type { CharacterMesh } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { frontPanel } from "./cinemaGeometry";
import { mix, type Rgb } from "./palette";

const METAL: Rgb = [175, 178, 173];
const EDGE: Rgb = [221, 223, 216];
const GROOVE: Rgb = [125, 130, 128];
const GLASS: Rgb = [19, 24, 25];
const DISPLAY: Rgb = [112, 182, 156];
const ERROR: Rgb = [236, 107, 79];

const HEIGHT = 0.82;
const DEPTH = 0.174;
const BODY_WIDTH = 0.254;
const LEG_WIDTH = 0.116;
const LEG_X = 0.196;
const FRONT = DEPTH / 2;
const LETTERS = [
  ["111", "010", "010", "010", "010"],
  ["010", "101", "111", "101", "101"],
  ["110", "101", "110", "101", "101"],
  ["111", "100", "010", "001", "111"],
];

function metalSlab(mesh: CharacterMesh, x: number, width: number) {
  mesh.box([[x, 0, 0], [width, HEIGHT, DEPTH]], METAL);
  // Brushed metal edges and recessed joints on the continuous front of each slab.
  mesh.decal([x, 0, FRONT + 0.002], () => {
    frontPanel(mesh, [[x - width / 2 + 0.012, 0, FRONT + 0.001], [0.009, HEIGHT - 0.018, 0]], EDGE);
    frontPanel(mesh, [[x + width / 2 - 0.011, 0, FRONT + 0.001], [0.008, HEIGHT - 0.018, 0]], GROOVE);
    for (const y of [-0.345, 0.333]) {
      frontPanel(mesh, [[x, y, FRONT + 0.001], [width - 0.012, 0.006, 0]], GROOVE);
    }
  });
}

export function buildTars(mesh: CharacterMesh, pose: CharacterPose) {
  metalSlab(mesh, 0, BODY_WIDTH);
  mesh.decal([0, -0.218, FRONT + 0.017], () => {
    for (const x of [-0.061, 0.061]) {
      frontPanel(mesh, [[x, -0.218, FRONT + 0.002], [0.104, 0.108, 0]], GROOVE);
      frontPanel(mesh, [[x, -0.218, FRONT + 0.003], [0.092, 0.088, 0]], GLASS);
    }

    const signal = (pose.speak + pose.listen) * pose.signal;
    const activity = Math.max(signal, pose.write, pose.read, pose.done);
    const color = mix(DISPLAY, ERROR, pose.failed);
    const cursorY = -0.2 + pose.gazeY * 0.021 + Math.sin(pose.time * 2) * pose.read * 0.018;
    frontPanel(mesh, [[0.061 + pose.gazeX * 0.027, cursorY, FRONT + 0.004], [0.012 + pose.done * 0.025, 0.004, 0]], color);
    for (const [index, width] of [0.055, 0.036, 0.047].entries()) {
      frontPanel(mesh, [[-0.092 + width / 2, -0.241 + index * 0.016, FRONT + 0.004], [width, 0.004, 0]], color);
      const height = 0.008 + activity * (0.018 + 0.014 * Math.sin(pose.time * 12 + index * 1.9)) + pose.write * index * 0.006;
      frontPanel(mesh, [[0.036 + index * 0.024, -0.19 - height / 2, FRONT + 0.004], [0.011, height, 0]], color);
    }
  });

  mesh.decal([0, 0.035, FRONT + 0.012], () => {
    for (const [letter, rows] of LETTERS.entries()) {
      for (const [row, cells] of rows.entries()) {
        for (const [column, cell] of [...cells].entries()) {
          if (cell === "0") continue;
          frontPanel(mesh, [[-0.075 + column * 0.007, -0.127 + letter * 0.045 + row * 0.007, FRONT + 0.003], [0.006, 0.006, 0]], GROOVE);
        }
      }
    }
    for (const x of [-0.062, 0.062]) {
      frontPanel(mesh, [[x, 0.234, FRONT + 0.003], [0.084, 0.052, 0]], GROOVE);
      frontPanel(mesh, [[x, 0.234, FRONT + 0.004], [0.075, 0.038, 0]], GLASS);
    }
  });

  const idle = 0.08 * (1 - Math.max(pose.quiet, pose.done, pose.failed));
  const stride = Math.sin(pose.time * 3.6) * (idle + pose.work * 0.42 + pose.write * 0.15);
  for (const side of [-1, 1]) {
    const x = side * LEG_X;
    mesh.group([x, -0.06, 0], [side * stride, 0, 0], () => metalSlab(mesh, x, LEG_WIDTH));
  }
}
