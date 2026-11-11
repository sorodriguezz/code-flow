import type { CharacterMesh } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { frontPanel } from "./cinemaGeometry";
import { mix, type Rgb } from "./palette";

const METAL: Rgb = [143, 152, 153];
const EDGE: Rgb = [218, 225, 221];
const GROOVE: Rgb = [57, 69, 71];
const GLASS: Rgb = [15, 25, 28];
const DISPLAY: Rgb = [112, 222, 190];
const ERROR: Rgb = [236, 107, 79];

const HEIGHT = 0.82;
const DEPTH = 0.15;
const COLUMN_WIDTH = 0.102;
const COLUMN_SPACING = 0.116;
const FRONT = DEPTH / 2;
const LETTERS = [
  ["111", "010", "010", "010", "010"],
  ["010", "101", "111", "101", "101"],
  ["110", "101", "110", "101", "101"],
  ["111", "100", "010", "001", "111"],
];

function smoothstep(from: number, to: number, value: number) {
  const progress = Math.max(0, Math.min(1, (value - from) / (to - from)));
  return progress * progress * (3 - 2 * progress);
}

function metalSegment(mesh: CharacterMesh, x: number, y: number, height: number) {
  mesh.box([[x, y, 0], [COLUMN_WIDTH, height, DEPTH]], METAL);
  mesh.decal([x, y, FRONT + 0.002], () => {
    frontPanel(mesh, [[x - COLUMN_WIDTH / 2 + 0.009, y, FRONT + 0.001], [0.008, height - 0.018, 0]], EDGE);
    frontPanel(mesh, [[x + COLUMN_WIDTH / 2 - 0.008, y, FRONT + 0.001], [0.006, height - 0.018, 0]], GROOVE);
    for (const edge of [-1, 1]) {
      frontPanel(mesh, [[x, y + edge * (height / 2 - 0.014), FRONT + 0.001], [COLUMN_WIDTH - 0.018, 0.007, 0]], GROOVE);
    }
  });
}

function consolePanel(mesh: CharacterMesh, x: number, drop: number, side: number, pose: CharacterPose) {
  mesh.decal([x, drop - 0.218, FRONT + 0.012], () => {
    frontPanel(mesh, [[x, drop - 0.218, FRONT + 0.002], [0.086, 0.112, 0]], GROOVE);
    frontPanel(mesh, [[x, drop - 0.218, FRONT + 0.003], [0.073, 0.094, 0]], GLASS);
    const signal = (pose.speak + pose.listen) * pose.signal;
    const activity = Math.max(signal, pose.write, pose.read, pose.done);
    const color = mix(DISPLAY, ERROR, pose.failed);
    if (side > 0) {
      const cursorY = drop - 0.2 + pose.gazeY * 0.018 + Math.sin(pose.time * 2) * pose.read * 0.018;
      frontPanel(mesh, [[x + pose.gazeX * 0.02, cursorY, FRONT + 0.004], [0.014 + pose.done * 0.02, 0.006, 0]], color);
      for (let index = 0; index < 3; index++) {
        const height = 0.008 + activity * (0.018 + 0.014 * Math.sin(pose.time * 12 + index * 1.9));
        frontPanel(mesh, [[x - 0.024 + index * 0.024, drop - 0.19 - height / 2, FRONT + 0.004], [0.012, height, 0]], color);
      }
    } else {
      for (const [index, width] of [0.055, 0.036, 0.047].entries()) {
        frontPanel(mesh, [[x - 0.028 + width / 2, drop - 0.241 + index * 0.02, FRONT + 0.004], [width, 0.006, 0]], color);
      }
    }
    for (const [letter, rows] of LETTERS.entries()) {
      for (const [row, cells] of rows.entries()) {
        for (const [column, cell] of [...cells].entries()) {
          if (cell === "0") continue;
          frontPanel(mesh, [[x - 0.007 + column * 0.007, drop - 0.14 + letter * 0.031 + row * 0.005, FRONT + 0.003], [0.005, 0.004, 0]], GROOVE);
        }
      }
    }
  });
}

export function tarsCrawl(pose: CharacterPose): number {
  const awake = 1 - Math.max(pose.quiet, pose.done, pose.failed);
  // The rail has no activity phase. Its own loop still unfolds into the four-footed gait;
  // an active tool/run holds that gait, while reading and conversation stay upright.
  const roam = smoothstep(0.3, 0.8, (1 + Math.sin(pose.time * 1.25 - 0.9)) / 2);
  const attention = Math.max(pose.read, pose.listen, pose.speak);
  return awake * Math.max(pose.work, pose.write * 0.85, roam * (1 - attention));
}

export function buildTars(mesh: CharacterMesh, pose: CharacterPose) {
  const awake = 1 - Math.max(pose.quiet, pose.done, pose.failed);
  const crawl = tarsCrawl(pose);
  const gait = pose.time * 6.8;
  const stride = Math.sin(gait) * awake;
  const drop = crawl * 0.115 - Math.abs(stride) * (0.012 + crawl * 0.01) + pose.failed * 0.02;
  const lean = pose.gazeX * awake * 0.025 + pose.failed * 0.055;

  const bodyPitch = crawl * 1.35;
  mesh.group([0, drop, 0], [bodyPitch + pose.read * 0.045, pose.gazeX * awake * 0.12, lean], () => {
    for (const side of [-1, 1]) {
      // Two central columns remain the recognisable console. Their lower halves become the
      // front/back feet; the outside columns unfold at the shoulder and knee into outriggers.
      const x = side * COLUMN_SPACING / 2;
      metalSegment(mesh, x, drop - HEIGHT / 4, HEIGHT / 2 - 0.009);
      consolePanel(mesh, x, drop, side, pose);
      const step = Math.sin(gait + side * Math.PI / 2) * awake;
      mesh.group([x, drop, 0], [crawl * (side * 0.8 + step * 0.3) - bodyPitch, 0, -side * crawl * (0.28 + step * 0.1)], () => {
        metalSegment(mesh, x, drop + HEIGHT / 4, HEIGHT / 2 - 0.009);
        mesh.decal([x, drop + 0.235, FRONT + 0.006], () => {
          frontPanel(mesh, [[x, drop + 0.235, FRONT + 0.002], [0.071, 0.048, 0]], GROOVE);
          frontPanel(mesh, [[x, drop + 0.235, FRONT + 0.003], [0.059, 0.031, 0]], GLASS);
        });
      });

      const outerX = side * COLUMN_SPACING * 1.5;
      const pitch = side * stride * (0.5 - crawl * 0.2) + side * crawl * 0.32;
      const spread = crawl * (0.92 + side * stride * 0.08);
      mesh.group([outerX, drop - 0.23, 0], [pitch, 0, -side * spread], () => {
        metalSegment(mesh, outerX, drop - HEIGHT / 4, HEIGHT / 2 - 0.009);
        mesh.group([outerX, drop, 0], [-crawl * pitch * 0.6 - bodyPitch, 0, side * crawl * 0.8], () => {
          metalSegment(mesh, outerX, drop + HEIGHT / 4, HEIGHT / 2 - 0.009);
        });
      });
    }
  });
}
