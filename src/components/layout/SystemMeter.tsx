import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useT } from "../../state/languageStore";
import { formatBytes, loadSeverity, useSystemLoadStore } from "../../state/systemLoadStore";

const PANEL_WIDTH = 244;

/** How long the pointer must rest on the group before the panel opens. Long enough that crossing
 *  the bar on the way to the notification bell doesn't flash it open. */
const OPEN_DELAY = 140;

/** The colour at each level. The battery's three, deliberately — one glance across the bar should
 *  read by colour without having to know which widget it came from. */
const TINT: Record<ReturnType<typeof loadSeverity>, string | undefined> = {
  normal: undefined,
  high: "text-[#f59e0b]",
  critical: "text-[#ef4444]",
};

/**
 * CPU, memory and disk — the machine's, in the bar; this app's, in the panel behind it.
 *
 * **The bar answers "is this machine busy", the panel answers "is it us".** That is the actual
 * sequence someone goes through when the fan spins up, and it is why the app's own figures are not
 * on the bar: three more numbers would double the width and answer a question nobody has asked yet.
 * Both halves come from a single backend refresh (see `sysload.rs`), so the panel can never say the
 * app is using more than the machine.
 *
 * One panel for three pills rather than three tooltips: the three readings are one question, and a
 * reader comparing "the machine is at 90% and we are at 4%" should not have to hover twice to do
 * it. The whole group is one hover target for the same reason.
 */
export function SystemMeter() {
  const t = useT();
  const load = useSystemLoadStore((s) => s.load);
  const watch = useSystemLoadStore((s) => s.watch);
  const watchDetail = useSystemLoadStore((s) => s.watchDetail);

  const groupRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ bottom: number; right: number } | null>(null);

  useEffect(() => watch(), [watch]);

  // The "this app" half of the panel is the only thing in the app that reads `app_cpu_percent`,
  // `app_mem` and `app_processes`, and computing them means walking every process on the machine.
  // Asking only while the panel is actually open is the difference between paying that every 2.5
  // seconds for as long as the window is up, and paying it while someone is reading it. The
  // refresh this triggers on open is what makes the figures current rather than one poll old.
  useEffect(() => (open ? watchDetail() : undefined), [open, watchDetail]);

  const reposition = useCallback(() => {
    const rect = groupRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Upward: this lives in a footer pinned to the bottom of the window, so there is never room
    // below it. Same geometry as the battery and the limits panel beside it.
    setPos({ bottom: window.innerHeight - rect.top + 6, right: Math.max(8, window.innerWidth - rect.right) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onMove = () => reposition();
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open, reposition]);

  const clearTimer = () => {
    if (timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = null;
  };

  // Cleared on unmount as well as on leave: a pending open whose component has gone would set state
  // on nothing, and the bar unmounts whenever the window does.
  useEffect(() => clearTimer, []);

  if (!load) return null;

  const enter = () => {
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY);
  };
  const leave = () => {
    clearTimer();
    setOpen(false);
  };

  return (
    <>
      {/* Tighter than the bar's own spacing, and deliberately without the hairline that separates
          everything else in that row: these three are one reading of one machine and one hover
          target, so the rule belongs around the group rather than inside it. */}
      <div
        ref={groupRef}
        data-tour="system-meter"
        className="flex shrink-0 items-center gap-0.5"
        onPointerEnter={enter}
        onPointerLeave={leave}
      >
        <Pill icon={Cpu} percent={load.cpu_percent} label={t("sysload.cpu")} />
        <Pill icon={MemoryStick} percent={load.mem_percent} label={t("sysload.memory")} />
        <Pill icon={HardDrive} percent={load.disk_percent} label={t("sysload.disk")} />
      </div>

      {open &&
        pos &&
        createPortal(
          <div
            style={{ bottom: pos.bottom, right: pos.right, width: PANEL_WIDTH }}
            // `pointer-events-none`: it opens on hover and closes when the pointer leaves the pills,
            // so a panel that could be entered would be a panel that flickers at its own edge.
            className="cf-fade-in pointer-events-none fixed z-[60] overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] px-3 py-2.5 shadow-[var(--cf-shadow)]"
          >
            <p className="text-[12px] font-semibold">{t("sysload.machine")}</p>
            <div className="mt-1.5 space-y-1">
              <Row
                label={t("sysload.cpu")}
                percent={load.cpu_percent}
                detail={t("sysload.cores", { n: load.cpu_cores })}
              />
              <Row
                label={t("sysload.memory")}
                percent={load.mem_percent}
                detail={`${formatBytes(load.mem_used)} / ${formatBytes(load.mem_total)}`}
              />
              <Row
                label={t("sysload.disk")}
                percent={load.disk_percent}
                // The free figure rather than the used one, because "92%" already said used and the
                // question behind looking is whether there is room left.
                detail={t("sysload.free", { size: formatBytes(load.disk_total - load.disk_used) })}
              />
            </div>

            {/* The reason the panel exists. Kept under a rule and named after the app rather than
                labelled "process", because what is being reported is not one process — see below. */}
            <p className="mt-2 border-t border-[var(--cf-border)] pt-2 text-[12px] font-semibold">
              {t("sysload.thisApp")}
            </p>
            {/* Both rows carry a bar against the machine's own total, so the two halves of this
                panel are read with one ruler: "the box is at 71%, and 4 of that is us" is the
                comparison being made, and it cannot be made against a bare size. */}
            <div className="mt-1.5 space-y-1">
              <Row label={t("sysload.cpu")} percent={load.app_cpu_percent} />
              <Row
                label={t("sysload.memory")}
                percent={load.app_mem_percent}
                detail={formatBytes(load.app_mem)}
              />
            </div>
            {/* Said plainly, because the number is otherwise surprising: an idle app reads 1% and an
                agent run reads 300%, and the difference is the CLI subprocesses this launched. */}
            <p className="mt-1.5 text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
              {t("sysload.appIncludes", { n: load.app_processes })}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}

/** One reading on the bar. Tinted by its own level, so a machine short of disk says so without the
 *  other two shouting along with it. */
function Pill({
  icon: Icon,
  percent,
  label,
}: {
  icon: typeof Cpu;
  percent: number;
  label: string;
}) {
  const tint = TINT[loadSeverity(percent)];
  return (
    <span
      // Not a button. Every other item on this bar does something when pressed, and a control that
      // looks pressable and isn't is worse than a label — so this reads as a label, and the hover
      // that opens the panel belongs to the group.
      aria-label={`${label} ${Math.round(percent)}%`}
      className={`flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-[11px] tabular-nums ${
        tint ?? "text-[var(--cf-text-muted)]"
      }`}
    >
      <Icon size={12} className="shrink-0" />
      {/* Fixed width, right-aligned: these change every couple of seconds, and three digits
          appearing under two would shuffle the three pills and the battery beside them. */}
      <span className="w-[27px] text-right">{Math.round(percent)}%</span>
    </span>
  );
}

/**
 * One row in the panel: a name, a bar, whatever explains it, and the figure.
 *
 * Every row is a share of the same machine — the app's memory included, which is the point of
 * having it here rather than as a bare "180 MB". A size alone answers "how much" and the question
 * this panel is open for is "how much **of it**".
 */
function Row({ label, percent, detail }: { label: string; percent: number; detail?: string }) {
  const severity = loadSeverity(percent);
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className="w-[52px] shrink-0 text-[var(--cf-text-muted)]">{label}</span>
      <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-black/[0.08] dark:bg-white/[0.1]">
        {/* A floor of 2%, so a machine at 0.4% still draws something. A bar that is empty at a
            non-zero reading looks like a bar that failed to load. */}
        <span
          className={`block h-full rounded-full transition-[width] duration-300 ${
            severity === "critical"
              ? "bg-[#ef4444]"
              : severity === "high"
                ? "bg-[#f59e0b]"
                : "bg-[var(--cf-accent)]"
          }`}
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      </span>
      {detail && <span className="shrink-0 text-[10.5px] text-[var(--cf-text-muted)]">{detail}</span>}
      {/* One decimal under 10, none above: a figure that is 0.3 today and 41 tomorrow needs the
          precision only at the bottom of the range, and "41.0%" is two characters of noise. */}
      <span className="shrink-0 tabular-nums text-[var(--cf-text)]">
        {percent.toFixed(percent < 10 ? 1 : 0)}%
      </span>
    </div>
  );
}
