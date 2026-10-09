/**
 * The Pipelines tab's own settings — one pane of «Integraciones» since 2026-10-09, beside the
 * accounts it needs (it was a section of its own, a rail of two panes around one knob).
 *
 * It is the only polling client in the app: every live run costs a request against somebody else's
 * rate limit every five seconds. That is a fine default for one person watching one build and a
 * poor one for a machine watching four repositories on a shared token, which is what the knob is
 * for. Under it, the answer to the question this pane is opened with — *why is there no Pipelines
 * tab on this repository*.
 */

import { DEFAULT_PIPELINE_POLL, PIPELINE_POLL_CHOICES } from "../../state/ciStore";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useT } from "../../state/languageStore";
import { Note } from "../api/settingsChrome";
import { Segmented } from "../common/Segmented";

function PollingPane() {
  const t = useT();
  const seconds = usePreferencesStore((s) => s.pipelinePollSeconds);
  const setSeconds = usePreferencesStore((s) => s.setPipelinePollSeconds);

  return (
    <>
      {/* One choice among five peers: the segmented control. Each option reads as a full phrase
          rather than a bare number — "5" beside "10" beside "60" makes the unit somebody's guess.
          The values travel as strings, which is all the control speaks, and are read back here. */}
      <Segmented
        options={PIPELINE_POLL_CHOICES.map((choice) => ({
          value: String(choice),
          label: <span className="tabular-nums">{t("pipelines.pollSeconds", { n: choice })}</span>,
        }))}
        value={String(seconds)}
        onChange={(value) => void setSeconds(Number(value))}
        layoutId="cf-set-pipeline-poll"
        ariaLabel={t("pipelines.pollLabel")}
      />
      {seconds === DEFAULT_PIPELINE_POLL && (
        <div className="mt-2">
          <Note>{t("pipelines.pollDefaultNote")}</Note>
        </div>
      )}
    </>
  );
}

function AvailabilityPane() {
  const t = useT();
  return (
    <>
      <p className="mb-2 text-[12px] leading-snug text-[var(--cf-text)]">
        {t("pipelines.availabilityBody")}
      </p>
      <Note>{t("pipelines.availabilityHosts")}</Note>
    </>
  );
}

/**
 * «Integraciones › Pipelines»: how often a live run is re-read, and where the tab appears — the two
 * panes of what was a section of its own until 2026-10-09, now one pane beside the accounts it
 * depends on.
 */
export function PipelinesPane() {
  const t = useT();
  return (
    <div>
      <PollingPane />
      <div className="mt-5 border-t border-[var(--cf-border)] pt-4">
        <h3 className="mb-2.5 text-[13px] font-semibold text-[var(--cf-text)]">{t("pipelines.availabilityTab")}</h3>
        <AvailabilityPane />
      </div>
    </div>
  );
}
