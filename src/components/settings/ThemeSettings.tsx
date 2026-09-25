import { useState } from "react";
import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useThemeStore } from "../../state/themeStore";
import { useGlassStore } from "../../state/glassStore";
import { findTheme, themesFor, type CodeThemeUi } from "../../lib/codeThemes";
import { usePlatform } from "../../lib/platform";
import { ACCENT_OPTIONS, useAccentStore } from "../../state/accentStore";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Tooltip } from "../common/Tooltip";
import type { ThemePreference } from "../../types/domain";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { PaneBlock, RailSection } from "./settingsNav";

const OPTIONS: { id: ThemePreference; labelKey: TranslationKey; icon: typeof Sun }[] = [
  { id: "light", labelKey: "settings.themeLight", icon: Sun },
  { id: "dark", labelKey: "settings.themeDark", icon: Moon },
  { id: "system", labelKey: "settings.themeSystem", icon: Laptop },
];

/**
 * One mode, drawn: its frame, and a sheet sitting on it with its hairline — the two surfaces the
 * whole window is made of — with a line of text and the accent's own shade for that mode.
 *
 * Painted from the schemes actually chosen for each mode rather than from two fixed palettes, so
 * the tile shows what picking it will do: someone on Dracula sees Dracula under "Dark".
 */
function ModeDrawing({ ui, accent }: { ui: CodeThemeUi; accent: string }) {
  return (
    <span className="absolute inset-0" style={{ background: ui.bg }}>
      {/* The navigation on the frame: three glyph-sized marks, quiet. */}
      <span className="absolute left-2 top-3 flex flex-col gap-1.5">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="block h-1.5 w-2.5 rounded-full"
            style={{ background: i === 0 ? accent : ui.textMuted, opacity: i === 0 ? 1 : 0.35 }}
          />
        ))}
      </span>
      {/* The sheet: the page where work happens, one step lighter (or darker) than the frame. */}
      <span
        className="absolute bottom-0 left-7 right-0 top-2.5 rounded-tl-[6px]"
        style={{ background: ui.surface, boxShadow: `0 0 0 1px ${ui.border}` }}
      >
        <span className="absolute left-2.5 top-2.5 block h-1 w-10 rounded-full" style={{ background: ui.text, opacity: 0.7 }} />
        <span
          className="absolute left-2.5 top-[18px] block h-1 w-16 rounded-full"
          style={{ background: ui.textMuted, opacity: 0.45 }}
        />
        <span className="absolute bottom-2.5 left-2.5 block h-2.5 w-9 rounded-[3px]" style={{ background: accent }} />
      </span>
    </span>
  );
}

/**
 * Light, dark or the system's choice, as three tiles that show the mode instead of naming it.
 *
 * Same setting and same three values as the row of buttons it replaces. "System" is both drawings
 * split on the diagonal, because that is what it means: whichever of the two the OS says.
 */
function ModeTiles() {
  const t = useT();
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const lightId = useThemeStore((s) => s.lightThemeId);
  const darkId = useThemeStore((s) => s.darkThemeId);
  const accentId = useAccentStore((s) => s.accentId);
  const accent = ACCENT_OPTIONS.find((option) => option.id === accentId) ?? ACCENT_OPTIONS[0];
  const light = findTheme(lightId, "light").ui;
  const dark = findTheme(darkId, "dark").ui;

  return (
    <div className="grid max-w-[480px] grid-cols-3 gap-2.5">
      {OPTIONS.map(({ id, labelKey, icon: Icon }) => {
        const selected = preference === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => setPreference(id)}
            aria-pressed={selected}
            // The ring is the selection; a box-shadow, so picking a tile moves nothing.
            className={`flex flex-col gap-2 rounded-lg p-2 text-left transition-[box-shadow,background-color] duration-100 ${
              selected
                ? "shadow-[0_0_0_2px_var(--cf-accent)]"
                : "shadow-[0_0_0_1px_var(--cf-border-strong)] hover:bg-[var(--cf-hover)]"
            }`}
          >
            <span aria-hidden className="relative block h-16 overflow-hidden rounded-md">
              {id === "dark" ? (
                <ModeDrawing ui={dark} accent={accent.dark} />
              ) : (
                <ModeDrawing ui={light} accent={accent.light} />
              )}
              {id === "system" && (
                <span className="absolute inset-0 [clip-path:polygon(100%_0,100%_100%,0_100%)]">
                  <ModeDrawing ui={dark} accent={accent.dark} />
                </span>
              )}
            </span>
            <span
              className={`flex items-center gap-1.5 px-0.5 text-[13px] font-medium ${
                selected ? "text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"
              }`}
            >
              <Icon size={14} className={`shrink-0 ${selected ? "text-[var(--cf-accent)]" : ""}`} />
              {t(labelKey)}
              {selected && <Check size={13} className="ml-auto shrink-0 text-[var(--cf-accent)]" />}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Accent swatches plus a live preview of the places the accent actually lands: a solid button, a
 * soft-tinted selection, a link and a chip. Picking a color from a row of identical dots is
 * guesswork; seeing what it does to the UI isn't.
 *
 * Each swatch carries "Aa" in the text colour that will sit on it (`--cf-on-accent`), because every
 * accent is a contrast pair rather than a hue: white ink on the light shades, dark ink on the dark
 * ones. The swatch proves it can be written on. */
function AccentPicker() {
  const t = useT();
  const resolved = useThemeStore((s) => s.resolved);
  const accentId = useAccentStore((s) => s.accentId);
  const setAccent = useAccentStore((s) => s.setAccent);

  return (
    <div className="space-y-3">
      <p className="max-w-[62ch] text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("settings.accentColorHint")}</p>
      <div className="flex flex-wrap gap-2.5">
        {ACCENT_OPTIONS.map((option) => {
          const selected = accentId === option.id;
          const swatch = resolved === "dark" ? option.dark : option.light;
          const name = t(`accent.${option.id}` as TranslationKey);
          return (
            <Tooltip key={option.id} label={name}>
              <button
                type="button"
                aria-label={name}
                aria-pressed={selected}
                onClick={() => setAccent(option.id, resolved)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-semibold text-[var(--cf-on-accent)] transition-transform duration-100 hover:scale-110"
                style={{
                  background: swatch,
                  // Ring drawn with a shadow so it doesn't shift the layout when it appears: a gap in
                  // the sheet's own colour, then the swatch again.
                  boxShadow: selected
                    ? `0 0 0 2px var(--cf-surface), 0 0 0 4px ${swatch}`
                    : "inset 0 0 0 1px color-mix(in oklab, var(--cf-text) 12%, transparent)",
                }}
              >
                Aa
              </button>
            </Tooltip>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg bg-[var(--cf-sunken)] p-3">
        <span className={buttonClass({ variant: "primary", size: "sm", className: "pointer-events-none" })}>
          {t("settings.accentPreviewButton")}
        </span>
        {/* The selected-row fill (`rowClass`), shrunk to its label. */}
        <span className="inline-flex h-7 items-center rounded-md bg-[var(--cf-accent-soft)] px-2 text-[13px] text-[var(--cf-text)]">
          {t("settings.accentPreviewSelected")}
        </span>
        <span className="text-[13px] text-[var(--cf-accent)] underline underline-offset-2">
          {t("settings.accentPreviewLink")}
        </span>
        <span className={chipClass("accent", "ml-auto")}>{t(`accent.${accentId}` as TranslationKey)}</span>
      </div>
    </div>
  );
}

/**
 * Whether the window lets the desktop through, and how much — Sí/No, and the level once it is Sí.
 *
 * The slider repaints this window on every step (three CSS properties, see `glassStore.preview`)
 * and saves on release, which is when the other windows follow: a setting write per pixel would be
 * announced to all of them. Same shape as the notification volume.
 */
function TransparencyControl() {
  const t = useT();
  const enabled = useGlassStore((s) => s.enabled);
  const level = useGlassStore((s) => s.level);
  const setEnabled = useGlassStore((s) => s.setEnabled);
  const setLevel = useGlassStore((s) => s.setLevel);
  const preview = useGlassStore((s) => s.preview);
  const [draft, setDraft] = useState<number | null>(null);
  const shown = draft ?? level;

  const commit = () => {
    if (draft === null) return;
    void setLevel(draft);
    setDraft(null);
  };

  return (
    <div className="space-y-3">
      <Segmented
        ariaLabel={t("settings.transparency")}
        layoutId="cf-glass-switch"
        value={enabled ? "on" : "off"}
        onChange={(value) => void setEnabled(value === "on")}
        options={[
          { value: "on", label: t("settings.transparencyOn") },
          { value: "off", label: t("settings.transparencyOff") },
        ]}
      />
      {enabled && (
        <label className="flex items-center gap-2.5">
          <span className="w-[72px] shrink-0 text-[13px] text-[var(--cf-text)]">{t("settings.transparencyLevel")}</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={shown}
            onChange={(event) => {
              const value = Number(event.target.value);
              setDraft(value);
              preview(value);
            }}
            onPointerUp={commit}
            onKeyUp={commit}
            onBlur={commit}
            className="w-full max-w-[280px] accent-[var(--cf-accent)]"
          />
          <span className="w-10 shrink-0 text-right text-[12px] tabular-nums text-[var(--cf-text-muted)]">{shown}%</span>
        </label>
      )}
    </div>
  );
}

/** The selected scheme, shown in a collapsed header: its name next to a chip painted in its own
 * background and border, so the palette is recognizable before opening anything. */
function ThemeSummary({ mode }: { mode: "light" | "dark" }) {
  const id = useThemeStore((s) => (mode === "dark" ? s.darkThemeId : s.lightThemeId));
  const theme = findTheme(id, mode);
  return (
    <>
      <span
        className="h-3.5 w-3.5 shrink-0 rounded-full border"
        style={{ background: theme.ui.bg, borderColor: theme.ui.border }}
      />
      <span className="truncate text-[12px] text-[var(--cf-text-muted)]">{theme.name}</span>
    </>
  );
}

/** The schemes available for one mode, each previewed with its own colors — a name like
 * "Gruvbox" means nothing until you see it, so every card paints itself in the palette it's
 * offering (background, a comment, a keyword, a string). */
function ThemeGrid({ mode }: { mode: "light" | "dark" }) {
  const selectedId = useThemeStore((s) => (mode === "dark" ? s.darkThemeId : s.lightThemeId));
  const setThemeId = useThemeStore((s) => s.setThemeId);

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {themesFor(mode).map((theme) => {
        const selected = theme.id === selectedId;
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => void setThemeId(mode, theme.id)}
            aria-pressed={selected}
            // Idle, each card wears its own scheme's hairline; picked, the same 2px accent ring as
            // the mode tiles above, so "selected" reads one way across this section.
            style={{ background: theme.ui.bg, boxShadow: selected ? undefined : `inset 0 0 0 1px ${theme.ui.border}` }}
            className={`overflow-hidden rounded-lg px-2.5 py-2 text-left ${
              selected ? "shadow-[0_0_0_2px_var(--cf-accent)]" : ""
            }`}
          >
            <span className="flex items-center gap-1" style={{ color: theme.ui.text }}>
              <span className="truncate text-[12px] font-medium">{theme.name}</span>
              {selected && <Check size={12} className="ml-auto shrink-0 text-[var(--cf-accent)]" />}
            </span>
            <span className="mt-1 block font-mono text-[10.5px] leading-[1.4]">
              <span style={{ color: theme.tokens.comment }}>// preview</span>
              <br />
              <span style={{ color: theme.tokens.keyword }}>const </span>
              <span style={{ color: theme.tokens.variable }}>name</span>
              <span style={{ color: theme.tokens.operator }}> = </span>
              <span style={{ color: theme.tokens.string }}>"{theme.id.split("-")[0]}"</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ThemeSettings() {
  const t = useT();
  const resolved = useThemeStore((s) => s.resolved);
  // The two platforms with a backdrop to show: vibrancy on macOS, Acrylic/Mica on Windows. Anywhere
  // else a see-through window would be a sharp, unblurred desktop behind the text.
  const platform = usePlatform();
  const glassAvailable = platform === "macos" || platform === "windows";
  // The mode you are looking at comes first — the other is a deliberate visit.
  const modes: ("light" | "dark")[] = resolved === "dark" ? ["dark", "light"] : ["light", "dark"];

  return (
    <RailSection section="appearance" title={t("settings.appearance")} hint={t("settings.chooseTheme")} fallback="look">
      {(tab) => (
        <>
          {tab === "look" && (
            <>
              <PaneBlock title={t("settings.tabThemeMode")}>
                <ModeTiles />
              </PaneBlock>

              {/* The picker says what an accent is for in its own first line. */}
              <PaneBlock title={t("settings.accentColor")}>
                <AccentPicker />
              </PaneBlock>

              {glassAvailable && (
                <PaneBlock title={t("settings.transparency")}>
                  <TransparencyControl />
                </PaneBlock>
              )}
            </>
          )}

          {tab === "themes" && (
            <div className="space-y-5">
              {modes.map((mode) => (
                <div key={mode}>
                  {/* The scheme in force is named beside its heading, so it reads without hunting
                      the grid for the ticked card. */}
                  <p className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-[var(--cf-text)]">
                    {mode === "dark" ? <Moon size={14} /> : <Sun size={14} />}
                    {t(mode === "dark" ? "settings.forDarkMode" : "settings.forLightMode")}
                    <span className="ml-auto flex min-w-0 items-center gap-1.5 font-normal">
                      <ThemeSummary mode={mode} />
                    </span>
                  </p>
                  <ThemeGrid mode={mode} />
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </RailSection>
  );
}
