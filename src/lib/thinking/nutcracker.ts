import { phaseGroup, thinkingState, type ThinkingActivity } from "./activity";
import { cueClock, startle } from "./cue";
import { blink, INK, lipSync, lookFor, strokeEye, WHITE, type Gaze } from "./face";
import { easeOut, finishClock, rgba, TAU } from "./finish";
import { listenLevel } from "./listen";
import { palette, type Rgb } from "./palette";
import { prepareCanvas, type Painter } from "./ticker";
import { voiceLevel } from "./voice";

type ToyRect = readonly [number, number, number, number];
type ToyEllipse = readonly [number, number, number, number];
type ToyPoint = readonly [number, number];

const ZERO = 0;
const ONE = 1;
const HALF = 0.5;
const FIRST_POINT = 0;
const NEXT_POINT = 1;
const REST_TIME = 0;
const DEFAULT_GAIN = 1;
const RUN_STATE = "run";
const DONE_STATE = "done";
const FAILED_STATE = "failed";
const QUIET_STATE = "quiet";
const STOPPING_STATE = "stopping";
const SPEAK_PHASE = "speak";
const LISTEN_PHASE = "listen";
const FAILED_EYES = "x";
const HAPPY_EYES = "happy";
const CLOSED_EYES = "closed";
const WAKE_BOB = 0.035;
const THINK_BOB = 0.014;
const BOB_RATE = 3;
const MARCH_RATE = 7;
const MARCH_ANGLE = 0.46;
const ASK_ANGLE = 0.08;
const SALUTE_ANGLE = -2.25;
const SLEEP_ANGLE = 0.08;
const SLEEP_OPACITY = 0.65;
const FINISH_SECONDS = 1.6;
const SNOW_FALL_RATE = 0.1;
const SNOW_RADIUS = 0.009;
const SNOW_END_FADE = 0.75;
const GAZE_DISTANCE = 0.014;
const PUPIL_RADIUS = 0.012;
const EYE_RADIUS = 0.019;
const EYE_LINE_WIDTH = 0.009;
const EYE_Y = 0.403;
const EYE_X = [0.419, 0.581] as const;
const FACE_NOSE: ToyEllipse = [0.5, 0.465, 0.033, 0.045];
const TOY_FACE: ToyRect = [0.345, 0.315, 0.31, 0.29];
const FACE_HIGHLIGHT: ToyRect = [0.36, 0.325, 0.028, 0.16];
const HAT: ToyRect = [0.305, 0.075, 0.39, 0.225];
const HAT_HIGHLIGHT: ToyRect = [0.323, 0.085, 0.028, 0.18];
const HAT_TOP: ToyRect = [0.29, 0.065, 0.42, 0.025];
const HAT_BAND: ToyRect = [0.295, 0.265, 0.41, 0.036];
const HAT_BRIM: ToyRect = [0.265, 0.298, 0.47, 0.026];
const HAT_BADGE: ToyEllipse = [0.5, 0.171, 0.056, 0.061];
const BADGE_CENTER: ToyEllipse = [0.5, 0.171, 0.021, 0.026];
const HAIR: readonly ToyEllipse[] = [
  [0.316, 0.375, 0.046, 0.055],
  [0.304, 0.448, 0.046, 0.06],
  [0.315, 0.521, 0.048, 0.055],
  [0.684, 0.375, 0.046, 0.055],
  [0.696, 0.448, 0.046, 0.06],
  [0.685, 0.521, 0.048, 0.055],
];
const COAT: ToyRect = [0.335, 0.625, 0.33, 0.218];
const COAT_CENTER: ToyRect = [0.485, 0.642, 0.03, 0.19];
const BELT: ToyRect = [0.33, 0.792, 0.34, 0.033];
const BELT_BUCKLE: ToyRect = [0.472, 0.788, 0.056, 0.041];
const COLLAR: ToyRect = [0.4, 0.614, 0.2, 0.034];
const LEGS: readonly ToyRect[] = [[0.365, 0.835, 0.1, 0.095], [0.535, 0.835, 0.1, 0.095]];
const BOOTS: readonly ToyRect[] = [[0.33, 0.923, 0.135, 0.035], [0.535, 0.923, 0.135, 0.035]];
const BUTTONS: readonly ToyEllipse[] = [
  [0.411, 0.686, 0.014, 0.014], [0.589, 0.686, 0.014, 0.014],
  [0.411, 0.745, 0.014, 0.014], [0.589, 0.745, 0.014, 0.014],
];
const LEFT_ARM_PIVOT: ToyPoint = [0.281, 0.67];
const ARM_PIVOT: ToyPoint = [0.7, 0.67];
const RIGHT_ARM: ToyRect = [-0.035, -0.018, 0.07, 0.15];
const RIGHT_CUFF: ToyRect = [-0.039, 0.1, 0.078, 0.027];
const RIGHT_HAND: ToyEllipse = [0, 0.15, 0.035, 0.034];
const SHOULDERS: readonly ToyRect[] = [[0.24, 0.635, 0.1, 0.04], [0.66, 0.635, 0.1, 0.04]];
const BEARD: readonly ToyPoint[] = [[0.355, 0.603], [0.645, 0.603], [0.61, 0.639], [0.5, 0.702], [0.39, 0.639]];
const MOUSTACHE: readonly ToyPoint[] = [
  [0.5, 0.496], [0.45, 0.485], [0.401, 0.514], [0.365, 0.507],
  [0.395, 0.547], [0.452, 0.548], [0.5, 0.524], [0.548, 0.548],
  [0.605, 0.547], [0.635, 0.507], [0.599, 0.514], [0.55, 0.485],
];
const MOUTH: ToyRect = [0.412, 0.558, 0.176, 0.045];
const TEETH: readonly ToyRect[] = [
  [0.424, 0.563, 0.046, 0.026], [0.477, 0.563, 0.046, 0.026], [0.53, 0.563, 0.046, 0.026],
];
const JAW_TRAVEL = 0.045;
const JAW_IDLE_RATE = 5;
const JAW_IDLE_RANGE = 0.25;
const SNOW: readonly ToyPoint[] = [[0.15, 0.12], [0.83, 0.25], [0.12, 0.56], [0.87, 0.7], [0.77, 0.04]];
const WOOD: Rgb = [241, 190, 143];
const WOOD_LIGHT: Rgb = [255, 216, 171];
const WOOD_NOSE: Rgb = [212, 139, 98];
const CHRISTMAS_RED: Rgb = [193, 48, 63];
const RED_LIGHT: Rgb = [231, 83, 86];
const GOLD: Rgb = [239, 191, 84];
const NAVY: Rgb = [43, 59, 99];

export function createNutcracker(canvas: HTMLCanvasElement, px: number, gain = DEFAULT_GAIN): Painter {
  const ctx = prepareCanvas(canvas, px);
  const clock = finishClock();
  const cue = cueClock();
  let time = REST_TIME;
  let gaze: Gaze = null;

  const rectangle = (shape: ToyRect, color: string) => {
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.fillRect(...shape);
  };
  const ellipse = (shape: ToyEllipse, color: string) => {
    if (!ctx) return;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(...shape, ZERO, ZERO, TAU);
    ctx.fill();
  };
  const polygon = (points: readonly ToyPoint[], color: string) => {
    if (!ctx) return;
    const first = points[FIRST_POINT];
    const rest = points.slice(NEXT_POINT);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(...first);
    for (const point of rest) ctx.lineTo(...point);
    ctx.closePath();
    ctx.fill();
  };

  const paint = (frozen: boolean) => {
    if (!ctx) return;
    const colors = palette();
    const activity = clock.act;
    const state = thinkingState(activity);
    const running = state === RUN_STATE;
    const quiet = state === QUIET_STATE || state === STOPPING_STATE;
    const done = state === DONE_STATE;
    const failed = state === FAILED_STATE;
    const moving = running && !frozen;
    const group = phaseGroup(activity?.phase);
    const marching = group === "work" || group === "write";
    const speaking = activity?.phase === SPEAK_PHASE;
    const listening = activity?.phase === LISTEN_PHASE;
    const voice = speaking && moving ? voiceLevel() : ZERO;
    const hearing = listening && moving ? listenLevel() : ZERO;
    const syllable = lipSync(voice);
    const jawPulse = Math.sin(time * JAW_IDLE_RATE);
    const jawIdle = moving && !listening && !speaking ? (ONE + jawPulse) * JAW_IDLE_RANGE : ZERO;
    const jaw = Math.min(ONE, syllable * gain + jawIdle) * JAW_TRAVEL;
    const wake = startle(cue.wake);
    const bobWave = Math.sin(time * BOB_RATE);
    // The rail supplies no phase: keep a toy-soldier march there too, with a periodic salute.
    // Conversation and reading get quieter poses so the voice and gaze stay readable.
    const attention = speaking || listening || group === "read";
    const marchWave = Math.sin(time * MARCH_RATE);
    const march = moving && !attention ? (marching ? ONE : 0.8) * (ONE - cue.ask * 0.85) : ZERO;
    const saluteWave = (ONE + Math.sin(time * 1.25 - 1.6)) * HALF;
    const greeting = moving && !attention ? easeOut((saluteWave - 0.82) / 0.18) : ZERO;
    const salute = done ? SALUTE_ANGLE : greeting * (SALUTE_ANGLE + Math.sin(time * 11) * 0.12);
    const bounce = done && !frozen ? Math.sin(clock.fin * 10) * Math.exp(-clock.fin * 3) * 0.035 : ZERO;
    const bob = (moving ? bobWave * THINK_BOB - Math.abs(marchWave) * march * 0.022 - (wake + hearing) * WAKE_BOB : ZERO) - bounce;
    const tilt = quiet ? SLEEP_ANGLE : moving ? cue.ask * ASK_ANGLE + marchWave * march * 0.035 : ZERO;
    const look = gaze ?? lookFor(activity?.phase, time);
    const lookX = moving ? look[FIRST_POINT] * GAZE_DISTANCE : ZERO;
    const lookY = moving ? look[NEXT_POINT] * GAZE_DISTANCE : ZERO;
    const eyeBlink = moving ? blink(time) : ONE;
    const coatColor = failed ? colors.danger : done ? colors.success : CHRISTMAS_RED;
    const coat = rgba(coatColor, ONE);
    const redLight = rgba(RED_LIGHT, ONE);
    const wood = rgba(WOOD, ONE);
    const woodLight = rgba(WOOD_LIGHT, ONE);
    const nose = rgba(WOOD_NOSE, ONE);
    const gold = rgba(GOLD, ONE);
    const navy = rgba(NAVY, ONE);
    const white = rgba(WHITE, ONE);
    const ink = rgba(INK, ONE);
    const badge = rgba(colors.a, ONE);

    ctx.clearRect(ZERO, ZERO, px, px);
    ctx.save();
    ctx.scale(px, px);
    ctx.translate(HALF, HALF + bob);
    ctx.rotate(tilt);
    ctx.translate(-HALF, -HALF);
    ctx.globalAlpha = quiet ? SLEEP_OPACITY : ONE;
    for (const [index, leg] of LEGS.entries()) {
      const side = index === 0 ? -ONE : ONE;
      const step = side * marchWave * march;
      const pivotX = leg[0] + leg[2] * HALF;
      ctx.save();
      ctx.translate(pivotX, leg[1] - Math.max(ZERO, step) * 0.045);
      ctx.rotate(step * 0.42);
      ctx.translate(-pivotX, -leg[1]);
      rectangle(leg, navy);
      rectangle(BOOTS[index], ink);
      ctx.restore();
    }
    rectangle(COAT, coat);
    rectangle(COAT_CENTER, gold);
    rectangle(BELT, ink);
    rectangle(BELT_BUCKLE, gold);
    rectangle(COLLAR, gold);
    for (const button of BUTTONS) ellipse(button, gold);
    ctx.save();
    ctx.translate(...LEFT_ARM_PIVOT);
    ctx.rotate(-marchWave * march * MARCH_ANGLE - (speaking ? syllable * 0.35 : ZERO));
    rectangle(RIGHT_ARM, coat);
    rectangle(RIGHT_CUFF, gold);
    ellipse(RIGHT_HAND, wood);
    ctx.restore();
    ctx.save();
    ctx.translate(...ARM_PIVOT);
    ctx.rotate(salute + marchWave * march * MARCH_ANGLE * (ONE - greeting) + (listening ? 0.5 + hearing * 0.3 : ZERO));
    rectangle(RIGHT_ARM, coat);
    rectangle(RIGHT_CUFF, gold);
    ellipse(RIGHT_HAND, wood);
    ctx.restore();
    for (const shoulder of SHOULDERS) rectangle(shoulder, gold);
    for (const curl of HAIR) ellipse(curl, white);
    rectangle(TOY_FACE, wood);
    rectangle(FACE_HIGHLIGHT, woodLight);
    rectangle(HAT, coat);
    rectangle(HAT_HIGHLIGHT, redLight);
    rectangle(HAT_TOP, gold);
    rectangle(HAT_BAND, gold);
    rectangle(HAT_BRIM, ink);
    ellipse(HAT_BADGE, gold);
    ellipse(BADGE_CENTER, badge);
    for (const eyeX of EYE_X) {
      if (quiet || failed || done) {
        const eyeKind = failed ? FAILED_EYES : done ? HAPPY_EYES : CLOSED_EYES;
        strokeEye(ctx, eyeX, EYE_Y, EYE_RADIUS, eyeKind, ink, EYE_LINE_WIDTH);
      } else {
        const eye: ToyEllipse = [eyeX + lookX, EYE_Y + lookY, PUPIL_RADIUS, PUPIL_RADIUS * eyeBlink];
        ellipse(eye, ink);
      }
    }
    ellipse(FACE_NOSE, nose);
    polygon(MOUSTACHE, ink);
    // The actual wooden jaw and beard slide together, revealing a dark mouth cavity.
    rectangle([MOUTH[0], MOUTH[1], MOUTH[2], MOUTH[3] + jaw], ink);
    for (const tooth of TEETH) rectangle(tooth, white);
    ctx.save();
    ctx.translate(ZERO, jaw);
    polygon(BEARD, white);
    rectangle([0.419, 0.598, 0.162, 0.013], white);
    ctx.restore();
    if (done && !frozen) {
      const progress = clock.fin / FINISH_SECONDS;
      const snowAlpha = Math.max(ZERO, ONE - progress * SNOW_END_FADE);
      const snowColor = rgba(WHITE, snowAlpha);
      const snowFall = time * SNOW_FALL_RATE;
      for (const [snowX, snowY] of SNOW) {
        const fallingY = (snowY + snowFall) % ONE;
        const snowflake: ToyEllipse = [snowX, fallingY, SNOW_RADIUS, SNOW_RADIUS];
        ellipse(snowflake, snowColor);
      }
    }
    ctx.restore();
  };

  return {
    tick(dt) {
      time += dt;
      clock.step(dt);
      cue.step(dt);
      paint(false);
    },
    still() {
      clock.settle();
      cue.settle();
      paint(true);
    },
    setActivity(activity: ThinkingActivity | undefined) {
      clock.set(activity);
      cue.set(activity);
    },
    setGaze(next) {
      gaze = next;
    },
  };
}
