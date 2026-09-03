/**
 * The Pipelines tab's own settings — which is to say, the one knob it has.
 *
 * The tab had no settings section at all, and it is the only polling client in the app: every live
 * run costs a request against somebody else's rate limit every five seconds. That is a fine default
 * for one person watching one build and a poor one for a machine watching four repositories on a
 * shared token, and until now there was no way to say so.
 */

import { Route } from "lucide-react";
import { DEFAULT_PIPELINE_POLL, PIPELINE_POLL_CHOICES } from "../../state/ciStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useT } from "../../state/languageStore";
import { Group, Note, SettingsHeader } from "../api/settingsChrome";

export function PipelinesSettings() {
  const t = useT();
  const seconds = usePreferencesStore((s) => s.pipelinePollSeconds);
  const setSeconds = usePreferencesStore((s) => s.setPipelinePollSeconds);

  return (
    <section>
      <SettingsHeader title={t("tabbar.pipelines")} hint={t("pipelines.settingsHint")} />

      <Group title={t("pipelines.pollLabel")}>
        <p className="mb-2 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
          {t("pipelines.pollHint")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {PIPELINE_POLL_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              onClick={() => void setSeconds(choice)}
              className={`rounded-md border px-2.5 py-1 text-[11.5px] transition-colors ${
                seconds === choice
                  ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                  : "border-[var(--cf-border)] text-[var(--cf-text)] hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
              }`}
            >
              {/* Never truncated, and each option reads as a full phrase rather than a bare
                  number — "5" beside "10" beside "60" makes the unit somebody's guess. */}
              {t("pipelines.pollSeconds", { n: choice })}
            </button>
          ))}
        </div>
        {seconds === DEFAULT_PIPELINE_POLL && <Note>{t("pipelines.pollDefaultNote")}</Note>}
      </Group>

      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
        <Route size={11} className="mt-[2px] shrink-0" />
        {t("pipelines.settingsFooter")}
      </p>
    </section>
  );
}
