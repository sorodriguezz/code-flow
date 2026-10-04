import { useEffect } from "react";
import { Checkbox } from "../common/Checkbox";
import { Kbd } from "../common/Button";
import { useEditorDisplayStore } from "../../state/editorDisplayStore";
import { useShortcutChord } from "../../lib/useShortcutHint";
import { useT } from "../../state/languageStore";

/**
 * Settings › Editor › Display. Two switches: word wrap and inlay hints. Where a line breaks is not a
 * setting — it is the editor's own width, which is the whole of what was asked for — so there is no
 * column to pick, and the tip says so. Which hints a language draws is its server's to decide; this
 * only says whether they are drawn at all.
 */
export function EditorDisplaySettings() {
  const t = useT();
  const chord = useShortcutChord();
  const wordWrap = useEditorDisplayStore((s) => s.wordWrap);
  const setWordWrap = useEditorDisplayStore((s) => s.setWordWrap);
  const inlayHints = useEditorDisplayStore((s) => s.inlayHints);
  const setInlayHints = useEditorDisplayStore((s) => s.setInlayHints);
  /** From the registry, so a rebound chord reads as what it is now. */
  const toggleKeys = chord("editor.toggleWordWrap");

  // Read here too: the Settings window may be the first thing to ask for it.
  useEffect(() => {
    void useEditorDisplayStore.getState().init();
  }, []);

  return (
    <div className="space-y-3">
      <Switch
        checked={wordWrap}
        onChange={(value) => void setWordWrap(value)}
        label={t("editor.wordWrap")}
        keys={toggleKeys}
        tip={t("editor.wordWrapTip")}
      />
      <Switch
        checked={inlayHints}
        onChange={(value) => void setInlayHints(value)}
        label={t("editor.inlayHints")}
        tip={t("editor.inlayHintsTip")}
      />
    </div>
  );
}

/** One checkbox row: the name, the chord that flips it when there is one, and what it does. */
function Switch({
  checked,
  onChange,
  label,
  keys,
  tip,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  keys?: string | null;
  tip: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <span className="mt-[1px] shrink-0">
        <Checkbox checked={checked} onChange={onChange} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[13px] leading-snug text-[var(--cf-text)]">
          {label}
          {keys && <Kbd>{keys}</Kbd>}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">{tip}</span>
      </span>
    </label>
  );
}
