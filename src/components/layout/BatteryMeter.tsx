import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Battery, BatteryCharging, BatteryFull, BatteryLow, BatteryWarning, Plug } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useDismissOnOutside } from "../../lib/useDismissOnOutside";
import { batterySeverity, formatRunway, usePowerStore } from "../../state/powerStore";

const PANEL_WIDTH = 216;

/** The colour of the icon at each severity. Same three as the AI limits beside it, so one glance
 * across the status bar reads by colour without having to know which widget said it. */
const TINT: Record<ReturnType<typeof batterySeverity>, string | undefined> = {
  normal: undefined,
  low: "text-[#f59e0b]",
  critical: "text-[#ef4444]",
};

/**
 * Battery level, next to the AI limits.
 *
 * **A desktop draws nothing.** No battery is not a battery at 100% — it is a machine the question
 * does not apply to, and a permanently full icon is a pixel that never changes and stops being
 * read. The backend answers `null` for it and this renders nothing at all, which also covers the
 * read failing: the honest fallback for "we could not tell" is the same as for a desktop.
 *
 * It is a plain poll, unlike the AI limits beside it, and can afford to be: reading the battery is
 * a native call with no subprocess and no network, so nothing about it costs a provider a request
 * or — on Windows — flashes a console window over the user's work.
 */
export function BatteryMeter() {
  const t = useT();
  const status = usePowerStore((s) => s.status);
  const watch = usePowerStore((s) => s.watch);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  useEffect(() => watch(), [watch]);

  const reposition = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Upward: this sits in a footer pinned to the bottom of the window, so there is never room
    // below it. Same geometry as the limits panel two icons along.
    setPos({ bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  // The cable coming out, caught as a *transition* and not as a state. `plugged_in` being false is
  // the ordinary condition of a laptop and animating it would mean animating for ever; what is worth
  // one shot of motion is the moment it changes. `undefined` on the first reading is what keeps
  // opening the app on battery from replaying a disconnection that happened before it was running.
  const wasPluggedIn = useRef<boolean | undefined>(undefined);
  const [justUnplugged, setJustUnplugged] = useState(false);
  const pluggedIn = status?.plugged_in;

  useEffect(() => {
    if (pluggedIn === undefined) return;
    const previously = wasPluggedIn.current;
    wasPluggedIn.current = pluggedIn;
    if (previously !== true || pluggedIn) return;

    setJustUnplugged(true);
    // Cleared on a timer rather than on `animationend`: the class has to come off even when the
    // animation never ran at all, which is exactly what `prefers-reduced-motion` arranges.
    const done = setTimeout(() => setJustUnplugged(false), 700);
    return () => clearTimeout(done);
  }, [pluggedIn]);

  // The shared hook rather than a listener of this component's own, which is what this used to be:
  // it is the one that hears a press on a canvas — the diagram editor, the schema canvas — and a
  // panel left hanging over a drawing the user has gone back to is exactly the case that made it
  // shared. See `useDismissOnOutside`.
  const dismiss = useCallback(() => setOpen(false), []);
  useDismissOnOutside(open, dismiss, [panelRef, triggerRef]);

  if (!status) return null;

  const severity = batterySeverity(status.percent, status.plugged_in);
  // Floored, not rounded: 99.6% reading as 100 would claim a full battery that is not, and the
  // direction that matters here is the one it is heading in.
  const percent = Math.floor(Math.max(0, Math.min(100, status.percent)));
  const Icon = iconFor(status.charging, status.plugged_in, severity, percent);
  const motion = motionFor(status.charging, severity, justUnplugged);

  // "Plugged in" alone would leave the reader wondering why the number is not climbing. The OS says
  // "AC attached; not charging" for this state and it is worth passing that on verbatim in spirit:
  // the cable is in, and the battery is deliberately being held where it is.
  const state = status.charging
    ? t("battery.charging")
    : status.plugged_in
      ? t(percent >= 99 ? "battery.pluggedIn" : "battery.pluggedNotCharging")
      : t("battery.onBattery");
  // The runway lives in the panel, never in the pill: there is room for one number in a status bar
  // and it is the percentage. It is also the figure the OS is least sure of — absent entirely for
  // the first minutes after a cable moves — so a pill that showed it would keep changing width.
  const runway = status.minutes_left
    ? t(status.charging ? "battery.untilFull" : "battery.remaining", {
        time: formatRunway(status.minutes_left),
      })
    : "";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        title={t("battery.title")}
        className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums hover:bg-black/[0.05] dark:hover:bg-white/[0.08] ${
          TINT[severity] ?? "text-[var(--cf-text-muted)]"
        }`}
      >
        <Icon size={12} className={`shrink-0 ${motion}`} />
        <span>{percent}%</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            style={{ bottom: pos.bottom, right: pos.right, width: PANEL_WIDTH }}
            className="cf-fade-in fixed z-[60] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2.5 shadow-[var(--cf-shadow)]"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] font-semibold">{t("battery.title")}</span>
              <span className={`shrink-0 text-[12px] font-semibold tabular-nums ${TINT[severity] ?? ""}`}>
                {percent}%
              </span>
            </div>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{state}</p>

            {/* The estimate, which is the whole reason this panel exists — and the one number the
                OS refuses to give for minutes after a cable moves, or whenever it is plugged in and
                deliberately not charging. Saying so is better than an empty row: the reader is
                looking for a figure and needs to know nobody is withholding it on purpose. */}
            <p className="mt-2 border-t border-[var(--cf-border)] pt-2 text-[11px] leading-snug text-[var(--cf-text)]">
              {runway || t("battery.noEstimate")}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Which glyph to draw.
 *
 * **Being on mains always changes the icon**, whether or not the battery is taking charge. That is
 * the whole job of this widget and it was got wrong first time round: plugged-in-but-not-charging
 * fell through to the plain battery, so plugging the cable in changed nothing on screen and the
 * widget looked broken. It is not a rare state either — macOS reports exactly it ("AC attached; not
 * charging") whenever optimised charging, a charge limit or an underpowered adapter is holding the
 * battery where it is.
 *
 * So the three power states get three different glyphs, and none of them claims the others:
 * charging is the bolt, on-mains-and-idle is a plug, and running down is a battery whose fill says
 * how far down. */
function iconFor(
  charging: boolean,
  pluggedIn: boolean,
  severity: ReturnType<typeof batterySeverity>,
  percent: number,
) {
  if (charging) return BatteryCharging;
  // Full is only drawn on mains, and only when it really is full: a machine plugged in at 80% is
  // charging or holding, not full, and an icon that says otherwise is one people learn to distrust.
  if (pluggedIn) return percent >= 99 ? BatteryFull : Plug;
  if (severity === "critical") return BatteryWarning;
  if (severity === "low") return BatteryLow;
  return Battery;
}

/** Which of the four animations the icon is wearing, if any.
 *
 * They are mutually exclusive and the order is the priority. The one-shot disconnection wins
 * outright: it is the only one describing something that just *happened* rather than a condition
 * that is merely true, and a level warning has the rest of the battery's life to be seen. Charging
 * comes next because a machine filling up is not running out however low it is — animating alarm
 * over a battery that is being fixed is how a widget teaches people to ignore it.
 *
 * `severity` is already plug-aware (`batterySeverity` returns `normal` on mains), so nothing here
 * has to re-check the cable.
 */
function motionFor(
  charging: boolean,
  severity: ReturnType<typeof batterySeverity>,
  justUnplugged: boolean,
): string {
  if (justUnplugged) return "cf-battery-unplug";
  if (charging) return "cf-battery-charge";
  if (severity === "critical") return "cf-battery-alarm";
  if (severity === "low") return "cf-battery-breath";
  return "";
}
