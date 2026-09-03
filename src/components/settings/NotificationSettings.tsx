/**
 * What the app tells you about, and how loudly.
 *
 * These preferences existed before this screen did — they just had nowhere to live. The sound
 * toggle was inside the notification bell's own popover, which is a reasonable place to *find* it
 * once and an unreasonable place to look for it ever again: it is the only application preference
 * in the app that was not behind the Settings window.
 *
 * Three questions, in the order somebody actually asks them: does it make a noise, does it reach me
 * when I am not looking at the app, and which of these do I care about at all.
 */

import { useEffect, useState } from "react";
import { Bell, BellOff, Volume2 } from "lucide-react";
import { nativePermission, requestNativePermission } from "../../lib/nativeNotify";
import { NOTIFICATION_SOURCE_LABEL, notify, type NotificationSource } from "../../state/notificationStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { Group, Note, SettingsHeader } from "../api/settingsChrome";

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
    <div className={`py-1.5 ${disabled ? "opacity-50" : ""}`}>
      <label className="flex cursor-pointer items-start gap-2">
        <span className="mt-[1px] shrink-0">
          <Checkbox checked={checked} onChange={disabled ? () => {} : onChange} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block break-words text-[12.5px] leading-snug text-[var(--cf-text)]">{label}</span>
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

export function NotificationSettings() {
  const t = useT();
  const soundEnabled = usePreferencesStore((s) => s.notificationSoundEnabled);
  const setSoundEnabled = usePreferencesStore((s) => s.setNotificationSoundEnabled);
  const nativeEnabled = usePreferencesStore((s) => s.nativeNotificationsEnabled);
  const setNativeEnabled = usePreferencesStore((s) => s.setNativeNotificationsEnabled);
  const onlyBackground = usePreferencesStore((s) => s.nativeNotificationsOnlyBackground);
  const setOnlyBackground = usePreferencesStore((s) => s.setNativeNotificationsOnlyBackground);
  const muted = usePreferencesStore((s) => s.mutedNotificationSources);
  const setMuted = usePreferencesStore((s) => s.setNotificationSourceMuted);
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
    <section>
      <SettingsHeader title={t("notifications.settingsTitle")} hint={t("notifications.settingsHint")} />

      <Group title={t("notifications.settingsTitle")}>
        <Toggle
          label={t("notifications.soundLabel")}
          hint={t("notifications.soundHint")}
          checked={soundEnabled}
          onChange={(value) => void setSoundEnabled(value)}
        />

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
          className="mt-1.5 flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1.5 text-[11.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
        >
          <Volume2 size={12} />
          {t("notifications.testButton")}
        </button>
      </Group>

      <Group title={t("notifications.sourcesTitle")}>
        <p className="mb-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {t("notifications.sourcesHint")}
        </p>
        <ul>
          {SOURCES.map((source) => {
            const off = muted.includes(source);
            return (
              <li key={source}>
                <label className="flex cursor-pointer items-center gap-2 py-1">
                  <span className="shrink-0">
                    <Checkbox checked={!off} onChange={(value) => void setMuted(source, !value)} />
                  </span>
                  {off ? (
                    <BellOff size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                  ) : (
                    <Bell size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                  )}
                  {/* Wraps rather than truncates, like every other label in this window. */}
                  <span className="min-w-0 flex-1 break-words text-[12.5px] leading-snug text-[var(--cf-text)]">
                    {t(NOTIFICATION_SOURCE_LABEL[source])}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </Group>
    </section>
  );
}
