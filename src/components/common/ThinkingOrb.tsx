import { useEffect, useRef, type ReactElement } from "react";
import { thinkingDesignKind, type ThinkingDesign } from "../../lib/thinkingDesigns";
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
import { useThinkingDesignStore } from "../../state/thinkingDesignStore";
import { voiceLevel } from "../../lib/thinking/voice";

/**
 * The "something is working" mark, shown wherever an engine is actually running — an agent turn,
 * a story generation, a review stage, a wiki write. Never a generic loading spinner: work that
 * runs no model wears `LoaderCircle` instead.
 *
 * It has sixteen looks (`lib/thinkingDesigns`), chosen once in Settings and followed by every orb
 * in every window. `design` pins one look regardless of the setting — for the picker that previews
 * all of them.
 *
 * `activity` is what the run is doing, when the caller knows: the run card passes its phase, and
 * whether it has gone quiet, is stopping, has just finished or has just failed. Canvas designs light
 * up by it (the globe's spotlights while thinking, its scan while reading…); CSS designs read the
 * state off `data-state` and, while running, the kind of phase off `data-phase` (thinking, reading,
 * working, writing). A failed run turns every design red. Without it a mark simply runs.
 *
 * `aria-hidden`: it says nothing a screen reader can use. Every caller sits next to text that
 * already names what is running, and a second announcement per row would be noise.
 */
export function ThinkingOrb({
  size = "md",
  design,
  activity,
}: {
  size?: OrbSize;
  design?: ThinkingDesign;
  activity?: ThinkingActivity;
}) {
  const chosen = useThinkingDesignStore((s) => s.design);
  const look = design ?? chosen;
  const state = thinkingState(activity);
  const kind = thinkingDesignKind(look);
  const speaking = state === "run" && activity?.phase === "speak";
  const ref = useRef<HTMLSpanElement>(null);
  // While it speaks, the whole mark breathes with the voice: one value per frame, written straight
  // to a CSS variable on the shared ticker (visible marks only), so nothing re-renders.
  useEffect(() => {
    const el = ref.current;
    if (!speaking || !el) return;
    const off = register(el, {
      tick: () => el.style.setProperty("--cf-orb-voice", voiceLevel().toFixed(3)),
      still: () => el.style.setProperty("--cf-orb-voice", "0"),
      setActivity: () => {},
    });
    return () => {
      off();
      el.style.removeProperty("--cf-orb-voice");
    };
  }, [speaking]);
  return (
    <span
      ref={ref}
      className={`cf-orb cf-orb-${size} cf-orb--${look}${speaking ? " cf-orb--speaking" : ""}`}
      data-state={state === "run" ? undefined : state}
      // Only where it is read, and only while running: the canvas designs take the phase itself.
      data-phase={kind === "css" && state === "run" && activity?.phase ? phaseGroup(activity.phase) : undefined}
      aria-hidden="true"
    >
      {kind === "canvas" ? (
        // Keyed by look and size: a painter is built for one canvas at one size.
        <OrbCanvas key={`${look}-${size}`} design={look} px={ORB_PX[size]} activity={activity} />
      ) : (
        PARTS[look]
      )}
    </span>
  );
}

const PAINTERS: Partial<Record<ThinkingDesign, (canvas: HTMLCanvasElement, px: number) => Painter>> = {
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
};

/** The canvas designs that draw speaking from the voice itself (`lib/thinking/voice`). */
const VOICE_AWARE = new Set<ThinkingDesign>(["orb", "wave"]);

function OrbCanvas({ design, px, activity }: { design: ThinkingDesign; px: number; activity?: ThinkingActivity }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const painter = useRef<Painter | null>(null);
  const latest = useRef(activity);
  latest.current = activity;

  useEffect(() => {
    const canvas = ref.current;
    const make = PAINTERS[design];
    if (!canvas || !make) return;
    const p = make(canvas, px);
    p.setActivity(latest.current);
    painter.current = p;
    const off = register(canvas, p);
    return () => {
      off();
      p.destroy?.();
      painter.current = null;
    };
  }, [design, px]);

  // Primitives, so a caller passing a fresh object each render does not re-run this. Speaking is
  // drawn as writing by the designs that have no voice of their own; the two that do (the orb's
  // shader, the waves) take the phase and the voice's loudness themselves.
  const phase = activity?.phase === "speak" && !VOICE_AWARE.has(design) ? "write" : activity?.phase;
  const quiet = activity?.quiet;
  const done = activity?.done;
  const failed = activity?.failed;
  const stopping = activity?.stopping;
  useEffect(() => {
    const p = painter.current;
    if (!p) return;
    p.setActivity({ phase, quiet, done, failed, stopping });
    // With no loop running, the still frame is the only frame — repaint it in the new state.
    if (prefersReducedMotion()) p.still();
  }, [phase, quiet, done, failed, stopping]);

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
    <span className="cf-orb-halo">
      <span className="cf-orb-halo-glow" />
      <span className="cf-orb-halo-glow cf-orb-halo-glow-2" />
    </span>
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
