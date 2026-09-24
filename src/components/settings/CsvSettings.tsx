import { Fragment, useMemo } from "react";
import { Checkbox } from "../common/Checkbox";
import { useCsvStore } from "../../state/csvStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { findTheme, rainbowPalette } from "../../lib/codeThemes";
import {
  CSV_SEPARATORS,
  CSV_START,
  separatorById,
  tokenizeCsvLine,
  type CsvSeparatorChoice,
} from "../../lib/csvDialect";

/**
 * Settings › Editor › CSV: whether delimited files are coloured by column, and what a `.csv` is
 * split on. The per-file override lives in the editor's toolbar, not here — this is the default.
 */

/** Nine columns on purpose: one more than the palette, so the preview shows the colours cycling. */
const SAMPLE = [
  ["id", "user", "city", "role", "since", "active", "team", "score", "note"],
  ["1", "ana", "Lisboa", "dev", "2021-03-01", "true", "core", "87", '"lead, remote"'],
  ["2", "luis", "Lima", "qa", "2022-11-12", "false", "web", "64", ""],
  ["3", "marta", "Oslo", "ops", "2020-07-30", "true", "infra", "91", '"said ""hi"""'],
];

const CHOICES: CsvSeparatorChoice[] = ["auto", ...CSV_SEPARATORS.map((entry) => entry.id)];

/** The sample, split exactly as the editor would split it, in the colours the editor would use. */
function Preview({ separator }: { separator: CsvSeparatorChoice }) {
  const resolved = useThemeStore((s) => s.resolved);
  const themeId = useThemeStore((s) => (s.resolved === "dark" ? s.darkThemeId : s.lightThemeId));
  const theme = findTheme(themeId, resolved);
  const palette = useMemo(() => rainbowPalette(theme), [theme]);
  // "Automático" is shown with a comma — it is what a `.csv` with nothing unusual in it detects as.
  const sep = separatorById(separator === "auto" ? "comma" : separator).char;

  let state = CSV_START;
  const lines = SAMPLE.map((row) => {
    const line = row.join(sep);
    const { spans, end } = tokenizeCsvLine(line, sep, state);
    state = end;
    return { line, spans };
  });

  return (
    <pre
      className="overflow-x-auto rounded-lg border border-[var(--cf-border)] px-3 py-2.5 font-mono text-[12px] leading-[1.6]"
      style={{ background: theme.ui.bg }}
    >
      {lines.map(({ line, spans }, row) => (
        <Fragment key={row}>
          {spans.map((span, index) => {
            const text = line.slice(span.start, spans[index + 1]?.start ?? line.length);
            const color = span.slot === null ? theme.ui.textMuted : palette[span.slot - 1];
            // A tab is invisible and collapses to nothing useful in a `<pre>` this narrow; the arrow
            // is what the editor's whitespace rendering would show.
            return (
              <span key={index} style={{ color }}>
                {text === "\t" ? "⇥ " : text}
              </span>
            );
          })}
          {"\n"}
        </Fragment>
      ))}
    </pre>
  );
}

export function CsvSettings() {
  const t = useT();
  const rainbow = useCsvStore((s) => s.rainbow);
  const separator = useCsvStore((s) => s.separator);
  const setRainbow = useCsvStore((s) => s.setRainbow);
  const setSeparator = useCsvStore((s) => s.setSeparator);

  return (
    <div className="space-y-4">
      <label className="flex cursor-pointer items-start gap-2">
        <span className="mt-[1px] shrink-0">
          <Checkbox checked={rainbow} onChange={(value) => void setRainbow(value)} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] leading-snug text-[var(--cf-text)]">{t("csv.rainbowLabel")}</span>
          <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
            {t("csv.rainbowHint")}
          </span>
        </span>
      </label>

      <div className={rainbow ? "" : "pointer-events-none opacity-50"}>
        <div className="mb-1.5 text-[13px] text-[var(--cf-text)]">{t("csv.separatorLabel")}</div>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("csv.separatorLabel")}>
          {CHOICES.map((choice) => {
            const active = separator === choice;
            const entry = choice === "auto" ? null : separatorById(choice);
            return (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={!rainbow}
                onClick={() => void setSeparator(choice)}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors ${
                  active
                    ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                    : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
                }`}
              >
                {entry && <span className="w-3 text-center font-mono leading-none">{entry.glyph}</span>}
                {entry ? t(entry.labelKey) : t("csv.sepAuto")}
              </button>
            );
          })}
        </div>
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("csv.separatorHint")}</p>
      </div>

      <div className={rainbow ? "" : "opacity-50"}>
        <div className="mb-1.5 text-[13px] text-[var(--cf-text)]">{t("csv.preview")}</div>
        <Preview separator={separator} />
      </div>
    </div>
  );
}
