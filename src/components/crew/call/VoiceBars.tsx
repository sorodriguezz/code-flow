import { useEffect, useRef } from "react";

const BARS = 13;
/** Where each bar sits in the wave: tallest in the middle, like a voice drawn. */
const SHAPE = Array.from({ length: BARS }, (_, i) => 0.35 + 0.65 * Math.sin(((i + 0.5) / BARS) * Math.PI));
const IDLE = 2;
/** How tall the tallest bar gets, how wide a bar is and how far apart, and the row's height. */
const SIZES = {
  md: { tallest: 22, bar: 3, gap: 3, row: 24 },
  lg: { tallest: 46, bar: 5, gap: 5, row: 52 },
} as const;

/**
 * A participant's voice, drawn: bars that move by how loud it is right now.
 *
 * `level` is read every frame while `active` — it changes far faster than React should render —
 * and the bars are moved directly. At rest they are a dotted line, so every tile has the same row
 * and the one that is speaking is the one that moves.
 */
export function VoiceBars({ level, active, color = "var(--cf-accent)", size = "md" }: { level: () => number; active: boolean; color?: string; size?: keyof typeof SIZES }) {
  const row = useRef<HTMLSpanElement>(null);
  const { tallest: TALLEST, bar, gap, row: height } = SIZES[size];
  useEffect(() => {
    const bars = row.current ? [...row.current.children] as HTMLElement[] : [];
    const rest = () => bars.forEach((bar) => { bar.style.height = `${IDLE}px`; });
    if (!active) {
      rest();
      return;
    }
    // Asked not to move: a steady wave says who is speaking without moving.
    if (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches) {
      bars.forEach((bar, i) => { bar.style.height = `${IDLE + SHAPE[i] * TALLEST * 0.5}px`; });
      return rest;
    }
    let frame = 0;
    let smooth = 0;
    const draw = (now: number) => {
      // Up at once, down slowly: a voice that drops between words does not flicker.
      const heard = Math.min(1, Math.max(0, level()));
      smooth = heard > smooth ? heard : smooth * 0.86 + heard * 0.14;
      bars.forEach((bar, i) => {
        const ripple = 0.6 + 0.4 * Math.sin(now / 90 + i * 1.7);
        bar.style.height = `${IDLE + smooth * SHAPE[i] * ripple * TALLEST}px`;
      });
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      rest();
    };
  }, [active, level, TALLEST]);
  return (
    <span ref={row} aria-hidden className="flex items-center justify-center" style={{ height, gap }}>
      {SHAPE.map((_, i) => (
        <span key={i} className="rounded-full transition-[background-color,opacity] duration-200" style={{ width: bar, height: IDLE, background: active ? color : "var(--cf-text-faint)", opacity: active ? 1 : 0.45 }} />
      ))}
    </span>
  );
}
