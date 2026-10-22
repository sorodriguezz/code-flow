import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { ChevronsDownUp, ChevronsUpDown, CornerDownLeft, X } from "lucide-react";
import { ThinkingOrb } from "../common/ThinkingOrb";
import { ViewSkeleton } from "../common/ViewSkeleton";
import { chipClass, fieldClass } from "../common/recipes";
import { iconButtonClass } from "../common/Button";
import { CodiSwitches } from "./CodiControls";
import { CodiActionLog, CodiConfirmCard, CodiTranscript } from "./CodiLog";
import { codiActivity, FLASH_MS, turnOutcome, WAKE_MS } from "./face";
import { showMainWindow } from "../../lib/tauri/windows";
import { sendTo } from "../../lib/windowBus";
import { MAIN_LABEL } from "../../lib/windowIdentity";
import { acceleratorKeycaps } from "../../lib/globalHotkey";
import { isMac } from "../../lib/platform";
import { motionLevel } from "../../lib/motion";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { CodiPhase } from "../../lib/tauri/codiCommands";
import { ensureCodiLevel, ensureCodiVoice, useCodiStore, type CodiMode } from "../../state/codiStore";
import { useT } from "../../state/languageStore";

/**
 * «Codi»'s window: its face, the two switches, what it heard and said, what it is asking, what it
 * did — and a field to type an order in when speaking is not an option.
 *
 * Frameless and always on top (`windows::open_codi`), so the strip at the top is the window's: it
 * is dragged by, says the name and how it listens, folds the log in and out and closes. Closing it
 * closes the microphone (the backend does it) — nothing listens unseen.
 *
 * # Why the strip is not `data-tauri-drag-region`
 *
 * The attribute also maximizes on a double click, and a maximized window that is always on top and
 * has no title bar covers the screen with no way back but finding this strip again. The press is
 * bound to the one thing the window needs, the way the ask box does it (`QuickAskWindow`): direct
 * hits only, the name and the mode chip's label let the press through.
 */

const MODE_KEY: Record<CodiMode, TranslationKey> = {
  wake: "codi.window.modeWake",
  conversation: "codi.window.modeConversation",
  ptt: "codi.window.modePtt",
};

const IDLE_KEY: Record<CodiMode, TranslationKey> = {
  wake: "codi.window.idleWake",
  conversation: "codi.window.idleConversation",
  ptt: "codi.window.idlePtt",
};

const PHASE_KEY: Record<Exclude<CodiPhase, "off" | "idle">, TranslationKey> = {
  hearing: "codi.window.phaseHearing",
  thinking: "codi.window.phaseThinking",
  acting: "codi.window.phaseActing",
  speaking: "codi.window.phaseSpeaking",
  waiting: "codi.window.phaseWaiting",
};

/** How tall the window grows to show the log, when it is shorter (logical px). */
const EXPANDED_HEIGHT = 760;
const EXPANDED_KEY = "cf-codi-expanded";

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeExpanded(on: boolean): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY, on ? "1" : "0");
  } catch {
    // A convenience; the toggle still works for this session.
  }
}

/** True while `at` (on `clock`) is less than `ms` old — and re-renders once it no longer is. */
function useFresh(at: number | null | undefined, ms: number, clock: () => number): boolean {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const left = at == null ? 0 : ms - (clock() - at);
  useEffect(() => {
    if (at == null || left <= 0) return;
    const id = window.setTimeout(bump, left + 16);
    return () => window.clearTimeout(id);
    // `left` is derived from `at`; re-arming on every render would only push the timer back.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at]);
  return left > 0;
}

const now = () => performance.now();
const wallClock = () => Date.now();

/** When, into the face's wake (`cf-codi-wake` in `index.css`), it stops dozing and startles — the
 *  peak of its stretch. */
const AWAKE_AT_MS = 1000;
/** The face while it dozes, before it wakes: every design's quiet look. */
const ASLEEP = { quiet: true } as const;

/** Whether this window is opening now, with room to show it: decided once, when it is first ready —
 *  the motion level is read during that load, so earlier it is still the default — and only in
 *  Motion «Completa» (which the system's reduce-motion setting already turns off). Once per window. */
let opened = false;
function useOpening(ready: boolean): boolean {
  const decided = useRef<boolean | null>(null);
  if (ready && decided.current === null) {
    decided.current = !opened && motionLevel() === "full";
    opened = true;
  }
  return decided.current ?? false;
}

/** The face, in the phase Codi is in (`face.ts`), dimmed while the microphone is closed. `waking`:
 *  the window is opening — it dozes, then wakes (`index.css`, «Codi's window opening»). */
function CodiFace({ waking = false }: { waking?: boolean }) {
  const phase = useCodiStore((s) => s.state?.phase ?? "off");
  const phaseSince = useCodiStore((s) => s.phaseSince);
  const wakeAt = useCodiStore((s) => s.wakeAt);
  const lastTurn = useCodiStore((s) => s.turns[0]);
  const fresh = useFresh(wakeAt, WAKE_MS, now);
  const outcome = lastTurn ? turnOutcome(lastTurn) : null;
  const flashing = useFresh(outcome ? lastTurn?.at : null, FLASH_MS, wallClock);
  const [asleep, setAsleep] = useState(waking);
  useEffect(() => {
    if (!waking) return;
    // Awake: the design's own startle plays on the stretch — the same cue as its name being heard.
    const id = window.setTimeout(() => {
      setAsleep(false);
      useCodiStore.setState({ wakeAt: performance.now() });
    }, AWAKE_AT_MS);
    return () => window.clearTimeout(id);
  }, [waking]);
  const activity = useMemo(
    () => (asleep ? ASLEEP : codiActivity({ phase, phaseSince, wakeAt: fresh ? wakeAt : null, flash: flashing ? outcome : null })),
    [asleep, phase, phaseSince, wakeAt, fresh, flashing, outcome],
  );
  return (
    <div
      className={`relative flex h-[188px] items-center justify-center transition-opacity duration-300 motion-reduce:transition-none ${
        phase === "off" && !asleep ? "opacity-45" : "opacity-100"
      }`}
    >
      {waking && (
        <span
          aria-hidden
          className="cf-codi-halo pointer-events-none absolute h-[170px] w-[170px] rounded-full"
          style={{ background: "radial-gradient(circle, transparent 50%, color-mix(in oklab, var(--cf-accent) 50%, transparent) 60%, transparent 71%)" }}
        />
      )}
      <div className={waking ? "cf-codi-wake" : undefined}>
        <ThinkingOrb size="hero" gain={2.2} activity={activity} />
      </div>
    </div>
  );
}

/** One line under the face: what it is doing, read out to a screen reader as it changes. */
function PhaseLine() {
  const t = useT();
  const state = useCodiStore((s) => s.state);
  const phase = state?.phase ?? "off";
  const mode = state?.mode ?? "wake";
  let text: string;
  if (!state) text = t("codi.window.phaseOff");
  else if (state.talking) text = t("codi.window.talking");
  else if (phase === "off") text = state.missing.length > 0 ? t("codi.window.phaseMissing") : t("codi.window.phaseOff");
  else if (phase === "idle" && mode === "ptt" && state.pttKey) text = t("codi.window.idlePttChord", { chord: acceleratorKeycaps(state.pttKey, isMac()).join("") });
  else if (phase === "idle") text = t(IDLE_KEY[mode]);
  else text = t(PHASE_KEY[phase]);
  return (
    <p aria-live="polite" className="h-5 text-[12px] font-medium text-[var(--cf-text-muted)]">
      {text}
    </p>
  );
}

/** Opens Settings › Voz y sonido › Codi in the main window, the only one with a Settings screen. */
function openCodiSettings(): void {
  void showMainWindow()
    .catch(() => {})
    .then(() => sendTo(MAIN_LABEL, { kind: "open-settings", to: MAIN_LABEL, section: "voice", tab: "codi" }))
    .catch(() => {});
}

function CodiStrip({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const t = useT();
  const mode = useCodiStore((s) => s.state?.mode);
  return (
    <div
      onMouseDown={(event) => {
        if (event.button !== 0 || event.target !== event.currentTarget) return;
        event.preventDefault();
        void getCurrentWindow().startDragging();
      }}
      className="flex h-8 shrink-0 cursor-default select-none items-center gap-2 pl-3.5 pr-1.5"
    >
      <span className="pointer-events-none text-[13px] font-semibold text-[var(--cf-text)]">{t("codi.window.title")}</span>
      {mode && (
        <button
          type="button"
          onClick={openCodiSettings}
          title={t("codi.window.modeChange")}
          className={`${chipClass("neutral")} cursor-pointer hover:text-[var(--cf-text)]`}
        >
          {t(MODE_KEY[mode])}
        </button>
      )}
      <div className="pointer-events-none flex-1" />
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={expanded}
        title={expanded ? t("codi.window.compact") : t("codi.window.expand")}
        aria-label={expanded ? t("codi.window.compact") : t("codi.window.expand")}
        className={iconButtonClass({ size: "xs", active: expanded })}
      >
        {expanded ? <ChevronsDownUp size={13} /> : <ChevronsUpDown size={13} />}
      </button>
      <button
        type="button"
        onClick={() => void getCurrentWindow().close()}
        title={t("codi.window.close")}
        aria-label={t("codi.window.close")}
        className={iconButtonClass({ size: "xs" })}
      >
        <X size={14} />
      </button>
    </div>
  );
}

/** A field that takes keys: Space there is a space, not the push-to-talk key. */
function typesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

/**
 * Push-to-talk by Space while this window has the keyboard, anywhere but a text field. Held is
 * held once (`repeat` ignored), and letting go — or the window losing focus with it down — lets go.
 */
function usePushToTalkKey(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let held = false;
    const release = () => {
      if (!held) return;
      held = false;
      useCodiStore.getState().talk(false);
    };
    const onDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || typesText(event.target)) return;
      // Also keeps Space from pressing the focused button (a switch) on its way up.
      event.preventDefault();
      if (event.repeat || held) return;
      held = true;
      useCodiStore.getState().talk(true);
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (held) event.preventDefault();
      release();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", release);
      release();
    };
  }, [enabled]);
}

/** «Mantén para hablar» and the typed order. */
function CodiOrderBar() {
  const t = useT();
  const mode = useCodiStore((s) => s.state?.mode);
  const mic = useCodiStore((s) => !!s.state?.mic);
  const talking = useCodiStore((s) => !!s.state?.talking);
  const [draft, setDraft] = useState("");
  const pressing = useRef(false);
  const ptt = mode === "ptt" && mic;
  usePushToTalkKey(ptt);

  const send = () => {
    if (!draft.trim()) return;
    useCodiStore.getState().order(draft);
    setDraft("");
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };
  const letGo = () => {
    if (!pressing.current) return;
    pressing.current = false;
    useCodiStore.getState().talk(false);
  };

  return (
    <div className="flex shrink-0 flex-col gap-2 px-3 pb-3 pt-2">
      {ptt && (
        <button
          type="button"
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            pressing.current = true;
            useCodiStore.getState().talk(true);
          }}
          onPointerUp={letGo}
          onPointerLeave={letGo}
          onPointerCancel={letGo}
          // A press that never lifts the pointer (a keyboard user): Enter/Space on the button itself
          // is a click, which cannot hold — the window's own Space does.
          aria-pressed={talking}
          className={`cf-press flex h-10 w-full items-center justify-center rounded-lg text-[13px] font-semibold transition-colors duration-100 motion-reduce:transition-none ${
            talking
              ? "bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)]"
              : "bg-[var(--cf-control)] text-[var(--cf-text)] shadow-[inset_0_0_0_1px_var(--cf-border-strong)] hover:bg-[color-mix(in_oklab,var(--cf-text)_4%,var(--cf-control))]"
          }`}
        >
          {talking ? t("codi.window.talkRelease") : t("codi.window.talkHold")}
        </button>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t("codi.window.orderPlaceholder")}
          aria-label={t("codi.window.orderPlaceholder")}
          className={fieldClass({ className: "flex-1" })}
        />
        <button
          type="button"
          onClick={send}
          disabled={!draft.trim()}
          title={t("codi.window.orderSend")}
          aria-label={t("codi.window.orderSend")}
          className={iconButtonClass({ size: "md" })}
        >
          <CornerDownLeft size={14} />
        </button>
      </div>
    </div>
  );
}

/** The microphone's or the runtime's last error, under the switches. */
function ErrorLine() {
  const error = useCodiStore((s) => s.state?.error);
  if (!error) return null;
  return <p className="break-words text-center text-[11.5px] text-[var(--cf-danger)]">{error}</p>;
}

export function CodiWindow({ ready = true }: { ready?: boolean }) {
  const [expanded, setExpanded] = useState(readExpanded);
  const opening = useOpening(ready);
  /** What follows the face in, `n`-th: once it is awake (`cf-codi-rise`). */
  const rise = (n: number, className = "") => ({ className: `${className} ${opening ? "cf-codi-rise" : ""}`.trim(), style: opening ? ({ "--cf-rise": n } as CSSProperties) : undefined });
  /** The height the window had before the log grew it, to give it back when the log folds. */
  const grownFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!ready) return;
    ensureCodiLevel();
    ensureCodiVoice();
    void useCodiStore.getState().load();
  }, [ready]);

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    writeExpanded(next);
    void fitWindow(next, grownFrom);
  };

  return (
    <div className={`flex h-full flex-col bg-[var(--cf-surface)] ${opening ? "cf-codi-open" : ""}`}>
      <CodiStrip expanded={expanded} onToggle={toggle} />
      {!ready ? (
        <div className="min-h-0 flex-1">
          <ViewSkeleton />
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pb-1">
            <div className="flex flex-col items-center">
              <CodiFace waking={opening} />
              <div {...rise(0)}>
                <PhaseLine />
              </div>
            </div>
            <CodiTranscript />
            <div {...rise(1)}>
              <CodiSwitches />
            </div>
            <ErrorLine />
            <CodiConfirmCard />
            {expanded && <CodiActionLog />}
          </div>
          <div {...rise(2, "shrink-0")}>
            <CodiOrderBar />
          </div>
        </>
      )}
    </div>
  );
}

/** Grows the window to show the log, when it is shorter than that — and gives the height back when
 *  the log folds, if it was this that grew it. A resize the user made in between is kept. */
async function fitWindow(expanded: boolean, grownFrom: { current: number | null }): Promise<void> {
  try {
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(factor);
    if (expanded) {
      const room = Math.max(560, Math.min(EXPANDED_HEIGHT, (window.screen?.availHeight ?? EXPANDED_HEIGHT) - 48));
      if (size.height >= room) return;
      grownFrom.current = size.height;
      await win.setSize(new LogicalSize(size.width, room));
      return;
    }
    const before = grownFrom.current;
    grownFrom.current = null;
    if (before !== null && before < size.height) await win.setSize(new LogicalSize(size.width, before));
  } catch {
    // The log still folds; the window keeps the size it has.
  }
}
