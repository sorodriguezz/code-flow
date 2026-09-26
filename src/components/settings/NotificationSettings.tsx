/**
 * What the app tells you about, and how loudly.
 *
 * These preferences existed before this screen did — they just had nowhere to live. The sound
 * toggle was inside the notification bell's own popover, which is a reasonable place to *find* it
 * once and an unreasonable place to look for it ever again: it is the only application preference
 * in the app that was not behind the Settings window.
 *
 * Three questions, in the order somebody actually asks them: what does it sound like, does it reach
 * me when I am not looking at the app, and which of these do I care about at all. The first had one
 * answer until 2026-09-24; it has ten now, and a pane of its own.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, Volume1, Volume2, VolumeX } from "lucide-react";
import { nativePermission, requestNativePermission } from "../../lib/nativeNotify";
import {
  NOTIFICATION_SOUNDS,
  previewNotificationSound,
  soundById,
  type NotificationSoundDef,
  type NotificationSoundId,
} from "../../lib/notificationSound";
import { NOTIFICATION_SOURCE_LABEL, notify, type NotificationSource } from "../../state/notificationStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { buttonClass } from "../common/Button";
import { rowClass } from "../common/recipes";
import { Note, Panel, SettingsHeader } from "../api/settingsChrome";
import { onRadioKeys, PaneBlock, SettingsRail, useSectionTab } from "./settingsNav";
import { tabsFor } from "../../lib/settingsCatalog";

/** Every source, in the order the bell groups them. Derived from the label map so a source added
 *  there cannot be forgotten here. */
const SOURCES = Object.keys(NOTIFICATION_SOURCE_LABEL) as NotificationSource[];

/**
 * A labelled switch with its explanation underneath, which is the shape every toggle on this screen
 * takes.
 *
 * The label wraps rather than truncating — as everything in this window now does. A preference you
 * can only half-read is a preference you have to toggle to understand.
 */
function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={`py-2 ${disabled ? "opacity-50" : ""}`}>
      <label className="flex cursor-pointer items-start gap-2.5">
        <span className="mt-[1px] shrink-0">
          <Checkbox checked={checked} onChange={disabled ? () => {} : onChange} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[13px] leading-snug text-[var(--cf-text)]">{label}</span>
          {hint && (
            <span className="mt-0.5 block break-words text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {hint}
            </span>
          )}
        </span>
      </label>
    </div>
  );
}

/** Seconds of score the glyph spans. Longer sounds (the bowl, the doorbell's tail) run off its right
 *  edge, which is the truth about them: they go on after the others have stopped. */
const SCORE_SPAN_S = 1.6;
const SCORE_W = 56;
const SCORE_H = 22;
const SCORE_PAD = 4;

/**
 * A sound's score as a small piano roll: time across, pitch up, one mark per note — drawn from the
 * same array that plays it (`NOTIFICATION_SOUNDS`), so what is drawn is what is heard.
 *
 * Pitch is scaled to each sound's own range rather than to one shared axis: the point is the shape —
 * two notes falling, five rising, one long drone — and on a shared axis the glass and the bowl
 * would both be flat lines at opposite edges. While the sound plays, a playhead crosses it.
 */
function ScoreGlyph({ sound, playing }: { sound: NotificationSoundDef; playing: number | null }) {
  const pitches = sound.score.flatMap((note) => (note.to ? [note.hz, note.to] : [note.hz])).map(Math.log2);
  const high = Math.max(...pitches);
  const low = Math.min(...pitches);
  // Centred, and never more than an octave to the full height — so a sound with one pitch sits in
  // the middle rather than on an edge, and two notes a third apart do not fill the whole glyph.
  const middle = (high + low) / 2;
  const span = Math.max(high - low, 1);
  const y = (hz: number) => SCORE_H / 2 - ((Math.log2(hz) - middle) / span) * (SCORE_H - SCORE_PAD * 2);
  const x = (seconds: number) => SCORE_PAD + Math.min(seconds / SCORE_SPAN_S, 1) * (SCORE_W - SCORE_PAD * 2);

  return (
    <span
      aria-hidden
      className="relative block shrink-0 overflow-hidden rounded-[5px] bg-[var(--cf-sunken)] shadow-[inset_0_0_0_1px_var(--cf-border)]"
      style={{ width: SCORE_W, height: SCORE_H }}
    >
      <svg viewBox={`0 0 ${SCORE_W} ${SCORE_H}`} width={SCORE_W} height={SCORE_H} className="absolute inset-0">
        {sound.score.map((note, index) =>
          note.to ? (
            // A glide: a stroke from where the pitch starts to where it ends.
            <line
              key={index}
              x1={x(note.at)}
              y1={y(note.hz)}
              x2={x(note.at + note.dur)}
              y2={y(note.to)}
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
            />
          ) : (
            // A note, drawn for the part of it that is heard — the first two thirds of its tail.
            <rect
              key={index}
              x={x(note.at)}
              y={y(note.hz) - 1}
              width={Math.max(3, x(note.at + note.dur * 0.65) - x(note.at))}
              height={2}
              rx={1}
              fill="currentColor"
            />
          ),
        )}
      </svg>
      {playing !== null && (
        // Keyed by the play count, so pressing the same sound again restarts the sweep.
        <span
          key={playing}
          className="cf-score-playhead"
          style={{ animationDuration: `${Math.min(sound.length, SCORE_SPAN_S)}s` }}
        />
      )}
    </span>
  );
}

/** What it sounds like: whether it sounds at all, how loud, and which of the twelve. */
function SoundPane() {
  const t = useT();
  const enabled = usePreferencesStore((s) => s.notificationSoundEnabled);
  const setEnabled = usePreferencesStore((s) => s.setNotificationSoundEnabled);
  const soundId = usePreferencesStore((s) => s.notificationSoundId);
  const setSoundId = usePreferencesStore((s) => s.setNotificationSoundId);
  const volume = usePreferencesStore((s) => s.notificationSoundVolume);
  const setVolume = usePreferencesStore((s) => s.setNotificationSoundVolume);

  // The slider's position while it is being dragged. Saved, and heard, once it is let go: a setting
  // write per pixel would announce itself to every window, and a preview per pixel is a stutter.
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? volume;

  // Which row's playhead is running, and a count that restarts it.
  const [playing, setPlaying] = useState<{ id: NotificationSoundId; run: number } | null>(null);
  const stopTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(stopTimer.current), []);

  const play = (id: NotificationSoundId, level = shown) => {
    previewNotificationSound(id, level);
    setPlaying((previous) => ({ id, run: (previous?.run ?? 0) + 1 }));
    window.clearTimeout(stopTimer.current);
    stopTimer.current = window.setTimeout(() => setPlaying(null), Math.min(soundById(id).length, SCORE_SPAN_S) * 1000 + 120);
  };

  const commitVolume = () => {
    if (draft === null) return;
    void setVolume(draft);
    play(soundId, draft);
    setDraft(null);
  };

  const VolumeIcon = shown === 0 ? VolumeX : shown < 50 ? Volume1 : Volume2;

  return (
    <>
      <div>
        <Toggle
          label={t("notifications.soundLabel")}
          hint={t("notifications.soundHint")}
          checked={enabled}
          onChange={(value) => {
            void setEnabled(value);
            // Turning it on plays it, as the bell's switch does — nobody should have to wait for a
            // background job to hear what they just agreed to.
            if (value) play(soundId);
          }}
        />

        {/* Usable with the sound off: choosing and trying one is how somebody decides to turn it on. */}
        <label className="flex items-center gap-2.5 py-2">
          <span className="w-[72px] shrink-0 text-[13px] text-[var(--cf-text)]">{t("notifications.volume")}</span>
          <VolumeIcon size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={shown}
            onChange={(event) => setDraft(Number(event.target.value))}
            onPointerUp={commitVolume}
            onKeyUp={commitVolume}
            onBlur={commitVolume}
            className="w-full max-w-[280px] accent-[var(--cf-accent)]"
          />
          <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-[var(--cf-text-muted)]">{shown}%</span>
        </label>
      </div>

      <PaneBlock title={t("notifications.toneHeading")}>
        {/* Two columns once the pane is wide enough for a name and its line side by side — twelve sounds
            make six full rows. */}
        <div className="@container">
          <div
            role="radiogroup"
            aria-label={t("notifications.toneHeading")}
            onKeyDown={onRadioKeys}
            className="grid grid-cols-1 gap-x-3 gap-y-0.5 @[560px]:grid-cols-2"
          >
            {NOTIFICATION_SOUNDS.map((sound) => {
              const selected = sound.id === soundId;
              return (
                <button
                  key={sound.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  // One tab stop for the group, on the chosen sound; the arrows do the rest.
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    if (!selected) void setSoundId(sound.id);
                    play(sound.id);
                  }}
                  className={rowClass(selected, "min-h-11 gap-3 py-1.5")}
                >
                  <span className={selected || playing?.id === sound.id ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-faint)]"}>
                    <ScoreGlyph sound={sound} playing={playing?.id === sound.id ? playing.run : null} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="break-words text-[13px] leading-snug text-[var(--cf-text)]">{t(sound.labelKey)}</span>
                    <span className="break-words text-[11px] leading-snug text-[var(--cf-text-muted)]">{t(sound.hintKey)}</span>
                  </span>
                  {selected ? (
                    <Check size={14} className="shrink-0 text-[var(--cf-accent)]" />
                  ) : (
                    <span aria-hidden className="w-3.5 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PaneBlock>
    </>
  );
}

/** Whether it reaches you when you are not looking: the system's own notifications, and the button
 *  that proves the whole chain — bell, sound and banner — works. */
function DeliveryPane() {
  const t = useT();
  const nativeEnabled = usePreferencesStore((s) => s.nativeNotificationsEnabled);
  const setNativeEnabled = usePreferencesStore((s) => s.setNativeNotificationsEnabled);
  const onlyBackground = usePreferencesStore((s) => s.nativeNotificationsOnlyBackground);
  const setOnlyBackground = usePreferencesStore((s) => s.setNativeNotificationsOnlyBackground);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  const [permission, setPermission] = useState<"granted" | "denied" | "default" | null>(null);

  useEffect(() => {
    void nativePermission().then(setPermission);
  }, []);

  /**
   * Turning it on is what asks the OS. Turning it off never does — revoking is ours to do, and
   * asking again on the way out would be a prompt for nothing.
   */
  const toggleNative = async (value: boolean) => {
    if (!value) {
      await setNativeEnabled(false);
      return;
    }
    const answer = permission === "granted" ? "granted" : await requestNativePermission();
    setPermission(answer);
    await setNativeEnabled(answer === "granted");
  };

  return (
    <>
      <Toggle
        label={t("notifications.systemLabel")}
        hint={t("notifications.systemHint")}
        checked={nativeEnabled}
        disabled={permission === "denied"}
        onChange={(value) => void toggleNative(value)}
      />

      {permission === "denied" && <Note tone="warning">{t("notifications.systemDenied")}</Note>}

      {/* Only meaningful once the system notifications are on — shown always but inert, rather
          than appearing and disappearing under the pointer as the switch above is flipped. */}
      <div className="pl-6">
        <Toggle
          label={t("notifications.onlyBackgroundLabel")}
          hint={t("notifications.onlyBackgroundHint")}
          checked={onlyBackground}
          disabled={!nativeEnabled}
          onChange={(value) => void setOnlyBackground(value)}
        />
      </div>

      <button
        type="button"
        onClick={() =>
          notify({
            source: "chat",
            workspaceId,
            titleKey: "notifications.testTitle",
            detail: t("notifications.settingsTitle"),
            status: "info",
          })
        }
        className={buttonClass({ variant: "secondary", size: "sm", className: "mt-2" })}
      >
        <Volume2 size={13} />
        {t("notifications.testButton")}
      </button>
    </>
  );
}

/** About what. Every source the bell knows, each one mutable on its own. */
function SourcesPane() {
  const t = useT();
  const muted = usePreferencesStore((s) => s.mutedNotificationSources);
  const setMuted = usePreferencesStore((s) => s.setNotificationSourceMuted);

  return (
      <ul>
        {SOURCES.map((source) => {
          const off = muted.includes(source);
          return (
            <li key={source}>
              {/* A list row: the whole line toggles, and says so under the pointer. */}
              <label className="-mx-1.5 flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-1.5 py-1 transition-colors duration-100 hover:bg-[var(--cf-hover)]">
                <span className="shrink-0">
                  <Checkbox checked={!off} onChange={(value) => void setMuted(source, !value)} />
                </span>
                {off ? (
                  <BellOff size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
                ) : (
                  <Bell size={13} className="shrink-0 text-[var(--cf-text-muted)]" />
                )}
                {/* Wraps rather than truncates, like every other label in this window. */}
                <span
                  className={`min-w-0 flex-1 break-words text-[13px] leading-snug ${
                    off ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"
                  }`}
                >
                  {t(NOTIFICATION_SOURCE_LABEL[source])}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
  );
}

export function NotificationSettings() {
  const t = useT();
  const tabs = tabsFor("notifications");
  const [tab, setTab] = useSectionTab("notifications", tabs, "sound");
  const active = tabs.find((entry) => entry.id === tab) ?? tabs[0];

  // The source list is much taller than the four switches, so arriving at one while scrolled
  // through the other would start it in the middle. Same fix as `EditorSettings`: land at the top
  // before the frame is painted rather than as a visible correction after it.
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    paneRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="shrink-0">
        <SettingsHeader title={t("notifications.settingsTitle")} hint={t("notifications.settingsHint")} />
      </div>

      <div className="flex min-h-0 flex-1 gap-4">
        <SettingsRail tabs={tabs} active={tab} onSelect={setTab} layoutId="cf-notifications-settings-pill" />

        <div ref={paneRef} className="min-w-0 flex-1 overflow-y-scroll pb-6">
          <Panel>
            {/* The rail names the pane, so no heading is repeated here — but the hint says what the
                label cannot, so it stays. Same call as the editor and AI sections. */}
            {active?.hintKey && (
              <p className="mb-3 text-[12px] leading-snug text-[var(--cf-text-muted)]">{t(active.hintKey)}</p>
            )}

            {tab === "sound" && <SoundPane />}
            {tab === "delivery" && <DeliveryPane />}
            {tab === "sources" && <SourcesPane />}
          </Panel>
        </div>
      </div>
    </section>
  );
}
