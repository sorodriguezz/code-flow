/** «Tiempo»: Unix timestamps, date arithmetic, cron and ISO-8601 durations. */
import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { buttonClass, iconButtonClass } from "../common/Button";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import {
  addDuration,
  allZones,
  dateDiff,
  durationSeconds,
  EMPTY_DURATION,
  formatInZone,
  formatIsoDuration,
  parseDateInput,
  parseIsoDuration,
  relativeTime,
  secondsToDuration,
  toLocalIso,
  type DurationParts,
  type TimestampUnit,
} from "../../lib/toolbox/time";
import { describeCron, nextRuns, parseCron } from "../../lib/toolbox/cron";
import { attempt, ErrorLine, FactTable, Labeled, OptionsRow, PaneHead, paneClass, smallInput } from "./kit";
import { CheckLabel } from "./EncodeTools";

/** Ticks once a second while mounted — for "now" and the relative times. */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const DEFAULT_ZONES = ["UTC", "America/Santiago", "America/New_York", "Europe/Madrid", "Asia/Tokyo"];

export function TimestampTool() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const now = useNow();
  const [input, setInput] = useToolField("timestamp", "input", "");
  const [unit, setUnit] = useToolField<TimestampUnit | "auto">("timestamp", "unit", "auto");
  const [zones, setZones] = useToolField<string[]>("timestamp", "zones", DEFAULT_ZONES);
  const [adding, setAdding] = useState("");
  const zoneOptions = useMemo(() => allZones().map((z) => ({ value: z, label: z })), []);
  const parsed = useMemo(() => attempt(() => parseDateInput(input, unit)), [input, unit, input.trim() ? 0 : now]); // eslint-disable-line react-hooks/exhaustive-deps
  const d = parsed.value?.date;
  const ms = d?.getTime() ?? 0;
  return (
    <>
      <OptionsRow>
        <input className={`${smallInput} h-[30px] w-80 font-mono text-[13px]`} value={input} spellCheck={false} placeholder={t("toolbox.timestamp.placeholder")} onChange={(e) => setInput(e.target.value)} />
        <Segmented
          layoutId="toolbox-ts-unit"
          size="sm"
          value={unit}
          onChange={setUnit}
          options={[
            { value: "auto", label: t("toolbox.timestamp.auto") },
            { value: "s", label: "s" },
            { value: "ms", label: "ms" },
            { value: "us", label: "µs" },
            { value: "ns", label: "ns" },
          ]}
        />
        <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => setInput(String(Math.floor(Date.now() / 1000)))}>
          {t("toolbox.timestamp.now")}
        </button>
        {parsed.value?.unit ? <span className="text-[12px] text-[var(--cf-text-muted)]">{t("toolbox.timestamp.readAs", { unit: parsed.value.unit })}</span> : null}
      </OptionsRow>
      <ErrorLine error={parsed.error} />
      {d ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
          <FactTable
            rows={[
              [t("toolbox.timestamp.seconds"), String(Math.floor(ms / 1000))],
              [t("toolbox.timestamp.millis"), String(ms)],
              [t("toolbox.timestamp.micros"), `${ms}000`],
              ["ISO 8601 (UTC)", d.toISOString()],
              [t("toolbox.timestamp.local"), toLocalIso(d)],
              ["RFC 2822", d.toUTCString()],
              [t("toolbox.timestamp.relative"), relativeTime(d, language, now)],
              [t("toolbox.timestamp.dayOfYear"), String(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000))],
              [t("toolbox.timestamp.weekday"), d.toLocaleDateString(language, { weekday: "long" })],
            ]}
          />
          <div className={paneClass}>
            <PaneHead label={t("toolbox.timestamp.zones")}>
              <Select size="compact" value={adding} placeholder={t("toolbox.timestamp.addZone")} onChange={setAdding} options={zoneOptions} className="w-52" />
              <button type="button" disabled={!adding || zones.includes(adding)} className={iconButtonClass({ size: "xs" })} aria-label={t("toolbox.timestamp.addZone")} onClick={() => setZones([...zones, adding])}>
                <Plus size={13} />
              </button>
            </PaneHead>
            <div className="min-h-0 flex-1 overflow-auto">
              {zones.map((z) => {
                const text = attempt(() => formatInZone(d, z));
                return (
                  <div key={z} className="group flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 text-[12.5px]">
                    <span className="w-48 shrink-0 truncate text-[var(--cf-text-muted)]">{z}</span>
                    <span className="min-w-0 flex-1 select-text font-mono">{text.value ?? text.error}</span>
                    <button type="button" className={`${iconButtonClass({ size: "xs" })} opacity-0 group-hover:opacity-100`} aria-label={t("toolbox.remove")} onClick={() => setZones(zones.filter((x) => x !== z))}>
                      <X size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

const DURATION_FIELDS: (keyof DurationParts)[] = ["years", "months", "weeks", "days", "hours", "minutes", "seconds"];

const localInput = (d: Date) => toLocalIso(d).slice(0, 19);

export function DateCalcTool() {
  const t = useT();
  const [from, setFrom] = useToolField("date-calc", "from", localInput(new Date()));
  const [to, setTo] = useToolField("date-calc", "to", localInput(new Date(Date.now() + 30 * 86400000)));
  const [dur, setDur] = useToolField<DurationParts>("date-calc", "dur", { ...EMPTY_DURATION, days: 30 });
  const [sign, setSign] = useToolField<1 | -1>("date-calc", "sign", 1);
  const a = new Date(from);
  const b = new Date(to);
  const valid = !Number.isNaN(a.getTime()) && !Number.isNaN(b.getTime());
  const diff = valid ? dateDiff(a, b) : null;
  const added = !Number.isNaN(a.getTime()) ? addDuration(a, dur, sign) : null;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col gap-3">
        <OptionsRow>
          <Labeled label={t("toolbox.from")}>
            <input type="datetime-local" step={1} className={`${smallInput} h-[30px]`} value={from} onChange={(e) => setFrom(e.target.value)} />
          </Labeled>
          <Labeled label={t("toolbox.to")}>
            <input type="datetime-local" step={1} className={`${smallInput} h-[30px]`} value={to} onChange={(e) => setTo(e.target.value)} />
          </Labeled>
        </OptionsRow>
        {diff ? (
          <FactTable
            rows={[
              [t("toolbox.date.difference"), `${diff.negative ? "−" : ""}${t("toolbox.date.calendar", { y: diff.years, m: diff.months, d: diff.days })} ${String(diff.hours).padStart(2, "0")}:${String(diff.minutes).padStart(2, "0")}:${String(diff.seconds).padStart(2, "0")}`],
              [t("toolbox.date.totalDays"), (Math.round(diff.totalDays * 1000) / 1000).toLocaleString()],
              [t("toolbox.date.totalHours"), (Math.round((diff.totalSeconds / 3600) * 100) / 100).toLocaleString()],
              [t("toolbox.date.totalSeconds"), diff.totalSeconds.toLocaleString()],
              [t("toolbox.date.businessDays"), diff.businessDays.toLocaleString()],
              ["ISO 8601", formatIsoDuration({ ...EMPTY_DURATION, years: diff.years, months: diff.months, days: diff.days, hours: diff.hours, minutes: diff.minutes, seconds: diff.seconds }, diff.negative)],
            ]}
          />
        ) : null}
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <OptionsRow>
          <Segmented layoutId="toolbox-date-sign" size="sm" value={sign === 1 ? "add" : "sub"} onChange={(v) => setSign(v === "add" ? 1 : -1)} options={[{ value: "add", label: t("toolbox.date.add") }, { value: "sub", label: t("toolbox.date.subtract") }]} />
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("toolbox.date.toFrom")}</span>
        </OptionsRow>
        <div className="grid grid-cols-4 gap-2">
          {DURATION_FIELDS.map((f) => (
            <label key={f} className="flex flex-col gap-1 text-[11.5px] text-[var(--cf-text-muted)]">
              {t(`toolbox.duration.${f}`)}
              <input type="number" className={smallInput} value={dur[f]} onChange={(e) => setDur({ ...dur, [f]: Number(e.target.value) || 0 })} />
            </label>
          ))}
        </div>
        {added ? <FactTable rows={[[t("toolbox.date.result"), toLocalIso(added)], ["ISO (UTC)", added.toISOString()], [t("toolbox.timestamp.seconds"), String(Math.floor(added.getTime() / 1000))]]} /> : null}
      </div>
    </div>
  );
}

const CRON_PRESETS = ["*/5 * * * *", "0 * * * *", "0 9 * * 1-5", "30 2 * * *", "0 0 1 * *", "0 */6 * * *", "0 8-18/2 * * 1-5", "@weekly"];

export function CronTool() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [expr, setExpr] = useToolField("cron", "expr", "*/15 9-17 * * 1-5");
  const [utc, setUtc] = useToolField("cron", "utc", false);
  const parsed = useMemo(() => attempt(() => parseCron(expr)), [expr]);
  const lang = language === "es" ? "es" : "en";
  const runs = useMemo(() => (parsed.value ? nextRuns(parsed.value, new Date(), 10, utc) : []), [parsed.value, utc]);
  const fields = parsed.value?.hasSeconds ? ["sec", "min", "hour", "dom", "month", "dow"] : ["min", "hour", "dom", "month", "dow"];
  return (
    <>
      <OptionsRow>
        <input className={`${smallInput} h-[34px] w-96 font-mono text-[15px]`} value={expr} spellCheck={false} onChange={(e) => setExpr(e.target.value)} />
        <CheckLabel checked={utc} onChange={setUtc} label={t("toolbox.cron.utc")} />
      </OptionsRow>
      <div className="flex flex-wrap gap-1.5">
        {CRON_PRESETS.map((p) => (
          <button key={p} type="button" className="rounded-md bg-[var(--cf-hover)] px-2 py-0.5 font-mono text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]" onClick={() => setExpr(p)}>
            {p}
          </button>
        ))}
      </div>
      <ErrorLine error={parsed.error} />
      {parsed.value ? (
        <>
          <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-4 py-3 text-[15px] text-[var(--cf-text)]">{describeCron(parsed.value, lang)}</div>
          <div className="flex gap-4 font-mono text-[11.5px] text-[var(--cf-text-faint)]">
            {expr.trim().startsWith("@") ? null : expr.trim().split(/\s+/).map((part, i) => (
              <span key={i} className="flex flex-col items-center">
                <span className="text-[13px] text-[var(--cf-text)]">{part}</span>
                {t(`toolbox.cron.field.${fields[i] as "min"}`)}
              </span>
            ))}
          </div>
          <FactTable className="flex-1" rows={runs.map((d, i) => [`${i + 1}`, `${utc ? d.toISOString().replace("T", " ").slice(0, 19) + " UTC" : toLocalIso(d).replace("T", " ").slice(0, 19)} · ${d.toLocaleDateString(language, { weekday: "long" })}`])} />
        </>
      ) : null}
    </>
  );
}

export function DurationTool() {
  const t = useT();
  const [input, setInput] = useToolField("duration", "input", "P1Y2M10DT2H30M");
  const [seconds, setSeconds] = useToolField("duration", "seconds", "");
  const parsed = useMemo(() => (input.trim() ? attempt(() => parseIsoDuration(input)) : { value: null, error: null }), [input]);
  const fromSeconds = seconds.trim() && Number.isFinite(Number(seconds)) ? secondsToDuration(Number(seconds)) : null;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col gap-3">
        <input className={`${smallInput} h-[34px] font-mono text-[15px]`} value={input} spellCheck={false} onChange={(e) => setInput(e.target.value)} />
        <ErrorLine error={parsed.error} />
        {parsed.value ? (
          <FactTable
            rows={[
              ...DURATION_FIELDS.filter((f) => parsed.value!.parts[f]).map((f): [string, string] => [t(`toolbox.duration.${f}`), String(parsed.value!.parts[f])]),
              [t("toolbox.duration.totalSeconds"), `${parsed.value.negative ? "-" : ""}${durationSeconds(parsed.value.parts).toLocaleString()}`],
              [t("toolbox.duration.totalHours"), (durationSeconds(parsed.value.parts) / 3600).toLocaleString()],
              [t("toolbox.duration.fromNow"), toLocalIso(addDuration(new Date(), parsed.value.parts, parsed.value.negative ? -1 : 1))],
            ]}
          />
        ) : null}
        <p className="text-[11.5px] text-[var(--cf-text-faint)]">{t("toolbox.duration.nominal")}</p>
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <Labeled label={t("toolbox.duration.fromSeconds")}>
          <input className={`${smallInput} w-40 font-mono`} value={seconds} onChange={(e) => setSeconds(e.target.value)} placeholder="90061" />
        </Labeled>
        {fromSeconds ? <FactTable rows={[["ISO 8601", formatIsoDuration(fromSeconds, Number(seconds) < 0)], [t("toolbox.duration.readable"), `${fromSeconds.days}d ${fromSeconds.hours}h ${fromSeconds.minutes}m ${fromSeconds.seconds}s`]]} /> : null}
      </div>
    </div>
  );
}
