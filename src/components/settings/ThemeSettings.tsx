import { Check, Laptop, Moon, Sun } from "lucide-react";
import { useThemeStore } from "../../state/themeStore";
import { findTheme, themesFor } from "../../lib/codeThemes";
import { ACCENT_OPTIONS, useAccentStore } from "../../state/accentStore";
import { ActivePill } from "../common/ActivePill";
import type { ThemePreference } from "../../types/domain";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { PaneBlock, RailSection } from "./settingsNav";

const OPTIONS: { id: ThemePreference; labelKey: TranslationKey; icon: typeof Sun }[] = [
  { id: "light", labelKey: "settings.themeLight", icon: Sun },
  { id: "dark", labelKey: "settings.themeDark", icon: Moon },
  { id: "system", labelKey: "settings.themeSystem", icon: Laptop },
];

/** Accent swatches plus a live preview of the three places the accent actually lands: a solid
 * button, a soft-tinted selection, and a link. Picking a color from a row of identical dots is
 * guesswork; seeing what it does to the UI isn't. */
function AccentPicker() {
  const t = useT();
  const resolved = useThemeStore((s) => s.resolved);
  const accentId = useAccentStore((s) => s.accentId);
  const setAccent = useAccentStore((s) => s.setAccent);

  return (
    <div className="space-y-2.5">
      <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.accentColorHint")}</p>
      <div className="flex flex-wrap gap-2">
        {ACCENT_OPTIONS.map((option) => {
          const selected = accentId === option.id;
          const swatch = resolved === "dark" ? option.dark : option.light;
          return (
            <button
              key={option.id}
              title={option.label}
              aria-label={option.label}
              aria-pressed={selected}
              onClick={() => setAccent(option.id, resolved)}
              className="flex h-7 w-7 items-center justify-center rounded-full transition-transform hover:scale-110"
              style={{
                background: swatch,
                // Ring drawn with a shadow so it doesn't shift the layout when it appears.
                boxShadow: selected ? `0 0 0 2px var(--cf-surface), 0 0 0 4px ${swatch}` : undefined,
              }}
            >
              {selected && <Check size={13} className="text-white" strokeWidth={3} />}
            </button>
          );
        })}
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2.5 py-2">
        <span className="rounded-md bg-[var(--cf-accent)] px-2 py-1 text-[11px] font-medium text-white">
          {t("settings.accentPreviewButton")}
        </span>
        <span className="rounded-md bg-[var(--cf-accent-soft)] px-2 py-1 text-[11px] font-medium text-[var(--cf-accent)]">
          {t("settings.accentPreviewSelected")}
        </span>
        <span className="text-[11px] text-[var(--cf-accent)] underline">{t("settings.accentPreviewLink")}</span>
      </div>
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
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {themesFor(mode).map((theme) => {
        const selected = theme.id === selectedId;
        return (
          <button
            key={theme.id}
            onClick={() => void setThemeId(mode, theme.id)}
            style={{ background: theme.ui.bg, borderColor: selected ? undefined : theme.ui.border }}
            className={`overflow-hidden rounded-lg border px-2.5 py-2 text-left ${
              selected ? "border-[var(--cf-accent)] ring-1 ring-[var(--cf-accent)]" : ""
            }`}
          >
            <span className="flex items-center gap-1" style={{ color: theme.ui.text }}>
              <span className="truncate text-[12px] font-medium">{theme.name}</span>
              {selected && <Check size={11} className="ml-auto shrink-0 text-[var(--cf-accent)]" />}
            </span>
            <span className="mt-1 block font-mono text-[10px] leading-[1.4]">
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
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
  const resolved = useThemeStore((s) => s.resolved);
  // The mode you are looking at comes first — the other is a deliberate visit.
  const modes: ("light" | "dark")[] = resolved === "dark" ? ["dark", "light"] : ["light", "dark"];

  return (
    <RailSection section="appearance" title={t("settings.appearance")} hint={t("settings.chooseTheme")} fallback="look">
      {(tab) => (
        <>
          {tab === "look" && (
            <>
              <PaneBlock title={t("settings.tabThemeMode")}>
                <div className="flex gap-2">
                  {OPTIONS.map(({ id, labelKey, icon: Icon }) => (
                    <button
                      key={id}
                      onClick={() => setPreference(id)}
                      className={`relative flex flex-1 flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-[13px] ${
                        preference === id
                          ? "border-transparent text-[var(--cf-accent)]"
                          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
                      }`}
                    >
                      {preference === id && <ActivePill layoutId="cf-theme-mode-pill" inset="-inset-px" radius="rounded-lg" />}
                      <span className="relative flex flex-col items-center gap-1.5">
                        <Icon size={18} />
                        {t(labelKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </PaneBlock>

              {/* The picker says what an accent is for in its own first line. */}
              <PaneBlock title={t("settings.accentColor")}>
                <AccentPicker />
              </PaneBlock>
            </>
          )}

          {tab === "themes" && (
            <div className="space-y-4">
              {modes.map((mode) => (
                <div key={mode}>
                  {/* The scheme in force is named beside its heading, so it reads without hunting
                      the grid for the ticked card. */}
                  <p className="mb-2 flex items-center gap-2 text-[12.5px] font-medium text-[var(--cf-text)]">
                    {mode === "dark" ? <Moon size={13} /> : <Sun size={13} />}
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
