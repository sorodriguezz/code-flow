import { useEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactElement } from "react";
import { thinkingDesignKind, thinkingSpeaksItself, type ThinkingDesign } from "../../lib/thinkingDesigns";
import { phaseGroup, thinkingState, type ThinkingActivity } from "../../lib/thinking/activity";
import { ORB_PX, register, prefersReducedMotion, type OrbSize, type Painter } from "../../lib/thinking/ticker";
import { createSphere } from "../../lib/thinking/sphere";
import { createOrb } from "../../lib/thinking/orb";
import { createNetwork } from "../../lib/thinking/network";
import { createWave } from "../../lib/thinking/wave";
import { createLiquid } from "../../lib/thinking/liquid";
import { createCrystal } from "../../lib/thinking/crystal";
import { createCat } from "../../lib/thinking/cat";
import { createPixels } from "../../lib/thinking/pixels";
import { createGhost } from "../../lib/thinking/ghost";
import { createCrab } from "../../lib/thinking/crab";
import { createMoon } from "../../lib/thinking/moon";
import { createAtom } from "../../lib/thinking/atom";
import { createSpark } from "../../lib/thinking/spark";
import { createCloud } from "../../lib/thinking/cloud";
import { createBulb } from "../../lib/thinking/bulb";
import { createAlien } from "../../lib/thinking/alien";
import { useThinkingDesignStore } from "../../state/thinkingDesignStore";
import { voiceLevel } from "../../lib/thinking/voice";
import { listenLevel } from "../../lib/thinking/listen";
import { gazeAt, nearness, watchPointer } from "../../lib/thinking/pointer";

/**
 * The "something is working" mark, shown wherever an engine is actually running — an agent turn,
 * a story generation, a review stage, a wiki write. Never a generic loading spinner: work that
 * runs no model wears `LoaderCircle` instead.
 *
 * It has twenty looks (`lib/thinkingDesigns`), chosen once in Settings and followed by every orb
 * in every window. `design` pins one look regardless of the setting — for the picker that previews
 * all of them.
 *
 * `activity` is what the run is doing, when the caller knows: the run card passes its phase, and
 * whether it has gone quiet, is stopping, has just finished or has just failed. Canvas designs light
 * up by it (the globe's spotlights while thinking, its scan while reading…); CSS designs read the
 * state off `data-state` and, while running, the kind of phase off `data-phase` (thinking, reading,
 * working, writing). A failed run turns every design red. Without it a mark simply runs.
 *
 * `follow` makes the mark notice the pointer, wherever it is in the window — for the assistant's
 * button on the rail (the user: "que siga el mouse con los ojos", and then for the designs with no
 * eyes, "¿qué se puede hacer?"). The designs with eyes — the robot, the blob, the LED face and the
 * characters — look at it instead of looking around; the rest turn to it each in their own way: the
 * globe, the crystal and the atom tip toward it, the drops are drawn to it, the orb's light and the
 * halo's glow swing round to its side, the plasma's lights drift there, the wave's crest leans its
 * way, the net lights up on that side and fires toward it, the moon turns its face. Out of the
 * window, they go back to what they were doing. And every one of them perks up as the pointer comes
 * close (`nearness`): brighter, a soft glow, and running a little faster — as if about to be
 * clicked. None of it while the run is ending or resting, nor for a reader who asked for reduced
 * motion.
 *
 * Codi, the voice assistant, wears it too, big (`size="hero"`) in a window of its own. There it
 * listens (`phase: "listen"`), every design drawing the microphone's level *in* — the characters
 * perk up and look at whoever speaks, mouths shut; the rest pull their light or their shape inward
 * — where speaking pushes it out. Its cues (`activity.cue`) play on top: a startle when the wake word
 * is heard, a waiting pose while a question waits on the user. `gain` (Codi passes about 2.2)
 * multiplies how far every speaking and listening reaction goes — the voice's pulse, the mouths, each
 * design's own cue — each clamped so nothing leaves the square; at 1 they are what they always were.
 *
 * `aria-hidden`: it says nothing a screen reader can use. Every caller sits next to text that
 * already names what is running, and a second announcement per row would be noise.
 */
export function ThinkingOrb({
  size = "md",
  design,
  activity,
  follow = false,
  gain = 1,
}: {
  size?: OrbSize;
  design?: ThinkingDesign;
  activity?: ThinkingActivity;
  follow?: boolean;
  /** How far the speaking and listening reactions go, 1 as everywhere in the app. Past 3 every one
   *  of them is at its ceiling anyway. */
  gain?: number;
}) {
  const chosen = useThinkingDesignStore((s) => s.design);
  const look = design ?? chosen;
  const state = thinkingState(activity);
  const kind = thinkingDesignKind(look);
  const css = kind === "css";
  const speaking = state === "run" && activity?.phase === "speak";
  const listening = state === "run" && activity?.phase === "listen";
  const amp = Math.max(0, Math.min(3, Number.isFinite(gain) ? gain : 1));
  const ref = useRef<HTMLSpanElement>(null);
  /** How close the pointer is, 0–1, while following — read by the canvas loop to run faster. */
  const near = useRef(0);
  // While it speaks, the whole mark breathes with the voice: one value per frame, written straight
  // to a CSS variable on the shared ticker (visible marks only), so nothing re-renders. While a CSS
  // design listens it is handed the microphone's level the same way, which its own listening look
  // reads; the canvas designs read it themselves.
  const level = speaking ? "voice" : listening && css ? "listen" : null;
  useEffect(() => {
    const el = ref.current;
    if (!level || !el) return;
    const name = level === "voice" ? "--cf-orb-voice" : "--cf-orb-listen";
    const read = level === "voice" ? voiceLevel : listenLevel;
    const off = register(el, {
      tick: () => el.style.setProperty(name, read().toFixed(3)),
      still: () => el.style.setProperty(name, "0"),
      setActivity: () => {},
    });
    return () => {
      off();
      el.style.removeProperty(name);
    };
  }, [level]);
  // A CSS design's cues play on a wrapper of their own round its parts (`.cf-orb-cue`), whose
  // animations are the cues' alone — the parts' loops own theirs. A wake runs once when `data-cue`
  // arrives, so a second wake word, while the first's cue is still set, remounts the wrapper to play
  // it again: keyed by the latest wake's `at`, kept after the cue clears, so going back to listening
  // does not restart every loop the parts are running.
  const wakeAt = activity?.cue?.kind === "wake" ? activity.cue.at : undefined;
  const [lastWake, setLastWake] = useState(wakeAt);
  if (wakeAt !== undefined && wakeAt !== lastWake) setLastWake(wakeAt);
  // Following: how close the pointer is (`--cf-near` and `data-near`, which every design's glow
  // reads), and for the CSS designs where it is too (`--cf-gaze-x/y` while `data-gaze` is set) and
  // how fast they run — written straight onto the element each frame the pointer moves, so nothing
  // re-renders. The canvas designs are told where it is by their own painter (`OrbCanvas`).
  useEffect(() => {
    const el = ref.current;
    if (!follow || !el || prefersReducedMotion()) return;
    el.setAttribute("data-follow", "");
    const pace = (rate: number) => {
      // CSS animations only, not the transitions: the glow's own fade keeps its pace.
      for (const animation of el.getAnimations({ subtree: true })) {
        if ("animationName" in animation && animation.playbackRate !== rate) animation.playbackRate = rate;
      }
    };
    const off = watchPointer((at) => {
      const rect = el.getBoundingClientRect();
      const close = at ? nearness(rect, at.x, at.y) : 0;
      near.current = close;
      if (close > 0) {
        el.style.setProperty("--cf-near", close.toFixed(3));
        el.setAttribute("data-near", "");
      } else el.removeAttribute("data-near");
      if (!css) return;
      const gaze = at && gazeAt(rect, at.x, at.y);
      if (gaze) {
        el.style.setProperty("--cf-gaze-x", gaze[0].toFixed(3));
        el.style.setProperty("--cf-gaze-y", gaze[1].toFixed(3));
        el.setAttribute("data-gaze", "");
      } else el.removeAttribute("data-gaze");
      // Running only: a finish or a failure plays at its own speed.
      pace(el.hasAttribute("data-state") ? 1 : 1 + RUSH * close);
    });
    return () => {
      off();
      near.current = 0;
      pace(1);
      for (const name of ["data-follow", "data-near", "data-gaze"]) el.removeAttribute(name);
    };
  }, [follow, css]);
  return (
    <span
      ref={ref}
      className={`cf-orb cf-orb-${size} cf-orb--${look}${speaking ? " cf-orb--speaking" : ""}`}
      data-state={state === "run" ? undefined : state}
      // Only where it is read, and only while running: the canvas designs take the phase itself.
      data-phase={css && state === "run" && activity?.phase ? phaseGroup(activity.phase) : undefined}
      data-cue={css && state === "run" && activity?.cue ? activity.cue.kind : undefined}
      // Read by the CSS designs' speaking and listening rules; the painters are handed it.
      style={amp !== 1 ? ({ "--cf-orb-gain": String(amp) } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {kind === "canvas" ? (
        // Keyed by look and size: a painter is built for one canvas at one size.
        <OrbCanvas
          key={`${look}-${size}`}
          design={look}
          px={ORB_PX[size]}
          gain={amp}
          activity={activity}
          follow={follow}
          near={near}
        />
      ) : (
        <span key={lastWake ?? 0} className="cf-orb-cue">
          {PARTS[look]}
        </span>
      )}
    </span>
  );
}

/** Each canvas design's painter, built for one canvas at one size and one `gain`. */
const PAINTERS: Partial<Record<ThinkingDesign, (canvas: HTMLCanvasElement, px: number, gain: number) => Painter>> = {
  sphere: createSphere,
  orb: createOrb,
  network: createNetwork,
  wave: createWave,
  liquid: createLiquid,
  crystal: createCrystal,
  cat: createCat,
  pixels: createPixels,
  ghost: createGhost,
  crab: createCrab,
  moon: createMoon,
  atom: createAtom,
  spark: createSpark,
  cloud: createCloud,
  bulb: createBulb,
  alien: createAlien,
};

/** How much faster a mark runs with the pointer right on it: 1 + this, easing in as it comes close. */
const RUSH = 0.6;

function OrbCanvas({
  design,
  px,
  gain,
  activity,
  follow,
  near,
}: {
  design: ThinkingDesign;
  px: number;
  gain: number;
  activity?: ThinkingActivity;
  follow: boolean;
  /** How close the pointer is, 0–1 — the painter runs up to `1 + RUSH` times faster for it. */
  near: MutableRefObject<number>;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const painter = useRef<Painter | null>(null);
  const latest = useRef(activity);
  latest.current = activity;

  useEffect(() => {
    const canvas = ref.current;
    const make = PAINTERS[design];
    if (!canvas || !make) return;
    const p = make(canvas, px, gain);
    p.setActivity(latest.current);
    painter.current = p;
    // The pointer's nearness speeds the painter's clock while the run runs — eased, so the pace
    // gathers and lets go instead of jumping when the pointer leaves the window.
    let rate = 1;
    const off = register(canvas, {
      tick(dt) {
        const wanted = 1 + RUSH * (thinkingState(latest.current) === "run" ? near.current : 0);
        rate += (wanted - rate) * Math.min(1, dt * 4);
        p.tick(dt * rate);
      },
      still: () => p.still(),
      setActivity: (next) => p.setActivity(next),
    });
    return () => {
      off();
      p.destroy?.();
      painter.current = null;
    };
    // `gain` is fixed for a window (Codi's never changes it), so a new one simply rebuilds the painter.
  }, [design, px, gain, near]);

  // After the effect above, so it finds this canvas's painter — and runs again whenever that one is
  // rebuilt for another design, size or gain.
  useEffect(() => {
    const canvas = ref.current;
    const p = painter.current;
    if (!follow || !canvas || !p?.setGaze || prefersReducedMotion()) return;
    const off = watchPointer((at) => p.setGaze?.(at && gazeAt(canvas.getBoundingClientRect(), at.x, at.y)));
    return () => {
      off();
      p.setGaze?.(null);
    };
  }, [follow, design, px, gain]);

  // Primitives, so a caller passing a fresh object each render does not re-run this. Speaking is
  // drawn as writing by the designs that have no voice of their own; the ones that do (the orb's
  // shader, the waves, and the four mascots — Chispa, Nube, Bombilla, Marciano — each with a
  // lip-synced mouth) take the phase and the voice's loudness themselves (`voice` in
  // `lib/thinkingDesigns`). Listening is every design's own: each takes it as is. A cue goes by its
  // kind and `at`, so a new wake — a new `at` — reaches the painter even when nothing else changed.
  const phase = activity?.phase === "speak" && !thinkingSpeaksItself(design) ? "write" : activity?.phase;
  const quiet = activity?.quiet;
  const done = activity?.done;
  const failed = activity?.failed;
  const stopping = activity?.stopping;
  const cueKind = activity?.cue?.kind;
  const cueAt = activity?.cue?.at;
  useEffect(() => {
    const p = painter.current;
    if (!p) return;
    const cue = cueKind && cueAt !== undefined ? { kind: cueKind, at: cueAt } : undefined;
    p.setActivity({ phase, quiet, done, failed, stopping, cue });
    // With no loop running, the still frame is the only frame — repaint it in the new state.
    if (prefersReducedMotion()) p.still();
  }, [phase, quiet, done, failed, stopping, cueKind, cueAt]);

  return <canvas ref={ref} className="cf-orb-canvas" />;
}

/**
 * The elements each CSS design is drawn from, built once at module load — an orb re-rendering (its
 * row updating a timer, say) hands React the same elements and it skips them.
 */
const PARTS: Partial<Record<ThinkingDesign, ReactElement>> = {
  // The AI loader (21st.dev, @beratberkayg): a disc lit from inside by three hues, turning, its
  // colours drifting as a second layer fades over the first.
  halo: (
    <>
      <span className="cf-orb-halo">
        <span className="cf-orb-halo-glow" />
        <span className="cf-orb-halo-glow cf-orb-halo-glow-2" />
      </span>
      {/* Its light on the pointer's side while it follows — still while the disc turns. */}
      <span className="cf-orb-halo-lean" />
    </>
  ),
  // A little robot: the antenna blinks, the eyes look left, right, then up and to the side the way
  // someone does when working something out — and blink, out of step with the looking.
  bot: (
    <span className="cf-orb-bot">
      <span className="cf-orb-antenna" />
      <span className="cf-orb-head">
        <span className="cf-orb-visor">
          <span className="cf-orb-eyes">
            <span className="cf-orb-eye" />
            <span className="cf-orb-eye" />
          </span>
        </span>
      </span>
    </span>
  ),
  // A soft creature: two uneven blobs turning against each other read as one body changing shape;
  // its eyes stay put on top of it and glance up while it thinks.
  blob: (
    <span className="cf-orb-blob">
      <span className="cf-orb-goo" />
      <span className="cf-orb-goo cf-orb-goo-2" />
      <span className="cf-orb-gaze">
        <span className="cf-orb-pupil" />
        <span className="cf-orb-pupil" />
      </span>
    </span>
  ),
  // Three blurred lights drifting inside a sphere, the way voice assistants glow.
  plasma: (
    <span className="cf-orb-plasma">
      <span className="cf-orb-blot cf-orb-blot-1" />
      <span className="cf-orb-blot cf-orb-blot-2" />
      <span className="cf-orb-blot cf-orb-blot-3" />
      <span className="cf-orb-sheen" />
    </span>
  ),
};
