import { useEffect, useState } from "react";
import { Checkbox } from "../common/Checkbox";
import { Kbd } from "../common/Button";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import {
  DEFAULT_EDITOR_FONT_SIZE,
  EDITOR_FONT_SIZES,
  editorFontFamily,
  parseRulers,
  useEditorDisplayStore,
  type EditorIndent,
  type EditorWhitespace,
} from "../../state/editorDisplayStore";
import { CODE_FONT_FAMILY } from "../../lib/monacoSetup";
import { useShortcutChord } from "../../lib/useShortcutHint";
import { useT } from "../../state/languageStore";

/**
 * Settings › Editor › Display. Five switches: word wrap, inlay hints, implementation lenses, package
 * weights and Prisma's colours. Where a line breaks is not a setting — it is the editor's own width, which is the whole of
 * what was asked for — so there is no column to pick, and the tip says so. Which hints a language
 * draws is its server's to decide; this only says whether they are drawn at all.
 */
export function EditorDisplaySettings() {
  const t = useT();
  const chord = useShortcutChord();
  const wordWrap = useEditorDisplayStore((s) => s.wordWrap);
  const setWordWrap = useEditorDisplayStore((s) => s.setWordWrap);
  const inlayHints = useEditorDisplayStore((s) => s.inlayHints);
  const setInlayHints = useEditorDisplayStore((s) => s.setInlayHints);
  const importCost = useEditorDisplayStore((s) => s.importCost);
  const setImportCost = useEditorDisplayStore((s) => s.setImportCost);
  const prismaHighlight = useEditorDisplayStore((s) => s.prismaHighlight);
  const setPrismaHighlight = useEditorDisplayStore((s) => s.setPrismaHighlight);
  const implementationLens = useEditorDisplayStore((s) => s.implementationLens);
  const setImplementationLens = useEditorDisplayStore((s) => s.setImplementationLens);
  const fontSize = useEditorDisplayStore((s) => s.fontSize);
  const setFontSize = useEditorDisplayStore((s) => s.setFontSize);
  const display = useEditorDisplayStore();
  /** Typed freely, stored on blur/Enter — a half-typed font name or column list is not a setting. */
  const [fontDraft, setFontDraft] = useState<string | null>(null);
  const [rulersDraft, setRulersDraft] = useState<string | null>(null);
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
      <Switch
        checked={implementationLens}
        onChange={(value) => void setImplementationLens(value)}
        label={t("editor.implementationLens")}
        tip={t("editor.implementationLensTip")}
      />
      <Switch
        checked={importCost}
        onChange={(value) => void setImportCost(value)}
        label={t("editor.importCost")}
        tip={t("editor.importCostTip")}
      />
      <Switch
        checked={display.minimap}
        onChange={(value) => void display.setMinimap(value)}
        label={t("editor.minimap")}
        tip={t("editor.minimapTip")}
      />
      <Switch
        checked={display.stickyScroll}
        onChange={(value) => void display.setStickyScroll(value)}
        label={t("editor.stickyScroll")}
        tip={t("editor.stickyScrollTip")}
      />
      <Switch
        checked={display.ligatures}
        onChange={(value) => void display.setLigatures(value)}
        label={t("editor.ligatures")}
        tip={t("editor.ligaturesTip")}
      />
      <Switch
        checked={display.linkedEditing}
        onChange={(value) => void display.setLinkedEditing(value)}
        label={t("editor.linkedEditing")}
        tip={t("editor.linkedEditingTip")}
      />
      <Switch
        checked={display.emmet}
        onChange={(value) => void display.setEmmet(value)}
        label={t("editor.emmet")}
        tip={t("editor.emmetTip")}
      />
      <Row label={t("editor.indent")} tip={t("editor.indentTip")}>
        <Select
          size="sm"
          value={display.indent}
          onChange={(value) => void display.setIndent(value as EditorIndent)}
          ariaLabel={t("editor.indent")}
          options={[
            { value: "auto", label: t("editor.indentAuto") },
            { value: "2", label: t("editor.indentSpaces", { n: 2 }) },
            { value: "4", label: t("editor.indentSpaces", { n: 4 }) },
            { value: "8", label: t("editor.indentSpaces", { n: 8 }) },
            { value: "tab", label: t("editor.indentTabs") },
          ]}
        />
      </Row>
      <Row label={t("editor.whitespace")} tip={t("editor.whitespaceTip")}>
        <Select
          size="sm"
          value={display.whitespace}
          onChange={(value) => void display.setWhitespace(value as EditorWhitespace)}
          ariaLabel={t("editor.whitespace")}
          options={[
            { value: "none", label: t("editor.whitespaceNone") },
            { value: "boundary", label: t("editor.whitespaceBoundary") },
            { value: "trailing", label: t("editor.whitespaceTrailing") },
            { value: "all", label: t("editor.whitespaceAll") },
          ]}
        />
      </Row>
      <Row label={t("editor.rulers")} tip={t("editor.rulersTip")}>
        <input
          value={rulersDraft ?? display.rulers.join(", ")}
          onChange={(e) => setRulersDraft(e.target.value)}
          onBlur={() => {
            if (rulersDraft !== null) void display.setRulers(parseRulers(rulersDraft));
            setRulersDraft(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="80, 120"
          aria-label={t("editor.rulers")}
          className={fieldClass({ size: "sm", className: "w-full" })}
        />
      </Row>
      <Row label={t("editor.fontFamily")} tip={t("editor.fontFamilyTip")}>
        <input
          value={fontDraft ?? display.fontFamily}
          onChange={(e) => setFontDraft(e.target.value)}
          onBlur={() => {
            if (fontDraft !== null) void display.setFontFamily(fontDraft);
            setFontDraft(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="JetBrains Mono"
          aria-label={t("editor.fontFamily")}
          className={fieldClass({ size: "sm", className: "w-full" })}
        />
      </Row>
      <Switch
        checked={prismaHighlight}
        onChange={(value) => void setPrismaHighlight(value)}
        label={t("editor.prismaHighlight")}
        tip={t("editor.prismaHighlightTip")}
      />
      <div className="pt-1">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[13px] text-[var(--cf-text)]">{t("editor.fontSize")}</span>
          <input
            type="range"
            min={EDITOR_FONT_SIZES.min}
            max={EDITOR_FONT_SIZES.max}
            step={1}
            value={fontSize}
            onChange={(e) => void setFontSize(Number(e.target.value))}
            aria-label={t("editor.fontSize")}
            className="w-[180px] accent-[var(--cf-accent)]"
          />
          <span className="text-[12px] tabular-nums text-[var(--cf-text-muted)]">{fontSize} px</span>
          {fontSize !== DEFAULT_EDITOR_FONT_SIZE && (
            <button type="button" className="text-[12px] text-[var(--cf-accent)] hover:underline" onClick={() => void setFontSize(DEFAULT_EDITOR_FONT_SIZE)}>
              {t("editor.fontSizeReset")}
            </button>
          )}
        </div>
        <pre
          className="mt-2 overflow-x-auto rounded-md border border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2 text-[var(--cf-text)]"
          style={{
            fontFamily: editorFontFamily(fontDraft ?? display.fontFamily, CODE_FONT_FAMILY),
            fontSize,
            fontVariantLigatures: display.ligatures ? "normal" : "none",
          }}
        >
          {"export function greet(name: string) {\n  return `Hola, ${name}`;\n}"}
        </pre>
        <span className="mt-1 block text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("editor.fontSizeTip")}</span>
      </div>
    </div>
  );
}

/** A labelled control — a select or a field — with what it does under it. */
function Row({ label, tip, children }: { label: string; tip: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-snug text-[var(--cf-text)]">{label}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">{tip}</span>
      </span>
      <div className="w-[200px] shrink-0">{children}</div>
    </div>
  );
}

/** One checkbox row: the name, the chord that flips it when there is one, and what it does. */
export function Switch({
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
