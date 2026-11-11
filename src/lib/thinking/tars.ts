import type { CharacterMesh, Point3, Solid } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { frontOval, frontPanel } from "./cinemaGeometry";
import { mix, type Rgb } from "./palette";

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const HALF = 0.5;
const METAL: Rgb = [169, 174, 177];
const EDGE: Rgb = [224, 228, 229];
const GROOVE: Rgb = [87, 94, 99];
const GLASS: Rgb = [12, 19, 22];
const DISPLAY: Rgb = [65, 185, 119];
const TELEMETRY: Rgb = [65, 150, 179];
const LETTERING: Rgb = [181, 102, 55];
const ERROR: Rgb = [236, 107, 79];
const HEIGHT = 0.82;
const DEPTH = 0.14;
const COLUMN_WIDTH = 0.105;
const COLUMN_SPACING = 0.111;
const FRONT = DEPTH * HALF;
const DETAIL_Z = FRONT + 0.001;
const DECAL_Z = FRONT + 0.002;
const STRIPE_WIDTH = 0.0015;
const PANEL_INSET = 0.005;
const PANEL_HEIGHT = HEIGHT - PANEL_INSET * TWO;
const VERTICAL_GROOVES = [-0.026, ZERO, 0.026] as const;
const HORIZONTAL_GROOVES = [-0.32, -0.23, -0.14, ZERO, 0.14, 0.23, 0.32] as const;
const SIDE_NORMAL: Point3 = [ONE, ZERO, ZERO];
const TOP_NORMAL: Point3 = [ZERO, -ONE, ZERO];
const TOP_GRID_DEPTHS = [-0.035, ZERO, 0.035] as const;
const DISPLAY_Y = -0.205;
const DISPLAY_WIDTH = COLUMN_WIDTH - PANEL_INSET;
const DISPLAY_HEIGHT = 0.125;
const LOWER_BAND_Y = 0.227;
const LOWER_BAND_HEIGHT = 0.103;
const SCREEN_MARGIN = 0.012;
const SCREEN_LINE_WIDTHS = [0.052, 0.034, 0.059, 0.043, 0.027] as const;
const SCREEN_LINE_START_Y = -0.248;
const SCREEN_LINE_SPACING = 0.019;
const SCREEN_LINE_HEIGHT = 0.0035;
const SCREEN_ACTIVITY_MINIMUM = 0.65;
const SCREEN_ACTIVITY_RANGE = 0.35;
const SCREEN_RATE = 5;
const SCREEN_PHASE_OFFSET = 1.7;
const SCREEN_SIGNAL_GAIN = 0.15;
const SCREEN_WORK_DENSITY = 0.12;
const SCREEN_WRITE_DENSITY = 0.22;
const SCREEN_LISTEN_DENSITY = 0.15;
const SCREEN_SPEAK_DENSITY = 0.1;
const CONTROL_Y = -0.035;
const CONTROL_ROWS = [-0.075, -0.04, -0.005, 0.03, 0.065] as const;
const CONTROL_WIDTHS = [0.045, 0.026, 0.037, 0.022, 0.041] as const;
const CONTROL_HEIGHT = 0.004;
const CONTROL_PANEL_HEIGHT = 0.17;
const CONTROL_PANEL_WIDTH = 0.071;
const CONTROL_HIGHLIGHT_WIDTH = 0.001;
const HINGE_RADIUS = 0.012;
const HINGE_INNER_RADIUS = 0.006;
const HINGE_Y = 0.018;
const LETTER_X = -0.024;
const LETTER_Y = -0.117;
const LETTER_PIXEL_WIDTH = 0.004;
const LETTER_PIXEL_HEIGHT = 0.005;
const LETTER_ROW_SPACING = 0.006;
const LETTER_COLUMN_SPACING = 0.005;
const LETTER_ADVANCE = 0.036;
const EMPTY_PIXEL = "0";
const LETTERS = [
  ["111", "010", "010", "010", "010"],
  ["010", "101", "111", "101", "101"],
  ["110", "101", "110", "101", "101"],
  ["111", "100", "010", "001", "111"],
] as const;
const COLUMN_LAYOUT = [
  { slot: -1.5, side: -ONE, console: false, phase: ZERO },
  { slot: -HALF, side: -ONE, console: true, phase: Math.PI },
  { slot: HALF, side: ONE, console: true, phase: ZERO },
  { slot: 1.5, side: ONE, console: false, phase: Math.PI },
] as const;
const ROAM_RATE = 0.9;
const ROAM_DELAY = 1.2;
const ROAM_START = 0.64;
const ROAM_END = 0.96;
const UNFOLD_SECONDS = 0.7;
const WRITE_MOVEMENT = 0.7;
const GAIT_RATE = 3.1;
const WALK_PITCH = 0.24;
const FAN_PITCH = 0.85;
const CONSOLE_PITCH = 0.16;
const OUTER_FAN_ANGLE = 0.76;
const INNER_FAN_ANGLE = 0.18;
const FAN_STEP_ANGLE = 0.23;
const STANDING_SPREAD = 0.025;
const BODY_SWAY = 0.016;
const GAZE_TURN = 0.16;
const READING_PITCH = 0.055;
const FAILURE_PITCH = 0.045;
const STILL_ARTICULATION_THRESHOLD = 0.001;
const TARS_SCALE = 0.91;
const FAN_SCALE_REDUCTION = 0.18;
const ORIGIN: Point3 = [ZERO, ZERO, ZERO];

type ColumnMotion = { x: number; pitch: number; roll: number };

function smoothstep(from: number, to: number, value: number) {
  const progress = (value - from) / (to - from);
  const clamped = Math.max(ZERO, progress);
  const bounded = Math.min(ONE, clamped);
  return bounded * bounded * (THREE - TWO * bounded);
}

function panel(mesh: CharacterMesh, x: number, y: number, width: number, height: number, color: Rgb) {
  const solid: Solid = [[x, y, DETAIL_Z], [width, height, ZERO]];
  frontPanel(mesh, solid, color);
}

function metalColumn(mesh: CharacterMesh, x: number, y: number) {
  const solid: Solid = [[x, y, ZERO], [COLUMN_WIDTH, HEIGHT, DEPTH]];
  mesh.box(solid, METAL);
  const anchor: Point3 = [x, y, DECAL_Z];
  mesh.decal(anchor, () => {
    for (const offset of VERTICAL_GROOVES) {
      const grooveX = x + offset;
      panel(mesh, grooveX, y, STRIPE_WIDTH, PANEL_HEIGHT, GROOVE);
    }
    for (const offset of HORIZONTAL_GROOVES) {
      panel(mesh, x, y + offset, COLUMN_WIDTH, STRIPE_WIDTH, GROOVE);
    }
    const edgeX = x - COLUMN_WIDTH * HALF + PANEL_INSET;
    panel(mesh, edgeX, y, STRIPE_WIDTH, PANEL_HEIGHT, EDGE);
  });
  const right = x + COLUMN_WIDTH * HALF;
  const top = y - HEIGHT * HALF;
  const bottom = y + HEIGHT * HALF;
  for (const offset of VERTICAL_GROOVES) {
    const grooveX = x + offset;
    const topLine: Point3[] = [
      [grooveX, top, -FRONT], [grooveX + STRIPE_WIDTH, top, -FRONT],
      [grooveX + STRIPE_WIDTH, top, FRONT], [grooveX, top, FRONT],
    ];
    mesh.polygon(topLine, GROOVE, TOP_NORMAL);
  }
  for (const depth of TOP_GRID_DEPTHS) {
    const sideLine: Point3[] = [
      [right, top, depth], [right, bottom, depth],
      [right, bottom, depth + STRIPE_WIDTH], [right, top, depth + STRIPE_WIDTH],
    ];
    mesh.polygon(sideLine, GROOVE, SIDE_NORMAL);
    const topLine: Point3[] = [
      [x - COLUMN_WIDTH * HALF, top, depth], [right, top, depth],
      [right, top, depth + STRIPE_WIDTH], [x - COLUMN_WIDTH * HALF, top, depth + STRIPE_WIDTH],
    ];
    mesh.polygon(topLine, GROOVE, TOP_NORMAL);
  }
  for (const offset of HORIZONTAL_GROOVES) {
    const sideLine: Point3[] = [
      [right, y + offset, -FRONT], [right, y + offset + STRIPE_WIDTH, -FRONT],
      [right, y + offset + STRIPE_WIDTH, FRONT], [right, y + offset, FRONT],
    ];
    mesh.polygon(sideLine, GROOVE, SIDE_NORMAL);
  }
}

function consolePanel(mesh: CharacterMesh, x: number, y: number, side: number, pose: CharacterPose) {
  const anchor: Point3 = [x, y, DECAL_Z];
  mesh.decal(anchor, () => {
    panel(mesh, x, y + DISPLAY_Y, DISPLAY_WIDTH, DISPLAY_HEIGHT, GLASS);
    panel(mesh, x, y + LOWER_BAND_Y, DISPLAY_WIDTH, LOWER_BAND_HEIGHT, GLASS);
    const signal = (pose.speak + pose.listen) * pose.signal;
    const activity = Math.max(pose.work, pose.write, pose.read, pose.done, signal);
    const color = mix(DISPLAY, ERROR, pose.failed);
    const telemetryColor = mix(TELEMETRY, ERROR, pose.failed);
    const phaseDensity = ONE - pose.work * SCREEN_WORK_DENSITY - pose.write * SCREEN_WRITE_DENSITY;
    const voiceDensity = pose.listen * SCREEN_LISTEN_DENSITY - pose.speak * SCREEN_SPEAK_DENSITY;
    const density = phaseDensity + voiceDensity;
    const lines = SCREEN_LINE_WIDTHS.entries();
    for (const [index, width] of lines) {
      const wave = Math.sin(pose.time * SCREEN_RATE + index * SCREEN_PHASE_OFFSET);
      const pulse = SCREEN_ACTIVITY_MINIMUM + activity * SCREEN_ACTIVITY_RANGE * wave;
      const lineWidth = width * (pulse + signal * SCREEN_SIGNAL_GAIN) * density;
      const lineX = x - COLUMN_WIDTH * HALF + SCREEN_MARGIN + lineWidth * HALF;
      const lineY = y + SCREEN_LINE_START_Y + index * SCREEN_LINE_SPACING;
      const lineColor = side < ZERO ? color : telemetryColor;
      panel(mesh, lineX, lineY, lineWidth, SCREEN_LINE_HEIGHT, lineColor);
    }
    const hinge: Point3 = [x + side * (COLUMN_WIDTH * HALF - PANEL_INSET), y + HINGE_Y, DETAIL_Z];
    frontOval(mesh, hinge, HINGE_RADIUS, HINGE_RADIUS, GROOVE);
    frontOval(mesh, hinge, HINGE_INNER_RADIUS, HINGE_INNER_RADIUS, EDGE);
    if (side > ZERO) {
      panel(mesh, x, y + CONTROL_Y, CONTROL_PANEL_WIDTH, CONTROL_PANEL_HEIGHT, GROOVE);
      const insetWidth = CONTROL_PANEL_WIDTH - PANEL_INSET;
      const insetHeight = CONTROL_PANEL_HEIGHT - PANEL_INSET;
      panel(mesh, x, y + CONTROL_Y, insetWidth, insetHeight, METAL);
      const controls = CONTROL_ROWS.entries();
      for (const [index, controlY] of controls) {
        const width = CONTROL_WIDTHS[index];
        panel(mesh, x, y + controlY, width, CONTROL_HEIGHT, GROOVE);
        const highlightY = y + controlY + CONTROL_HEIGHT;
        panel(mesh, x, highlightY, width, CONTROL_HIGHLIGHT_WIDTH, EDGE);
      }
      return;
    }
    const letters = LETTERS.entries();
    for (const [letter, rows] of letters) {
      const indexedRows = rows.entries();
      for (const [row, cells] of indexedRows) {
        const pixels = [...cells];
        const indexedPixels = pixels.entries();
        for (const [column, cell] of indexedPixels) {
          if (cell === EMPTY_PIXEL) continue;
          const pixelX = x + LETTER_X + column * LETTER_COLUMN_SPACING;
          const pixelY = y + LETTER_Y + letter * LETTER_ADVANCE + row * LETTER_ROW_SPACING;
          panel(mesh, pixelX, pixelY, LETTER_PIXEL_WIDTH, LETTER_PIXEL_HEIGHT, LETTERING);
        }
      }
    }
  });
}

export function tarsArticulation(pose: CharacterPose): number {
  const resting = Math.max(pose.quiet, pose.done, pose.failed);
  const awake = ONE - resting;
  const roamWave = Math.sin(pose.time * ROAM_RATE - ROAM_DELAY);
  const roamProgress = (ONE + roamWave) * HALF;
  const roam = smoothstep(ROAM_START, ROAM_END, roamProgress);
  const attention = Math.max(pose.read, pose.listen, pose.speak);
  const movement = Math.max(pose.work, pose.write * WRITE_MOVEMENT, roam * (ONE - attention));
  const unfolding = smoothstep(ZERO, UNFOLD_SECONDS, pose.time);
  return awake * movement * unfolding;
}

export function tarsModelScale(pose: CharacterPose): number {
  const articulation = tarsArticulation(pose);
  return TARS_SCALE * (ONE - articulation * FAN_SCALE_REDUCTION);
}

function columnReach(pitch: number, roll: number) {
  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);
  const rollCos = Math.cos(roll);
  const rollSin = Math.sin(roll);
  const heightReach = HEIGHT * HALF * pitchCos * rollCos;
  const depthReach = Math.abs(pitchSin * rollCos) * DEPTH * HALF;
  const widthReach = Math.abs(rollSin) * COLUMN_WIDTH * HALF;
  return heightReach + depthReach + widthReach;
}

export function buildTars(mesh: CharacterMesh, pose: CharacterPose) {
  const resting = Math.max(pose.quiet, pose.done, pose.failed);
  const awake = ONE - resting;
  const articulation = tarsArticulation(pose);
  const still = pose.time <= STILL_ARTICULATION_THRESHOLD;
  const gait = pose.time * GAIT_RATE;
  const swayWave = Math.sin(gait);
  const sway = still ? ZERO : swayWave * BODY_SWAY * awake;
  const bodyPitch = pose.read * READING_PITCH + pose.failed * FAILURE_PITCH;
  const yaw = pose.gazeX * awake * GAZE_TURN;
  const columns: ColumnMotion[] = [];
  let maximumReach = ZERO;
  for (const column of COLUMN_LAYOUT) {
    const wave = Math.sin(gait + column.phase);
    const pitchRange = column.console ? CONSOLE_PITCH : FAN_PITCH;
    const walking = still ? ZERO : wave * WALK_PITCH * awake * (ONE - articulation);
    const pitch = walking + wave * pitchRange * articulation + bodyPitch;
    const spread = column.console ? INNER_FAN_ANGLE : OUTER_FAN_ANGLE;
    const roll = -column.side * (STANDING_SPREAD * awake + articulation * (spread + wave * FAN_STEP_ANGLE)) + sway;
    const reach = columnReach(pitch, roll);
    maximumReach = Math.max(maximumReach, reach);
    columns.push({ x: column.slot * COLUMN_SPACING, pitch, roll });
  }
  const drop = HEIGHT * HALF - maximumReach;
  const rootAngles: Point3 = [ZERO, yaw, ZERO];
  mesh.group(ORIGIN, rootAngles, () => {
    const entries = columns.entries();
    for (const [index, column] of entries) {
      const layout = COLUMN_LAYOUT[index];
      const pivot: Point3 = [column.x, drop, ZERO];
      const angles: Point3 = [column.pitch, ZERO, column.roll];
      mesh.group(pivot, angles, () => {
        metalColumn(mesh, column.x, drop);
        if (layout.console) consolePanel(mesh, column.x, drop, layout.side, pose);
      });
    }
  });
}
