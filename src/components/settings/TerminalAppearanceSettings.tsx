import { useEffect, useState } from "react";
import { useT } from "../../state/languageStore";
import {
  DEFAULT_FONT_FAMILY,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  SCROLLBACK_MAX,
  ensureTerminalPrefsLoaded,
  useTerminalPrefsStore,
  type CursorStyle,
} from "../../state/terminalPrefsStore";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { Row, Switch } from "./EditorDisplaySettings";

/**
 * Settings › Terminal › Appearance: how every terminal pane looks and how much it keeps. Each
 * change reaches every open terminal at once — see `terminalPrefsStore`.
 */
export function TerminalAppearanceSettings() {
  const t = useT();
  const prefs = useTerminalPrefsStore((s) => s.prefs);
  const update = useTerminalPrefsStore((s) => s.update);
  useEffect(() => ensureTerminalPrefsLoaded(), []);
  // The font is typed, so it is committed on blur: a family applied per keystroke would rebuild
  // every terminal's renderer for each letter of "Cascadia".
  const [font, setFont] = useState<string | null>(null);

  const number = (value: string, fallback: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return (
    <div className="max-w-2xl space-y-4">
      <Row label={t("settings.terminalFont")} tip={t("settings.terminalFontTip")}>
        <input
          className={fieldClass({ size: "sm" })}
          value={font ?? prefs.fontFamily}
          placeholder={DEFAULT_FONT_FAMILY.split(",")[0]}
          onChange={(e) => setFont(e.target.value)}
          onBlur={() => {
            if (font !== null) update({ fontFamily: font });
            setFont(null);
          }}
        />
      </Row>
      <Row label={t("settings.terminalFontSize")} tip={t("settings.terminalFontSizeTip")}>
        <input
          type="number"
          className={fieldClass({ size: "sm" })}
          min={FONT_SIZE_MIN}
          max={FONT_SIZE_MAX}
          value={prefs.fontSize}
          onChange={(e) => update({ fontSize: number(e.target.value, prefs.fontSize) })}
        />
      </Row>
      <Row label={t("settings.terminalLineHeight")} tip={t("settings.terminalLineHeightTip")}>
        <input
          type="number"
          className={fieldClass({ size: "sm" })}
          min={1}
          max={2}
          step={0.05}
          value={prefs.lineHeight}
          onChange={(e) => update({ lineHeight: number(e.target.value, prefs.lineHeight) })}
        />
      </Row>
      <Row label={t("settings.terminalCursor")} tip={t("settings.terminalCursorTip")}>
        <Select
          value={prefs.cursorStyle}
          onChange={(value) => update({ cursorStyle: value as CursorStyle })}
          ariaLabel={t("settings.terminalCursor")}
          options={[
            { value: "block", label: t("settings.terminalCursorBlock") },
            { value: "bar", label: t("settings.terminalCursorBar") },
            { value: "underline", label: t("settings.terminalCursorUnderline") },
          ]}
        />
      </Row>
      <Switch
        checked={prefs.cursorBlink}
        onChange={(cursorBlink) => update({ cursorBlink })}
        label={t("settings.terminalCursorBlink")}
        tip={t("settings.terminalCursorBlinkTip")}
      />
      <Row label={t("settings.terminalScrollback")} tip={t("settings.terminalScrollbackTip")}>
        <input
          type="number"
          className={fieldClass({ size: "sm" })}
          min={100}
          max={SCROLLBACK_MAX}
          step={1000}
          value={prefs.scrollback}
          onChange={(e) => update({ scrollback: number(e.target.value, prefs.scrollback) })}
        />
      </Row>
      <Switch
        checked={prefs.notifyLong}
        onChange={(notifyLong) => update({ notifyLong })}
        label={t("settings.terminalNotifyLong")}
        tip={t("settings.terminalNotifyLongTip", { seconds: prefs.notifyAfterSec })}
      />
      {prefs.notifyLong && (
        <Row label={t("settings.terminalNotifyAfter")} tip={t("settings.terminalNotifyAfterTip")}>
          <input
            type="number"
            className={fieldClass({ size: "sm" })}
            min={1}
            max={3600}
            value={prefs.notifyAfterSec}
            onChange={(e) => update({ notifyAfterSec: number(e.target.value, prefs.notifyAfterSec) })}
          />
        </Row>
      )}
    </div>
  );
}
