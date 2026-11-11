import { CharacterMesh, type Point3, type Solid } from "./characterMesh";
import type { CharacterPose } from "./cinemaCharacters";
import { frontOval, frontPanel } from "./cinemaGeometry";
import type { Rgb } from "./palette";

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const FIVE = 5;
const HALF = 0.5;
const X = 0;
const Y = 1;
const Z = 2;
const SIDES = [-ONE, ONE] as const;
const FULL_TURN = Math.PI * TWO;
const SHELL: Rgb = [252, 251, 249];
const LIMBS: Rgb = [241, 242, 242];
const SEAM: Rgb = [214, 219, 222];
const EYES: Rgb = [19, 23, 28];
const BODY_SEGMENTS = 24;
const BODY_CONTROL_POINTS: readonly Point3[] = [
  [-0.274, 0.025, 0.025], [-0.258, 0.108, 0.083],
  [-0.22, 0.157, 0.119], [-0.15, 0.192, 0.155],
  [-0.06, 0.224, 0.186], [0.04, 0.249, 0.21],
  [0.13, 0.255, 0.217], [0.21, 0.227, 0.194],
  [0.267, 0.175, 0.153], [0.298, 0.095, 0.088],
  [0.305, 0.001, 0.001],
];
const PROFILE_SUBDIVISIONS = 2;
const MINIMUM_RADIUS = 0.001;
const FLOOR_Y = 0.45;
const DEFLATION_HEIGHT = 0.61;
const DEFLATION_WIDTH = 0.16;
const DEFLATION_DEPTH = 0.42;
const BREATH_RATE = 2.1;
const BREATH_SIZE = 0.013;
const SPEECH_BREATH = 0.024;
const HEAD_CENTER: Point3 = [0, -0.348, 0.016];
const HEAD_RADIUS: Point3 = [0.136, 0.084, 0.111];
const HEAD_YAW = 0.42;
const HEAD_PITCH = 0.28;
const HEAD_DROOP = 0.53;
const HEAD_READ_PITCH = 0.16;
const HEAD_LISTEN_ROLL = 0.14;
const HEAD_THINK_ROLL = 0.045;
const HEAD_THINK_RATE = 0.7;
const HEAD_ERROR_FORWARD = 0.12;
const EYE_X = 0.055;
const EYE_Y = -0.349;
const EYE_Z = 0.127;
const EYE_RADIUS = 0.015;
const EYE_HEIGHT = 0.019;
const EYE_LINE_HEIGHT = 0.004;
const EYE_LAYER = 0.001;
const BLINK_PERIOD = 4.8;
const BLINK_CENTER = 4.61;
const BLINK_DURATION = 0.095;
const BLINK_MINIMUM = 0.12;
const FAILED_EYES_THRESHOLD = 0.12;
const CROSS_HALF = 0.016;
const CROSS_STROKE = 0.004;
const FACE_ANCHOR: Point3 = [0, -0.348, 0.19];
const BADGE_CENTER: Point3 = [0.088, -0.141, 0.154];
const BADGE_RADIUS = 0.024;
const BADGE_INNER_RADIUS = 0.02;
const BADGE_LINE_HEIGHT = 0.002;
const BADGE_LINE_WIDTH = 0.025;
const BADGE_LINE_TILT = 0.004;
const ARM_PIVOT_X = 0.165;
const ARM_PIVOT_Y = -0.19;
const ARM_PIVOT_Z = 0;
const ARM_CENTER_X = 0.254;
const ARM_CENTER_Y = 0.035;
const ARM_RADIUS: Point3 = [0.087, 0.25, 0.095];
const ARM_SHOULDER_SLOPE = 0.36;
const HAND_X = 0.299;
const HAND_Y = 0.267;
const HAND_Z = 0.024;
const HAND_RADIUS: Point3 = [0.046, 0.059, 0.048];
const THUMB_X = 0.259;
const THUMB_Y = 0.255;
const THUMB_Z = 0.054;
const THUMB_RADIUS: Point3 = [0.022, 0.037, 0.024];
const FINGER_OFFSETS = [-0.024, 0, 0.024] as const;
const FINGER_Y = 0.303;
const FINGER_Z = 0.035;
const FINGER_RADIUS: Point3 = [0.013, 0.031, 0.019];
const ARM_REST_ROLL = 0.04;
const ARM_IDLE_RATE = 1.65;
const ARM_IDLE_SPREAD = 0.14;
const ARM_WORK_RATE = 5;
const ARM_WORK_SWING = 0.19;
const ARM_WORK_PITCH = 0.4;
const ARM_WRITE_RATE = 9;
const ARM_WRITE_PITCH = 0.6;
const ARM_WRITE_TAP = 0.12;
const ARM_READ_PITCH = 0.12;
const ARM_SPEAK_SPREAD = 0.18;
const ARM_LISTEN_LIFT = 2;
const ARM_GESTURE_SHORTENING = 0.3;
const ARM_WAVE_LIFT = 2.3;
const ARM_WAVE_RATE = 8;
const ARM_WAVE_SIZE = 0.17;
const ARM_ERROR_ROLL = 0.1;
const LEG_X = 0.108;
const LEG_Y = 0.321;
const LEG_Z = -0.005;
const LEG_RADIUS: Point3 = [0.099, 0.129, 0.111];
const LEG_PIVOT_Y = 0.23;
const LEG_WALK_RATE = 3.3;
const LEG_WALK_PITCH = 0.14;
const LEG_WALK_ROLL = 0.025;
const FOLD_LEVELS = [0.02, 0.1, 0.19] as const;
const FOLD_WIDTH = 0.22;
const FOLD_HEIGHT = 0.004;
const FOLD_DEPTH = 0.22;
const FOLD_THRESHOLD = 0.25;

function interpolateCoordinate(previous: number, current: number, next: number, following: number, progress: number): number {
  const squared = progress * progress;
  const cubed = squared * progress;
  const tangent = (next - previous) * progress;
  const curvature = (TWO * previous - FIVE * current + FOUR * next - following) * squared;
  const acceleration = (-previous + THREE * current - THREE * next + following) * cubed;
  return HALF * (TWO * current + tangent + curvature + acceleration);
}

function smoothBodyProfile(): readonly Point3[] {
  const profile: Point3[] = [];
  const finalIndex = BODY_CONTROL_POINTS.length - ONE;
  for (let index = ZERO; index < finalIndex; index += ONE) {
    const previousIndex = Math.max(ZERO, index - ONE);
    const followingIndex = Math.min(finalIndex, index + TWO);
    const previous = BODY_CONTROL_POINTS[previousIndex];
    const current = BODY_CONTROL_POINTS[index];
    const next = BODY_CONTROL_POINTS[index + ONE];
    const following = BODY_CONTROL_POINTS[followingIndex];
    for (let step = ZERO; step < PROFILE_SUBDIVISIONS; step += ONE) {
      const progress = step / PROFILE_SUBDIVISIONS;
      const y = interpolateCoordinate(previous[X], current[X], next[X], following[X], progress);
      const radiusX = interpolateCoordinate(previous[Y], current[Y], next[Y], following[Y], progress);
      const radiusZ = interpolateCoordinate(previous[Z], current[Z], next[Z], following[Z], progress);
      const clampedX = Math.max(MINIMUM_RADIUS, radiusX);
      const clampedZ = Math.max(MINIMUM_RADIUS, radiusZ);
      const point: Point3 = [y, clampedX, clampedZ];
      profile.push(point);
    }
  }
  profile.push(BODY_CONTROL_POINTS[finalIndex]);
  return profile;
}

const BODY_PROFILE = smoothBodyProfile();

interface Inflation {
  height: number;
  width: number;
  depth: number;
}

function inflatePoint(point: Point3, inflation: Inflation): Point3 {
  return [point[X] * inflation.width, FLOOR_Y - (FLOOR_Y - point[Y]) * inflation.height, point[Z] * inflation.depth];
}

function inflateSolid(center: Point3, radius: Point3, inflation: Inflation): Solid {
  const inflatedCenter = inflatePoint(center, inflation);
  const inflatedRadius: Point3 = [radius[X] * inflation.width, radius[Y] * inflation.height, radius[Z] * inflation.depth];
  return [inflatedCenter, inflatedRadius];
}

function armSolid(center: Point3, radius: Point3, pivot: Point3, reach: number, inflation: Inflation): Solid {
  const shortenedCenter: Point3 = [
    pivot[X] + (center[X] - pivot[X]) * reach,
    pivot[Y] + (center[Y] - pivot[Y]) * reach,
    pivot[Z] + (center[Z] - pivot[Z]) * reach,
  ];
  const shortenedRadius: Point3 = [radius[X], radius[Y] * reach, radius[Z]];
  return inflateSolid(shortenedCenter, shortenedRadius, inflation);
}

function drawBody(mesh: CharacterMesh, inflation: Inflation) {
  const ringCount = BODY_PROFILE.length - ONE;
  for (let ring = ZERO; ring < ringCount; ring += ONE) {
    const upper = BODY_PROFILE[ring];
    const lower = BODY_PROFILE[ring + ONE];
    const radiusChange = (lower[Y] - upper[Y]) * inflation.width;
    const heightChange = (lower[X] - upper[X]) * inflation.height;
    for (let segment = ZERO; segment < BODY_SEGMENTS; segment += ONE) {
      const from = segment / BODY_SEGMENTS * FULL_TURN;
      const to = (segment + ONE) / BODY_SEGMENTS * FULL_TURN;
      const middle = (from + to) * HALF;
      const cosFrom = Math.cos(from);
      const sinFrom = Math.sin(from);
      const cosTo = Math.cos(to);
      const sinTo = Math.sin(to);
      const topLeft: Point3 = [upper[Y] * cosFrom, upper[X], upper[Z] * sinFrom];
      const bottomLeft: Point3 = [lower[Y] * cosFrom, lower[X], lower[Z] * sinFrom];
      const bottomRight: Point3 = [lower[Y] * cosTo, lower[X], lower[Z] * sinTo];
      const topRight: Point3 = [upper[Y] * cosTo, upper[X], upper[Z] * sinTo];
      const profilePoints = [topLeft, bottomLeft, bottomRight, topRight];
      const points = profilePoints.map((point) => inflatePoint(point, inflation));
      const normalLength = Math.hypot(heightChange, radiusChange);
      const cosMiddle = Math.cos(middle);
      const sinMiddle = Math.sin(middle);
      const normal: Point3 = [cosMiddle * heightChange / normalLength, -radiusChange / normalLength, sinMiddle * heightChange / normalLength];
      mesh.polygon(points, SHELL, normal);
    }
  }
}

function drawCross(mesh: CharacterMesh, center: Point3) {
  const [x, y, z] = center;
  for (const direction of SIDES) {
    const points: Point3[] = [
      [x - CROSS_HALF, y - direction * CROSS_HALF - CROSS_STROKE, z],
      [x + CROSS_HALF, y + direction * CROSS_HALF - CROSS_STROKE, z],
      [x + CROSS_HALF, y + direction * CROSS_HALF + CROSS_STROKE, z],
      [x - CROSS_HALF, y - direction * CROSS_HALF + CROSS_STROKE, z],
    ];
    mesh.polygon(points, EYES);
  }
}

function drawFace(mesh: CharacterMesh, pose: CharacterPose, offset: Point3) {
  const failed = pose.failed > FAILED_EYES_THRESHOLD;
  const blinkDistance = Math.abs(pose.time % BLINK_PERIOD - BLINK_CENTER);
  const blinkOpening = blinkDistance / BLINK_DURATION;
  const clampedOpening = Math.min(ONE, blinkOpening);
  const opening = Math.max(BLINK_MINIMUM, clampedOpening);
  const y = EYE_Y + offset[Y];
  const z = EYE_Z + offset[Z];
  const lineCenter: Point3 = [ZERO, y, z - EYE_LAYER];
  const lineSize: Point3 = [EYE_X * TWO, EYE_LINE_HEIGHT, ZERO];
  const line: Solid = [lineCenter, lineSize];
  frontPanel(mesh, line, EYES);
  for (const side of SIDES) {
    const x = side * EYE_X;
    const center: Point3 = [x, y, z];
    if (failed) {
      drawCross(mesh, center);
    } else {
      const height = EYE_HEIGHT * opening;
      frontOval(mesh, center, EYE_RADIUS, height, EYES);
    }
  }
}

function drawHead(mesh: CharacterMesh, pose: CharacterPose, inflation: Inflation) {
  const center = inflatePoint(HEAD_CENTER, inflation);
  const forward = pose.failed * HEAD_ERROR_FORWARD;
  const pivot: Point3 = [center[X], center[Y], center[Z] + forward];
  const pitch = -pose.gazeY * HEAD_PITCH + pose.read * HEAD_READ_PITCH + pose.failed * HEAD_DROOP;
  const yaw = pose.gazeX * HEAD_YAW;
  const thoughtWave = Math.sin(pose.time * HEAD_THINK_RATE);
  const active = (ONE - pose.quiet) * (ONE - pose.failed) * (ONE - pose.done);
  const roll = pose.listen * HEAD_LISTEN_ROLL + thoughtWave * HEAD_THINK_ROLL * active;
  const angles: Point3 = [pitch, yaw, roll];
  mesh.group(pivot, angles, () => {
    const head: Solid = [pivot, HEAD_RADIUS];
    mesh.ellipsoid(head, SHELL);
    const translation: Point3 = [ZERO, pivot[Y] - HEAD_CENTER[Y], forward];
    const faceAnchor: Point3 = [FACE_ANCHOR[X], FACE_ANCHOR[Y] + translation[Y], FACE_ANCHOR[Z] + forward];
    mesh.decal(faceAnchor, () => drawFace(mesh, pose, translation));
  });
}

function drawArms(mesh: CharacterMesh, pose: CharacterPose, inflation: Inflation) {
  const active = (ONE - pose.quiet) * (ONE - pose.failed) * (ONE - pose.done);
  const idleWave = Math.sin(pose.time * ARM_IDLE_RATE);
  const idleSpread = (ONE + idleWave) * HALF * ARM_IDLE_SPREAD * active;
  for (const side of SIDES) {
    const basePivot: Point3 = [side * ARM_PIVOT_X, ARM_PIVOT_Y, ARM_PIVOT_Z];
    const pivot = inflatePoint(basePivot, inflation);
    const workWave = Math.sin(pose.time * ARM_WORK_RATE + side);
    const writeWave = Math.sin(pose.time * ARM_WRITE_RATE + side);
    const waveMotion = Math.sin(pose.time * ARM_WAVE_RATE);
    const wave = side === -ONE ? pose.done * (ARM_WAVE_LIFT + waveMotion * ARM_WAVE_SIZE) : ZERO;
    const listen = side === ONE ? pose.listen * ARM_LISTEN_LIFT : ZERO;
    const gesture = side === -ONE ? pose.done : pose.listen;
    const reach = ONE - gesture * ARM_GESTURE_SHORTENING;
    const spread = ARM_REST_ROLL + idleSpread + pose.speak * pose.signal * ARM_SPEAK_SPREAD;
    const roll = -side * (spread + wave + listen + pose.failed * ARM_ERROR_ROLL);
    const pitch = -pose.work * (ARM_WORK_PITCH + workWave * ARM_WORK_SWING)
      - pose.write * (ARM_WRITE_PITCH + writeWave * ARM_WRITE_TAP) - pose.read * ARM_READ_PITCH;
    const angles: Point3 = [pitch, ZERO, roll];
    mesh.group(pivot, angles, () => {
      const upperCenter: Point3 = [side * ARM_CENTER_X, ARM_CENTER_Y, ZERO];
      const handCenter: Point3 = [side * HAND_X, HAND_Y, HAND_Z];
      const thumbCenter: Point3 = [side * THUMB_X, THUMB_Y, THUMB_Z];
      const upper = armSolid(upperCenter, ARM_RADIUS, basePivot, reach, inflation);
      const hand = armSolid(handCenter, HAND_RADIUS, basePivot, reach, inflation);
      const thumb = armSolid(thumbCenter, THUMB_RADIUS, basePivot, reach, inflation);
      const [shoulderCenter] = upper;
      const shoulderAngles: Point3 = [ZERO, ZERO, -side * ARM_SHOULDER_SLOPE * inflation.height];
      mesh.group(shoulderCenter, shoulderAngles, () => mesh.ellipsoid(upper, LIMBS));
      mesh.ellipsoid(hand, SHELL);
      mesh.ellipsoid(thumb, SHELL);
      for (const offset of FINGER_OFFSETS) {
        const fingerCenter: Point3 = [side * HAND_X + offset, FINGER_Y, FINGER_Z];
        const finger = armSolid(fingerCenter, FINGER_RADIUS, basePivot, reach, inflation);
        mesh.ellipsoid(finger, SHELL);
      }
    });
  }
}

function drawLegs(mesh: CharacterMesh, pose: CharacterPose, inflation: Inflation) {
  const walking = pose.work * (ONE - pose.failed) * (ONE - pose.quiet);
  for (const side of SIDES) {
    const walkWave = Math.sin(pose.time * LEG_WALK_RATE + side);
    const basePivot: Point3 = [side * LEG_X, LEG_PIVOT_Y, LEG_Z];
    const pivot = inflatePoint(basePivot, inflation);
    const angles: Point3 = [walkWave * walking * LEG_WALK_PITCH, ZERO, side * walking * LEG_WALK_ROLL];
    mesh.group(pivot, angles, () => {
      const center: Point3 = [side * LEG_X, LEG_Y, LEG_Z];
      const leg = inflateSolid(center, LEG_RADIUS, inflation);
      mesh.ellipsoid(leg, LIMBS);
    });
  }
}

function drawBadge(mesh: CharacterMesh, inflation: Inflation) {
  const anchor = inflatePoint(BADGE_CENTER, inflation);
  mesh.decal(anchor, () => {
    frontOval(mesh, anchor, BADGE_RADIUS, BADGE_RADIUS * inflation.height, SEAM);
    const inner: Point3 = [anchor[X], anchor[Y], anchor[Z] + EYE_LAYER];
    frontOval(mesh, inner, BADGE_INNER_RADIUS, BADGE_INNER_RADIUS * inflation.height, SHELL);
    const center: Point3 = [anchor[X], anchor[Y] - BADGE_LINE_TILT, anchor[Z] + EYE_LAYER * TWO];
    const size: Point3 = [BADGE_LINE_WIDTH, BADGE_LINE_HEIGHT, ZERO];
    const line: Solid = [center, size];
    frontPanel(mesh, line, SEAM);
  });
}

export function buildBaymax(mesh: CharacterMesh, pose: CharacterPose) {
  const active = (ONE - pose.quiet) * (ONE - pose.failed) * (ONE - pose.done);
  const breathWave = Math.sin(pose.time * BREATH_RATE);
  const breath = breathWave * BREATH_SIZE * active + pose.signal * pose.speak * SPEECH_BREATH;
  const inflation: Inflation = {
    height: ONE - pose.failed * DEFLATION_HEIGHT,
    width: ONE + pose.failed * DEFLATION_WIDTH + breath,
    depth: ONE - pose.failed * DEFLATION_DEPTH + breath,
  };
  drawLegs(mesh, pose, inflation);
  drawArms(mesh, pose, inflation);
  drawBody(mesh, inflation);
  drawBadge(mesh, inflation);
  const folded = pose.failed > FOLD_THRESHOLD;
  if (folded) {
    for (const level of FOLD_LEVELS) {
      const base: Point3 = [ZERO, level, FOLD_DEPTH];
      const center = inflatePoint(base, inflation);
      const size: Point3 = [FOLD_WIDTH * pose.failed, FOLD_HEIGHT * pose.failed, ZERO];
      const fold: Solid = [center, size];
      mesh.decal(center, () => frontPanel(mesh, fold, SEAM));
    }
  }
  drawHead(mesh, pose, inflation);
}
