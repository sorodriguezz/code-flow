import { useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { useFlowsStore } from "../../state/flowsStore";
import { useT } from "../../state/languageStore";

/** A few zones to pick from; any IANA name can be typed. */
const ZONES = [
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/Bogota",
  "America/Lima",
  "America/Mexico_City",
  "America/New_York",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/Madrid",
  "Europe/London",
  "UTC",
];

/**
 * A flow's own settings: the zone its schedules and `$now` read, what happens when a trigger fires
 * while it is still running, when its runs end in a notification, and how many AI calls it may make
 * an hour. Written into the document, so they are undone, versioned and exported with the flow.
 */
export function FlowSettingsDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const settings = useFlowsStore((s) => s.draft?.spec.settings ?? {});
  const [timezone, setTimezone] = useState(typeof settings.timezone === "string" ? settings.timezone : "");
  const [overlap, setOverlap] = useState(typeof settings.overlap === "string" ? settings.overlap : "skip");
  const [notifyOn, setNotifyOn] = useState(typeof settings.notifyOn === "string" ? settings.notifyOn : "failure");
  const [aiPerHour, setAiPerHour] = useState(typeof settings.aiPerHour === "number" ? String(settings.aiPerHour) : "60");

  const save = () => {
    const draft = useFlowsStore.getState().draft;
    if (!draft) return;
    const next = { ...draft.spec.settings };
    if (timezone.trim()) next.timezone = timezone.trim();
    else delete next.timezone;
    next.overlap = overlap;
    next.notifyOn = notifyOn;
    const cap = Number.parseInt(aiPerHour, 10);
    next.aiPerHour = Number.isFinite(cap) && cap >= 0 ? Math.min(cap, 10_000) : 60;
    useFlowsStore.getState().edit({ ...draft.spec, settings: next });
    onClose();
  };

  const row = (label: string, control: ReactNode, hint?: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{label}</span>
      {control}
      {hint && <span className="text-[11.5px] text-[var(--cf-text-faint)]">{hint}</span>}
    </label>
  );

  return (
    <ApiModal
      icon={Settings2}
      title={t("flows.settingsDialog.title")}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" onClick={save}>
            {t("common.save")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4 px-4 py-4">
        {row(
          t("flows.settingsDialog.timezone"),
          <>
            <input
              list="cf-flow-zones"
              className={fieldClass({ size: "sm", className: "max-w-[300px] font-mono" })}
              value={timezone}
              placeholder={t("flows.settingsDialog.timezoneSystem")}
              onChange={(event) => setTimezone(event.target.value)}
            />
            <datalist id="cf-flow-zones">
              {ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
          </>,
          t("flows.settingsDialog.timezoneHint"),
        )}
        {row(
          t("flows.settingsDialog.overlap"),
          <div className="max-w-[300px]">
            <Select
              value={overlap}
              onChange={setOverlap}
              options={[
                { value: "skip", label: t("flows.settingsDialog.overlapSkip") },
                { value: "queue", label: t("flows.settingsDialog.overlapQueue") },
                { value: "parallel", label: t("flows.settingsDialog.overlapParallel") },
              ]}
              size="sm"
            />
          </div>,
        )}
        {row(
          t("flows.settingsDialog.notifyOn"),
          <div className="max-w-[300px]">
            <Select
              value={notifyOn}
              onChange={setNotifyOn}
              options={[
                { value: "failure", label: t("flows.settingsDialog.notifyFailure") },
                { value: "always", label: t("flows.settingsDialog.notifyAlways") },
                { value: "never", label: t("flows.settingsDialog.notifyNever") },
              ]}
              size="sm"
            />
          </div>,
          t("flows.settingsDialog.notifyHint"),
        )}
        {row(
          t("flows.settingsDialog.aiPerHour"),
          <input
            type="number"
            min={0}
            className={fieldClass({ size: "sm", className: "w-32" })}
            value={aiPerHour}
            onChange={(event) => setAiPerHour(event.target.value)}
          />,
          t("flows.settingsDialog.aiPerHourHint"),
        )}
      </div>
    </ApiModal>
  );
}
