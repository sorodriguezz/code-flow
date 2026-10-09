/**
 * What the app tells you about, and how loudly.
 *
 * These preferences existed before this screen did — they just had nowhere to live. The sound
 * toggle was inside the notification bell's own popover, which is a reasonable place to *find* it
 * once and an unreasonable place to look for it ever again: it is the only application preference
 * in the app that was not behind the Settings window.
 *
 * Three questions, in the order somebody actually asks them: what does it sound like, does it reach
 * me when I am not looking at the app, and which of these do I care about at all. The sound
 * catalogue has its own pane, with a preview for each cue.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, Play, Volume1, Volume2, VolumeX } from "lucide-react";
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
import { useSpeechStore } from "../../state/speechStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { buttonClass, iconButtonClass } from "../common/Button";
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

const SCORE_W = 56;
const SCORE_H = 22;
const SCORE_PAD = 4;

/** Scores for generated tones, actual waveforms for recordings. Both span the full cue. */
function ScoreGlyph({ sound, playing }: { sound: NotificationSoundDef; playing: number | null }) {
  const pitches = sound.score.map((note) => Math.log2(note.hz));
  const high = pitches.length ? Math.max(...pitches) : 0;
  const low = pitches.length ? Math.min(...pitches) : 0;
  const middle = (high + low) / 2;
  const span = Math.max(high - low, 1);
  const y = (hz: number) => SCORE_H / 2 - ((Math.log2(hz) - middle) / span) * (SCORE_H - SCORE_PAD * 2);
  const x = (seconds: number) => SCORE_PAD + (seconds / sound.length) * (SCORE_W - SCORE_PAD * 2);

  return (
    <span
      aria-hidden
      className="relative block shrink-0 overflow-hidden rounded-[5px] bg-[var(--cf-sunken)] shadow-[inset_0_0_0_1px_var(--cf-border)]"
      style={{ width: SCORE_W, height: SCORE_H }}
    >
      <svg viewBox={`0 0 ${SCORE_W} ${SCORE_H}`} width={SCORE_W} height={SCORE_H} className="absolute inset-0">
        {sound.waveform ? sound.waveform.map((amplitude, index) => {
          const height = Math.max(2, amplitude * (SCORE_H - SCORE_PAD * 2));
          return (
            <rect key={index} x={SCORE_PAD + index * 2} y={(SCORE_H - height) / 2}
              width={1.2} height={height} rx={0.6} fill="currentColor" />
          );
        }) : sound.score.map((note, index) => (
          <rect key={index} x={x(note.at)} y={y(note.hz) - 1}
            width={Math.max(3, x(note.at + note.dur * 0.65) - x(note.at))}
            height={2} rx={1} fill="currentColor" />
        ))}
      </svg>
      {playing !== null && (
        <span key={playing} className="cf-score-playhead" style={{ animationDuration: `${sound.length}s` }} />
      )}
    </span>
  );
}

/** What it sounds like: whether it sounds at all, how loud, and which cue. */
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
    stopTimer.current = window.setTimeout(() => setPlaying(null), soundById(id).length * 1000 + 120);
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
        {/* Two columns once the pane is wide enough for each name and its preview. */}
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
/**
 * Each source, three ways it can reach you: a row in the bell (and the system's notification), a
 * tone, and the thinking mark saying it. A source turned off is not recorded at all, so its tone and
 * voice go with it. «Voz» is off for every source until chosen — a voice nobody asked for is the
 * fastest way to have the feature switched off for good.
 */
function SourcesPane() {
  const t = useT();
  const muted = usePreferencesStore((s) => s.mutedNotificationSources);
  const silent = usePreferencesStore((s) => s.silentNotificationSources);
  const spoken = usePreferencesStore((s) => s.spokenNotificationSources);
  const setMuted = usePreferencesStore((s) => s.setNotificationSourceMuted);
  const setSilent = usePreferencesStore((s) => s.setNotificationSourceSilent);
  const setSpoken = usePreferencesStore((s) => s.setNotificationSourceSpoken);
  const head = "px-2 py-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";

  return (
    <div>
      <p className="mb-3 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-snug text-[var(--cf-text-muted)]">
        <span>{t("notifications.voiceWhere")}</span>
        <button
          type="button"
          className="text-[var(--cf-accent)] hover:underline"
          onClick={() => useUiStore.getState().openSettingsAt("voice", "reading")}
        >
          {t("speech.title")}
        </button>
      </p>
      <div className="overflow-x-auto rounded-lg border border-[var(--cf-border)]">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-[var(--cf-border)] text-left">
              <th className={head}>{t("notifications.sourceColumn")}</th>
              <th className={`${head} w-[68px] text-center`}>{t("notifications.columnShow")}</th>
              <th className={`${head} w-[68px] text-center`}>{t("notifications.columnSound")}</th>
              <th className={`${head} w-[68px] text-center`}>{t("notifications.columnVoice")}</th>
              <th className={`${head} w-[44px]`}>
                <span className="sr-only">{t("notifications.columnHear")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {SOURCES.map((source) => {
              const off = muted.includes(source);
              const label = t(NOTIFICATION_SOURCE_LABEL[source]);
              return (
                <tr key={source} className="border-b border-[var(--cf-border)] last:border-b-0">
                  <td className="px-2 py-1">
                    <span className={`flex items-center gap-2 break-words leading-snug ${off ? "text-[var(--cf-text-muted)]" : "text-[var(--cf-text)]"}`}>
                      {off ? <BellOff size={13} className="shrink-0 text-[var(--cf-text-faint)]" /> : <Bell size={13} className="shrink-0 text-[var(--cf-text-muted)]" />}
                      {label}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-center">
                    <span className="inline-flex" title={t("notifications.columnShow")}>
                      <Checkbox checked={!off} onChange={(value) => void setMuted(source, !value)} />
                    </span>
                  </td>
                  <td className={`px-2 py-1 text-center ${off ? "opacity-40" : ""}`}>
                    <span className="inline-flex" title={t("notifications.columnSound")}>
                      <Checkbox checked={!off && !silent.includes(source)} onChange={off ? () => {} : (value) => void setSilent(source, !value)} />
                    </span>
                  </td>
                  <td className={`px-2 py-1 text-center ${off ? "opacity-40" : ""}`}>
                    <span className="inline-flex" title={t("notifications.columnVoice")}>
                      <Checkbox checked={!off && spoken.includes(source)} onChange={off ? () => {} : (value) => void setSpoken(source, value)} />
                    </span>
                  </td>
                  <td className="px-1 py-1 text-center">
                    <button
                      type="button"
                      aria-label={t("notifications.hearSource", { source: label })}
                      title={t("notifications.hearSource", { source: label })}
                      className={iconButtonClass({ size: "xs" })}
                      onClick={() => useSpeechStore.getState().say(t("notifications.voiceSample", { source: label }), "test", { interrupt: true })}
                    >
                      <Play size={11} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
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
