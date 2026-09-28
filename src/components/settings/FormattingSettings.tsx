import { useEffect } from "react";
import { Checkbox } from "../common/Checkbox";
import { useEditorFormatStore } from "../../state/editorFormatStore";
import { useT } from "../../state/languageStore";

/**
 * Settings › Editor › Formatting. One switch: whether a save formats the file first. Which formatter
 * answers is not a setting — the repository's own Prettier when it has one, the language's formatter
 * otherwise (`lib/formatting`) — and the pane's hint says so.
 */
export function FormattingSettings() {
  const t = useT();
  const formatOnSave = useEditorFormatStore((s) => s.formatOnSave);
  const setFormatOnSave = useEditorFormatStore((s) => s.setFormatOnSave);

  // Read here too: the Settings window may be the first thing to ask for it.
  useEffect(() => {
    void useEditorFormatStore.getState().init();
  }, []);

  return (
    <label className="flex cursor-pointer items-start gap-2">
      <span className="mt-[1px] shrink-0">
        <Checkbox checked={formatOnSave} onChange={(value) => void setFormatOnSave(value)} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-snug text-[var(--cf-text)]">{t("editor.formatOnSave")}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">
          {t("editor.formatOnSaveTip")}
        </span>
      </span>
    </label>
  );
}
