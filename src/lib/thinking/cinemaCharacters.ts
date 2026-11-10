import { CharacterMesh, type Point3, type Solid } from "./characterMesh";
import { mix, type Rgb } from "./palette";

export type CinemaCharacter = "calcifer" | "walle" | "tars" | "r2d2";
export interface CharacterPose {
  time: number;
  gazeX: number;
  gazeY: number;
  work: number;
  read: number;
  write: number;
  speak: number;
  listen: number;
  quiet: number;
  done: number;
  failed: number;
  signal: number;
}

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const HALF = 0.5;
const X = 0;
const Y = 1;
const Z = 2;
const SIDES = [-1, 1] as const;
const FULL_TURN = Math.PI * TWO;
const COLORS = {
  orange: [255, 102, 22], amber: [255, 176, 37], yellow: [255, 221, 81],
  cream: [255, 247, 210], white: [235, 241, 243], silver: [179, 193, 201],
  steel: [99, 117, 130], dark: [29, 37, 45], black: [10, 16, 24],
  rubber: [54, 52, 47], tread: [105, 100, 83], ochre: [214, 159, 52],
  gold: [244, 197, 78], rust: [132, 82, 39], wood: [102, 53, 28],
  cutWood: [209, 151, 84], blue: [37, 69, 166], lens: [104, 197, 238],
  red: [247, 78, 69], green: [111, 234, 164],
} satisfies Record<string, Rgb>;
const FACE = {
  eyeX: 0.086, eyeY: 0.095, eyeZ: 0.177, pupilZ: 0.203,
  eyeRadius: [0.052, 0.064, 0.026], pupilRadius: [0.022, 0.029, 0.012],
  pupilTravel: 0.017, lidHeight: 0.008, mouthY: 0.192, mouthZ: 0.169,
  mouthRadius: [0.066, 0.025, 0.014], mouthSpeech: 0.036,
  nose: [[0, 0.151, 0.186], [0.023, 0.014, 0.012]],
} as const;
const FLAME = {
  rings: [[0.305, 0.025, 0], [0.28, 0.14, 0], [0.21, 0.205, 0], [0.1, 0.23, 0], [-0.02, 0.19, -0.005], [-0.13, 0.115, -0.03], [-0.24, 0.046, -0.018], [-0.36, 0.008, -0.061]],
  depth: 0.69, swayRate: 4.8, rippleRate: 9, ripple: 0.014,
  tipLean: 0.055, sideHeight: 0.71, sideWidth: 0.49, sideX: 0.185,
  sideY: 0.105, sideZ: -0.01, core: [[0, 0.13, 0.105], [0.178, 0.17, 0.066]],
  quietScale: 0.33, speechScale: 0.12, workSway: 0.035,
  logCenters: [[0, 0.348, -0.032], [0, 0.407, 0.035]],
  logRadius: 0.045, logLength: 0.61, logAngle: 0.14,
  logEndRadius: [0.007, 0.044, 0.044], logEndX: 0.306,
  normalY: -0.35,
  emberCount: 5, emberSpeed: 0.23, emberRise: 0.31, emberX: 0.16,
  emberY: -0.14, emberRadius: 0.012, workRate: 1.8, writeRate: 1.3,
  finishFlare: 0.16,
  tipCurl: 0.06, tipLift: 0.06, curlStart: 0.65,
} as const;
const WALLE = {
  body: [[0, 0.139, 0], [0.365, 0.29, 0.275]],
  top: [[0, -0.019, 0], [0.38, 0.03, 0.29]],
  chest: [[0, 0.079, 0.143], [0.285, 0.089, 0.018]],
  solar: [[-0.062, 0.076, 0.156], [0.083, 0.052, 0.011]],
  status: [[0.065, 0.075, 0.157], [0.058, 0.018, 0.013]],
  door: [[0, 0.207, 0.143], [0.262, 0.113, 0.012]],
  neck: [[0, -0.096, 0], [0.055, 0.15, 0.066]],
  neckJoint: [[0, -0.173, 0], [0.058, 0.048, 0.043]],
  headPivot: [0, -0.237, 0], eyeX: 0.115, eyeY: -0.233,
  eyeSize: [0.125, 0.088, 0.08], opticSize: [0.078, 0.073, 0.021],
  opticZ: 0.075, irisZ: 0.096, irisSize: [0.051, 0.052, 0.008],
  pupilZ: 0.105, pupilSize: [0.031, 0.036, 0.007],
  glintSize: [0.012, 0.014, 0.004], glintOffset: -0.013, glintZ: 0.114,
  trackX: 0.236, track: [0.139, 0.229, 0.33], trackY: 0.29,
  treadCount: 7, treadStart: -0.13, treadGap: 0.043, treadSpeed: 0.11,
  treadSize: [0.149, 0.018, 0.026], treadY: 0.406,
  wheelZ: 0.035, wheelX: 0.308, wheelSize: [0.012, 0.078, 0.105],
  armX: 0.234, armY: 0.049, armSize: [0.055, 0.17, 0.06],
  handY: 0.151, handSize: [0.086, 0.04, 0.12],
  armWork: 0.32, armWave: 1.8, armRate: 6, headYaw: 0.55, headPitch: 0.23,
  headTilt: 0.12, headSleep: 0.38, eyeTilt: 0.12,
  pupilTravel: 0.012, speakingNod: 0.09, sleepLens: 0.28,
  writeReach: 0.4, writeRate: 11, writeTap: 0.13,
  treadYs: [0.196, 0.237, 0.278, 0.319, 0.36, 0.398],
  frontTreadSize: [0.144, 0.014, 0.012], frontTreadZ: 0.17,
} as const;
const TARS = {
  columns: [-0.225, -0.075, 0.075, 0.225], width: 0.141, height: 0.71, depth: 0.125,
  pivotY: -0.25, footY: 0.34, footSize: [0.136, 0.025, 0.14],
  displayY: -0.132, displayZ: 0.068, displaySize: [0.13, 0.115, 0.012],
  lowerY: 0.188, lowerSize: [0.13, 0.065, 0.012],
  grooveXs: [-0.042, 0, 0.042], grooveSize: [0.004, 0.69, 0.002],
  seamYs: [-0.29, 0.031, 0.303], seamSize: [0.133, 0.004, 0.003],
  walkRate: 5, walkAngle: 0.34, outerAngle: 0.11, finishAngle: 0.33,
  sleepAngle: 0.035, frontZ: 0.066, middleColumn: 1,
  signalBars: 5, signalX: -0.047, signalGap: 0.023, signalY: -0.132,
  signalZ: 0.078, signalSize: [0.012, 0.014, 0.006],
  signalHeight: 0.043, signalRate: 7, readTravel: 0.06,
  writeRate: 9, writeAngle: 0.12, writeSignal: 0.65,
  letterPixel: 0.007, letterZ: 0.069, letterX: -0.008,
  letterY: -0.054, letterGap: 0.041,
} as const;
const R2 = {
  body: [[0, 0.069, 0], [0.192, 0.383, 0.192]],
  rim: [[0, -0.128, 0], [0.202, 0.022, 0.202]],
  dome: [[0, -0.137, 0], [0.2, 0.191, 0.2]],
  domePivot: [0, -0.137, 0], domePanel: [[0, -0.228, 0.161], [0.11, 0.102, 0.025]],
  eye: [[0, -0.233, 0.185], [0.039, 0.038, 0.02]],
  eyeGlint: [[-0.011, -0.246, 0.203], [0.009, 0.009, 0.004]],
  domeBand: [[0, -0.155, 0], [0.202, 0.036, 0.202]],
  domeCrown: [[0, -0.32, 0], [0.066, 0.012, 0.066]],
  domeStripes: [-0.12, 0.12], stripeSize: [0.047, 0.08, 0.02],
  stripeY: -0.251, stripeZ: 0.131, yaw: 0.77,
  slots: [-0.064, -0.013, 0.038], slotSize: [0.258, 0.025, 0.012], slotZ: 0.188,
  vents: [0.104, 0.166], vent: [0.061, 0.044, 0.018],
  panelXs: [-0.112, 0.112], panelY: 0.15, panelSize: [0.053, 0.152, 0.012],
  panelInset: [0.029, 0.127, 0.009], legX: 0.274, legY: 0.102,
  legSize: [0.073, 0.318, 0.103], shoulder: [0.057, 0.079, 0.078],
  shoulderY: -0.052, legStripeSize: [0.026, 0.196, 0.013],
  footY: 0.312, footZ: 0.035, footSize: [0.135, 0.08, 0.25],
  centerFoot: [[0, 0.332, 0.113], [0.085, 0.073, 0.175]],
  toolPivot: [0.123, 0.098, 0.199], toolSize: [0.025, 0.018, 0.15],
  toolTip: [0.04, 0.03, 0.032], toolExtend: 0.068,
  workRate: 7, workTilt: 0.065, doneYaw: 0.7, headSleep: 0.16,
  light: [[-0.09, -0.16, 0.186], [0.017, 0.016, 0.009]],
  speechGain: 0.7, signalRate: 12,
} as const;
const EYE_SPARK: Solid = [[-0.008, -0.012, 0.011], [0.007, 0.008, 0.003]];
const FLAME_SEGMENTS = 18;
const EYE_CLOSED_THRESHOLD = 0.5;
const EYE_FAILURE_SIZE = 0.035;
const EYE_LINE_SIZE = 0.009;
const CROSS_ANGLE = Math.PI / 4;
const TARS_LETTERS = [
  [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2], [1, 3], [1, 4]],
  [[1, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2], [0, 3], [2, 3], [0, 4], [2, 4]],
  [[0, 0], [1, 0], [0, 1], [2, 1], [0, 2], [1, 2], [0, 3], [2, 3], [0, 4], [2, 4]],
  [[1, 0], [2, 0], [0, 1], [1, 2], [2, 3], [0, 4], [1, 4]],
] as const;

function calciferFlame(mesh: CharacterMesh, pose: CharacterPose, side: number) {
  const main = side === ZERO;
  const width = main ? ONE : FLAME.sideWidth;
  const height = main ? ONE : FLAME.sideHeight;
  const quietHeight = ONE - pose.quiet * FLAME.quietScale;
  const speechHeight = ONE + pose.speak * pose.signal * FLAME.speechScale + pose.done * FLAME.finishFlare;
  const flickerRate = ONE + pose.work * FLAME.workRate + pose.write * FLAME.writeRate;
  const swayPhase = pose.time * FLAME.swayRate * flickerRate + side;
  const sway = Math.sin(swayPhase) * FLAME.tipLean;
  const sideX = side * FLAME.sideX;
  const sideY = main ? ZERO : FLAME.sideY;
  const ringCount = FLAME.rings.length - ONE;
  for (let ring = ZERO; ring < ringCount; ring += ONE) {
    const lower = FLAME.rings[ring];
    const upper = FLAME.rings[ring + ONE];
    const progress = ring / ringCount;
    const baseColor = mix(COLORS.orange, COLORS.amber, ONE - progress);
    for (let segment = ZERO; segment < FLAME_SEGMENTS; segment += ONE) {
      const from = segment / FLAME_SEGMENTS * FULL_TURN;
      const to = (segment + ONE) / FLAME_SEGMENTS * FULL_TURN;
      const corners = [[lower, from], [lower, to], [upper, to], [upper, from]] as const;
      const points = corners.map(([[y, radius, bend], angle]): Point3 => {
        const cosAngle = Math.cos(angle);
        const sinAngle = Math.sin(angle);
        const ringPhase = pose.time * FLAME.rippleRate + angle + ring;
        const ripple = Math.sin(ringPhase) * FLAME.ripple * progress;
        const curlProgress = Math.max(ZERO, progress - FLAME.curlStart);
        const curl = curlProgress * FLAME.tipCurl;
        const lean = sway * progress + pose.gazeX * FLAME.workSway * progress - curl;
        const lift = ripple * FLAME.tipLift;
        return [sideX + cosAngle * (radius + ripple) * width + lean + bend, y * height * quietHeight * speechHeight + sideY + lift, sinAngle * radius * FLAME.depth * width + FLAME.sideZ];
      });
      const middle = (from + to) * HALF;
      const normalX = Math.cos(middle);
      const normalZ = Math.sin(middle);
      const normal: Point3 = [normalX, FLAME.normalY, normalZ];
      mesh.polygon(points, baseColor, normal);
    }
  }
}

function calcifer(mesh: CharacterMesh, pose: CharacterPose) {
  for (const center of FLAME.logCenters) {
    const log: Solid = [center, [FLAME.logRadius, FLAME.logLength, FLAME.logRadius]];
    const angle = Math.PI * HALF + center[Z] * FLAME.logAngle;
    const rotation: Point3 = [ZERO, ZERO, angle];
    const buildLog = () => mesh.cylinder(log, COLORS.wood);
    mesh.group(center, rotation, buildLog);
    const end: Solid = [[-FLAME.logEndX, center[Y], center[Z]], FLAME.logEndRadius];
    mesh.ellipsoid(end, COLORS.cutWood);
  }
  for (const side of SIDES) calciferFlame(mesh, pose, side);
  calciferFlame(mesh, pose, ZERO);
  mesh.ellipsoid(FLAME.core, COLORS.yellow);
  mesh.ellipsoid(FACE.nose, COLORS.orange);
  const sleeping = pose.quiet > EYE_CLOSED_THRESHOLD;
  const failed = pose.failed > EYE_CLOSED_THRESHOLD;
  for (const side of SIDES) {
    const eyeX = side * FACE.eyeX;
    const eye: Solid = [[eyeX, FACE.eyeY, FACE.eyeZ], FACE.eyeRadius];
    mesh.ellipsoid(eye, COLORS.cream);
    const pupilX = eyeX + pose.gazeX * FACE.pupilTravel;
    const pupilY = FACE.eyeY + pose.gazeY * FACE.pupilTravel;
    const pupil: Solid = [[pupilX, pupilY, FACE.pupilZ], FACE.pupilRadius];
    if (failed) {
      const cross: Solid = [[eyeX, FACE.eyeY, FACE.pupilZ], [EYE_FAILURE_SIZE, EYE_LINE_SIZE, EYE_LINE_SIZE]];
      const pivot: Point3 = [eyeX, FACE.eyeY, FACE.pupilZ];
      for (const direction of SIDES) {
        const angle: Point3 = [ZERO, ZERO, direction * CROSS_ANGLE];
        const drawCross = () => mesh.box(cross, COLORS.black);
        mesh.group(pivot, angle, drawCross);
      }
    } else if (sleeping) {
      const lid: Solid = [[eyeX, FACE.eyeY, FACE.pupilZ], [FACE.eyeRadius[X] * TWO, FACE.lidHeight, FACE.lidHeight]];
      mesh.box(lid, COLORS.black);
    } else {
      mesh.ellipsoid(pupil, COLORS.black);
      const glint: Solid = [[pupilX + EYE_SPARK[X][X], pupilY + EYE_SPARK[X][Y], FACE.pupilZ + EYE_SPARK[X][Z]], EYE_SPARK[Y]];
      mesh.ellipsoid(glint, COLORS.white);
    }
  }
  const mouthHeight = FACE.mouthRadius[Y] + pose.speak * pose.signal * FACE.mouthSpeech;
  const mouth: Solid = [[ZERO, FACE.mouthY, FACE.mouthZ], [FACE.mouthRadius[X], mouthHeight, FACE.mouthRadius[Z]]];
  mesh.ellipsoid(mouth, COLORS.rust);
  const burningSparks = pose.write + pose.done;
  if (burningSparks <= ZERO) return;
  for (let index = ZERO; index < FLAME.emberCount; index += ONE) {
    const progress = (pose.time * FLAME.emberSpeed + index / FLAME.emberCount) % ONE;
    const side = index % TWO ? ONE : -ONE;
    const radius = FLAME.emberRadius * (ONE - progress);
    const ember: Solid = [[side * FLAME.emberX, FLAME.emberY - progress * FLAME.emberRise, ZERO], [radius, radius, radius]];
    mesh.ellipsoid(ember, COLORS.yellow);
  }
}

function walle(mesh: CharacterMesh, pose: CharacterPose) {
  mesh.box(WALLE.body, COLORS.ochre);
  mesh.box(WALLE.top, COLORS.steel);
  mesh.box(WALLE.chest, COLORS.dark);
  mesh.box(WALLE.solar, COLORS.silver);
  mesh.box(WALLE.door, COLORS.gold);
  const light = pose.failed ? COLORS.red : COLORS.green;
  mesh.box(WALLE.status, light);
  mesh.box(WALLE.neck, COLORS.rust);
  mesh.ellipsoid(WALLE.neckJoint, COLORS.steel);
  const treadTravel = pose.time * WALLE.treadSpeed * pose.work;
  for (const side of SIDES) {
    const trackX = side * WALLE.trackX;
    const track: Solid = [[trackX, WALLE.trackY, ZERO], WALLE.track];
    mesh.box(track, COLORS.rubber);
    for (const y of WALLE.treadYs) {
      const tread: Solid = [[trackX, y, WALLE.frontTreadZ], WALLE.frontTreadSize];
      mesh.box(tread, COLORS.tread);
    }
    const wheel: Solid = [[side * WALLE.wheelX, WALLE.trackY, WALLE.wheelZ], WALLE.wheelSize];
    mesh.ellipsoid(wheel, COLORS.tread);
    for (let index = ZERO; index < WALLE.treadCount; index += ONE) {
      const travel = (index * WALLE.treadGap + treadTravel) % WALLE.track[Z];
      const tread: Solid = [[trackX, WALLE.treadY, WALLE.treadStart + travel], WALLE.treadSize];
      mesh.box(tread, COLORS.tread);
    }
    const armPivot: Point3 = [side * WALLE.armX, WALLE.armY, ZERO];
    const swing = Math.sin(pose.time * WALLE.armRate) * pose.work * WALLE.armWork;
    const writeBeat = Math.sin(pose.time * WALLE.writeRate + side);
    const writing = pose.write * (WALLE.writeReach + writeBeat * WALLE.writeTap);
    const armAngle: Point3 = [swing - writing, ZERO, side * pose.done * WALLE.armWave];
    const arm: Solid = [armPivot, WALLE.armSize];
    const hand: Solid = [[side * WALLE.armX, WALLE.handY, ZERO], WALLE.handSize];
    const drawArm = () => {
      mesh.box(arm, COLORS.silver);
      mesh.box(hand, COLORS.steel);
    };
    mesh.group(armPivot, armAngle, drawArm);
  }
  const headPitch = pose.gazeY * WALLE.headPitch + pose.quiet * WALLE.headSleep - pose.signal * pose.speak * WALLE.speakingNod;
  const headAngles: Point3 = [headPitch, pose.gazeX * WALLE.headYaw, pose.gazeX * WALLE.headTilt];
  const drawHead = () => {
    for (const side of SIDES) {
      const eyeX = side * WALLE.eyeX;
      const pivot: Point3 = [eyeX, WALLE.eyeY, ZERO];
      const eyeAngle: Point3 = [ZERO, ZERO, -side * WALLE.eyeTilt];
      const drawEye = () => {
        const casing: Solid = [pivot, WALLE.eyeSize];
        const optic: Solid = [[eyeX, WALLE.eyeY, WALLE.opticZ], WALLE.opticSize];
        const iris: Solid = [[eyeX, WALLE.eyeY, WALLE.irisZ], WALLE.irisSize];
        const pupil: Solid = [[eyeX + pose.gazeX * WALLE.pupilTravel, WALLE.eyeY + pose.gazeY * WALLE.pupilTravel, WALLE.pupilZ], WALLE.pupilSize];
        const glint: Solid = [[eyeX + WALLE.glintOffset, WALLE.eyeY + WALLE.glintOffset, WALLE.glintZ], WALLE.glintSize];
        const irisColor = pose.failed ? COLORS.red : COLORS.lens;
        mesh.ellipsoid(casing, COLORS.silver);
        mesh.ellipsoid(optic, COLORS.dark);
        mesh.ellipsoid(iris, irisColor);
        mesh.ellipsoid(pupil, COLORS.black);
        mesh.ellipsoid(glint, COLORS.white);
      };
      mesh.group(pivot, eyeAngle, drawEye);
    }
  };
  mesh.group(WALLE.headPivot, headAngles, drawHead);
}

function tars(mesh: CharacterMesh, pose: CharacterPose) {
  const workBeat = Math.sin(pose.time * TARS.walkRate) * pose.work;
  const columnCount = TARS.columns.length;
  for (let index = ZERO; index < columnCount; index += ONE) {
    const x = TARS.columns[index];
    const side = x < ZERO ? -ONE : ONE;
    const outside = index === ZERO || index === columnCount - ONE;
    const writeBeat = Math.sin(pose.time * TARS.writeRate + index);
    const writing = pose.write * writeBeat * TARS.writeAngle;
    const swing = outside ? workBeat * side * TARS.walkAngle + writing : -workBeat * side * TARS.outerAngle;
    const lean = outside ? side * pose.done * TARS.finishAngle : pose.quiet * TARS.sleepAngle;
    const pivot: Point3 = [x, TARS.pivotY, ZERO];
    const angles: Point3 = [swing, ZERO, lean];
    const drawColumn = () => {
      const bar: Solid = [[x, ZERO, ZERO], [TARS.width, TARS.height, TARS.depth]];
      const foot: Solid = [[x, TARS.footY, ZERO], TARS.footSize];
      const display: Solid = [[x, TARS.displayY, TARS.displayZ], TARS.displaySize];
      const lower: Solid = [[x, TARS.lowerY, TARS.displayZ], TARS.lowerSize];
      mesh.box(bar, COLORS.silver);
      mesh.box(foot, COLORS.steel);
      mesh.box(display, COLORS.black);
      mesh.box(lower, COLORS.dark);
      for (const grooveX of TARS.grooveXs) {
        const groove: Solid = [[x + grooveX, ZERO, TARS.frontZ], TARS.grooveSize];
        mesh.box(groove, COLORS.steel);
      }
      for (const y of TARS.seamYs) {
        const seam: Solid = [[x, y, TARS.frontZ], TARS.seamSize];
        mesh.box(seam, COLORS.steel);
      }
      const middle = index === TARS.middleColumn;
      if (!middle) return;
      const screenColor = pose.failed ? COLORS.red : COLORS.lens;
      for (let band = ZERO; band < TARS.signalBars; band += ONE) {
        const beat = Math.sin(pose.time * TARS.signalRate + band);
        const screenActivity = pose.signal + pose.write * TARS.writeSignal;
        const amplitude = screenActivity * beat * TARS.signalHeight;
        const height = TARS.signalSize[Y] + amplitude * amplitude / TARS.signalHeight;
        const y = TARS.signalY + pose.gazeY * pose.read * TARS.readTravel;
        const signal: Solid = [[x + TARS.signalX + band * TARS.signalGap, y, TARS.signalZ], [TARS.signalSize[X], height, TARS.signalSize[Z]]];
        mesh.box(signal, screenColor);
      }
      const letterCount = TARS_LETTERS.length;
      for (let letterIndex = ZERO; letterIndex < letterCount; letterIndex += ONE) {
        const pixels = TARS_LETTERS[letterIndex];
        for (const [column, row] of pixels) {
          const pixelX = x + TARS.letterX + column * TARS.letterPixel;
          const pixelY = TARS.letterY + letterIndex * TARS.letterGap + row * TARS.letterPixel;
          const pixel: Solid = [[pixelX, pixelY, TARS.letterZ], [TARS.letterPixel, TARS.letterPixel, TARS.grooveSize[Z]]];
          mesh.box(pixel, COLORS.ochre);
        }
      }
    };
    mesh.group(pivot, angles, drawColumn);
  }
}

function r2d2(mesh: CharacterMesh, pose: CharacterPose) {
  mesh.cylinder(R2.body, COLORS.white);
  mesh.cylinder(R2.rim, COLORS.steel);
  for (const y of R2.slots) {
    const slot: Solid = [[ZERO, y, R2.slotZ], R2.slotSize];
    mesh.box(slot, COLORS.blue);
  }
  for (const y of R2.vents) {
    const vent: Solid = [[ZERO, y, R2.slotZ], R2.vent];
    mesh.box(vent, COLORS.dark);
  }
  for (const side of SIDES) {
    const legX = side * R2.legX;
    const leg: Solid = [[legX, R2.legY, ZERO], R2.legSize];
    const shoulder: Solid = [[legX, R2.shoulderY, ZERO], R2.shoulder];
    const stripe: Solid = [[legX, R2.legY, R2.legSize[Z] * HALF], R2.legStripeSize];
    const foot: Solid = [[legX, R2.footY, R2.footZ], R2.footSize];
    mesh.box(leg, COLORS.white);
    mesh.ellipsoid(shoulder, COLORS.silver);
    mesh.box(stripe, COLORS.blue);
    mesh.box(foot, COLORS.white);
  }
  for (const x of R2.panelXs) {
    const panel: Solid = [[x, R2.panelY, R2.slotZ], R2.panelSize];
    const inset: Solid = [[x, R2.panelY, R2.slotZ + R2.panelSize[Z]], R2.panelInset];
    mesh.box(panel, COLORS.silver);
    mesh.box(inset, COLORS.blue);
  }
  mesh.box(R2.centerFoot, COLORS.white);
  const workSway = Math.sin(pose.time * R2.workRate) * pose.work * R2.workTilt;
  const domeYaw = pose.gazeX * R2.yaw + pose.done * R2.doneYaw + workSway;
  const headAngles: Point3 = [pose.quiet * R2.headSleep, domeYaw, ZERO];
  const drawHead = () => {
    mesh.ellipsoid(R2.dome, COLORS.silver, true);
    mesh.cylinder(R2.domeBand, COLORS.blue);
    mesh.cylinder(R2.domeCrown, COLORS.blue);
    mesh.box(R2.domePanel, COLORS.blue);
    const opticColor = pose.failed ? COLORS.red : COLORS.black;
    mesh.ellipsoid(R2.eye, opticColor);
    mesh.ellipsoid(R2.eyeGlint, COLORS.lens);
    for (const x of R2.domeStripes) {
      const stripe: Solid = [[x, R2.stripeY, R2.stripeZ], R2.stripeSize];
      mesh.box(stripe, COLORS.blue);
    }
    const lampBeat = Math.sin(pose.time * R2.signalRate);
    const lampIntensity = HALF + pose.speak * pose.signal * R2.speechGain + lampBeat * pose.write * HALF;
    const lampBase = pose.failed ? COLORS.red : COLORS.lens;
    const lampColor = mix(COLORS.dark, lampBase, lampIntensity);
    mesh.ellipsoid(R2.light, lampColor);
  };
  mesh.group(R2.domePivot, headAngles, drawHead);
  const usingTool = pose.work + pose.write;
  if (usingTool <= ZERO) return;
  const toolZ = R2.toolPivot[Z] + R2.toolExtend * usingTool;
  const tool: Solid = [[R2.toolPivot[X], R2.toolPivot[Y], toolZ], R2.toolSize];
  const tip: Solid = [[R2.toolPivot[X], R2.toolPivot[Y], toolZ + R2.toolSize[Z] * HALF], R2.toolTip];
  mesh.box(tool, COLORS.steel);
  mesh.box(tip, COLORS.blue);
}

export const CINEMA_BUILDERS: Record<CinemaCharacter, (mesh: CharacterMesh, pose: CharacterPose) => void> = {
  calcifer, walle, tars, r2d2,
};
