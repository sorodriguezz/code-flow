import { phaseGroup, thinkingState } from "./activity";
import { CharacterMesh, type Point3 } from "./characterMesh";
import { CINEMA_BUILDERS, type CharacterPose, type CinemaCharacter } from "./cinemaCharacters";
import { cueClock, startle } from "./cue";
import { lookFor, type Gaze } from "./face";
import { finishClock, rgba, TAU } from "./finish";
import { listenLevel } from "./listen";
import { palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { contactShadow } from "./volume";
import { voiceLevel } from "./voice";

const ZERO = 0;
const ONE = 1;
const HALF = 0.5;
const DEFAULT_GAIN = 1;
const MAX_SIGNAL = 1;
const RUN_STATE = "run";
const QUIET_STATE = "quiet";
const STOPPING_STATE = "stopping";
const DONE_STATE = "done";
const FAILED_STATE = "failed";
const SPEAK_PHASE = "speak";
const LISTEN_PHASE = "listen";
const READ_GROUP = "read";
const WORK_GROUP = "work";
const WRITE_GROUP = "write";
const DETAIL_THRESHOLD = 32;
const ICON_SEGMENTS = 8;
const DETAIL_SEGMENTS = 16;
const GAZE_EASING = 9;
const SIGNAL_EASING = 16;
const STILL_TIME = 1.1;
const STILL_SIGNAL = 0.7;
const PAUSED_OPACITY = 0.64;
const STOPPING_OPACITY = 0.36;
const ERROR_TINT = 0.4;
const SUCCESS_TINT = 0.08;
const MODEL_SCALE = 0.92;
const REST_YAW = -0.17;
const FOLLOW_YAW = 0.27;
const TARS_FOLLOW_YAW = 0.48;
const REST_PITCH = -0.12;
const FOLLOW_PITCH = 0.16;
const ROLL_RATE = 2.5;
const WORK_ROLL = 0.035;
const ERROR_ROLL = 0.09;
const WAKE_LIFT = 0.018;
const DONE_BOUNCE = 0.035;
const DONE_BOUNCE_RATE = 7;
const DONE_DECAY = 3;
const END_POSE_SECONDS = 0.45;
const IDLE_BOB = 0.006;
const IDLE_RATE = 2;
const ERROR_SINK = 0.025;
const SHADOW_Y = 0.93;
const SHADOW_RADIUS = 0.27;
const SHADOW_OPACITY = 0.25;
const SIGNAL_SIDES = [-1, 1] as const;
const SIGNAL_X = 0.36;
const SIGNAL_Y = 0.46;
const SIGNAL_RADIUS = 0.065;
const SIGNAL_RADIUS_PULSE = 0.022;
const SIGNAL_WIDTH = 0.008;
const SIGNAL_ARC = 0.65;
const SIGNAL_RATE = 3;
const SIGNAL_OFFSET = 0.025;
const SIGNAL_MINIMUM = 0.01;
const BADGE_RADIUS = 0.032;
const BADGE_X = 0.85;
const BADGE_Y = 0.78;
const TRANSPARENT = 0;
const CALCIFER = "calcifer";
const WALLE = "walle";
const TARS = "tars";
const R2D2 = "r2d2";
const INITIAL_POSE: CharacterPose = {
  time: ZERO, gazeX: ZERO, gazeY: ZERO, work: ZERO, read: ZERO,
  write: ZERO, speak: ZERO, listen: ZERO, quiet: ZERO, done: ZERO,
  failed: ZERO, signal: ZERO,
};

export function createCinemaCharacter(character: CinemaCharacter, canvas: HTMLCanvasElement, px: number, gain = DEFAULT_GAIN): Painter {
  const ctx = prepareCanvas(canvas, px);
  const finish = finishClock();
  const cue = cueClock();
  const detail = px >= DETAIL_THRESHOLD;
  const segments = detail ? DETAIL_SEGMENTS : ICON_SEGMENTS;
  const build = CINEMA_BUILDERS[character];
  const pose = { ...INITIAL_POSE };
  let gaze: Gaze = null;
  let time = ZERO;
  let signal = ZERO;

  function update(dt: number, frozen: boolean) {
    const act = finish.act;
    const state = thinkingState(act);
    const running = state === RUN_STATE;
    const quiet = state === QUIET_STATE || state === STOPPING_STATE;
    const speaking = running && act?.phase === SPEAK_PHASE;
    const listening = running && act?.phase === LISTEN_PHASE;
    const group = phaseGroup(act?.phase);
    const automaticGaze = lookFor(act?.phase, time);
    const target = running ? gaze ?? automaticGaze : null;
    const easing = frozen ? ONE : Math.min(ONE, dt * GAZE_EASING);
    const targetX = target?.[ZERO] ?? ZERO;
    const targetY = target?.[ONE] ?? ZERO;
    pose.gazeX += (targetX - pose.gazeX) * easing;
    pose.gazeY += (targetY - pose.gazeY) * easing;
    let level = ZERO;
    if (speaking) level = frozen ? STILL_SIGNAL : voiceLevel();
    if (listening) level = frozen ? STILL_SIGNAL : listenLevel();
    const amplified = level * gain;
    const clamped = Math.min(MAX_SIGNAL, amplified);
    const smoothing = frozen ? ONE : Math.min(ONE, dt * SIGNAL_EASING);
    signal += (clamped - signal) * smoothing;
    pose.time = time;
    pose.work = running && group === WORK_GROUP ? ONE : ZERO;
    pose.read = running && group === READ_GROUP ? ONE : ZERO;
    pose.write = running && group === WRITE_GROUP && !speaking ? ONE : ZERO;
    pose.speak = speaking ? ONE : ZERO;
    pose.listen = listening ? ONE : ZERO;
    pose.quiet = quiet ? ONE : ZERO;
    const endProgress = frozen ? ONE : Math.min(ONE, finish.fin / END_POSE_SECONDS);
    pose.done = state === DONE_STATE ? endProgress : ZERO;
    pose.failed = state === FAILED_STATE ? endProgress : ZERO;
    pose.signal = signal;
  }

  function paint(frozen: boolean) {
    if (!ctx) return;
    const colors = palette();
    const state = thinkingState(finish.act);
    const running = state === RUN_STATE;
    const awake = running && !frozen;
    const ending = finish.fin >= ZERO;
    const endTime = ending ? finish.fin : ZERO;
    const bounceWave = Math.sin(endTime * DONE_BOUNCE_RATE);
    const bounceDecay = Math.exp(-endTime * DONE_DECAY);
    const bounce = pose.done * bounceWave * bounceDecay * DONE_BOUNCE;
    const bobWave = Math.sin(time * IDLE_RATE);
    const bob = awake ? bobWave * IDLE_BOB : ZERO;
    const wake = startle(cue.wake);
    const offset: Point3 = [ZERO, bob - bounce - wake * WAKE_LIFT + pose.failed * ERROR_SINK, ZERO];
    const followYaw = character === TARS ? TARS_FOLLOW_YAW : FOLLOW_YAW;
    const workWave = Math.sin(time * ROLL_RATE);
    const roll = awake ? workWave * pose.work * WORK_ROLL : pose.failed * ERROR_ROLL;
    const angles: Point3 = [REST_PITCH + pose.gazeY * FOLLOW_PITCH, REST_YAW + pose.gazeX * followYaw, roll];
    const alpha = state === STOPPING_STATE ? STOPPING_OPACITY : pose.quiet ? PAUSED_OPACITY : ONE;
    const tint = pose.failed ? colors.danger : colors.success;
    const tintAmount = pose.failed ? ERROR_TINT : pose.done * SUCCESS_TINT;
    ctx.clearRect(ZERO, ZERO, px, px);
    const shadowColor: Rgb = colors.b;
    contactShadow(ctx, px * HALF, px * SHADOW_Y, px * SHADOW_RADIUS, shadowColor, SHADOW_OPACITY * alpha);
    const mesh = new CharacterMesh(segments);
    build(mesh, pose);
    mesh.paint(ctx, px, angles, offset, MODEL_SCALE, tint, tintAmount, alpha);
    const sound = pose.speak + pose.listen;
    const audible = sound > ZERO && signal > SIGNAL_MINIMUM;
    if (audible) {
      const soundColor = rgba(colors.c, signal);
      ctx.strokeStyle = soundColor;
      ctx.lineWidth = px * SIGNAL_WIDTH;
      const wave = Math.sin(time * SIGNAL_RATE);
      const travel = wave * SIGNAL_OFFSET * (pose.listen ? -ONE : ONE);
      for (const side of SIGNAL_SIDES) {
        const x = (HALF + side * (SIGNAL_X + travel)) * px;
        const y = SIGNAL_Y * px;
        const radius = (SIGNAL_RADIUS + signal * SIGNAL_RADIUS_PULSE) * px;
        const direction = side < ZERO ? Math.PI : ZERO;
        ctx.beginPath();
        ctx.arc(x, y, radius, direction - SIGNAL_ARC, direction + SIGNAL_ARC);
        ctx.stroke();
      }
    }
    if (!ending) return;
    const badgeColor = rgba(tint, ONE);
    ctx.fillStyle = badgeColor;
    ctx.beginPath();
    ctx.arc(px * BADGE_X, px * BADGE_Y, px * BADGE_RADIUS, TRANSPARENT, TAU);
    ctx.fill();
  }

  return {
    setActivity(activity) {
      finish.set(activity);
      cue.set(activity);
    },
    setGaze(next) {
      gaze = next;
    },
    tick(dt) {
      time += dt;
      finish.step(dt);
      cue.step(dt);
      update(dt, false);
      paint(false);
    },
    still() {
      time = STILL_TIME;
      finish.settle();
      cue.settle();
      update(ONE, true);
      paint(true);
    },
  };
}

export function createCalcifer(canvas: HTMLCanvasElement, px: number, gain = DEFAULT_GAIN): Painter {
  return createCinemaCharacter(CALCIFER, canvas, px, gain);
}

export function createWalle(canvas: HTMLCanvasElement, px: number, gain = DEFAULT_GAIN): Painter {
  return createCinemaCharacter(WALLE, canvas, px, gain);
}

export function createTars(canvas: HTMLCanvasElement, px: number, gain = DEFAULT_GAIN): Painter {
  return createCinemaCharacter(TARS, canvas, px, gain);
}

export function createR2d2(canvas: HTMLCanvasElement, px: number, gain = DEFAULT_GAIN): Painter {
  return createCinemaCharacter(R2D2, canvas, px, gain);
}
