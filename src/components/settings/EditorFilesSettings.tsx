import { useEffect, useMemo, useState } from "react";
import { Plus, X } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select, type SelectOption } from "../common/Select";
import { Button, iconButtonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { CsvSettings } from "./CsvSettings";
import { PaneBlock } from "./settingsNav";
import { useLanguageOverrideStore } from "../../state/languageOverrideStore";
import { useFileNestingStore } from "../../state/fileNestingStore";
import { useT } from "../../state/languageStore";

/**
 * «Editor › Archivos»: how each kind of file opens and shows. Two of its three were reachable only
 * from the editor itself until 2026-10-09 — the language an extension opens as («Usar para todos los
 * archivos .x» in the status line) and the explorer's nesting (its context menu) — and the third is
 * the CSV pane that had a rail entry of its own.
 */
export function EditorFilesSettings() {
  const t = useT();
  return (
    <div>
      <PaneBlock title={t("editor.files.languages")} hint={t("editor.files.languagesHint")}>
        <ExtensionLanguages />
      </PaneBlock>
      <PaneBlock title={t("editor.files.explorer")}>
        <Nesting />
      </PaneBlock>
      <PaneBlock title={t("csv.title")} hint={t("csv.settingsHint")}>
        <CsvSettings />
      </PaneBlock>
    </div>
  );
}

/** Monaco's languages, loaded when this pane opens rather than with the Settings window. */
function useLanguages(): { id: string; name: string }[] {
  const [languages, setLanguages] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let live = true;
    void import("monaco-editor")
      .then((monaco) => {
        if (!live) return;
        setLanguages(
          (monaco.languages.getLanguages() as { id: string; aliases?: string[] }[])
            .filter((language) => !/^csv-/.test(language.id))
            .map((language) => ({ id: language.id, name: language.aliases?.[0] ?? language.id }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return languages;
}

function ExtensionLanguages() {
  const t = useT();
  const extensions = useLanguageOverrideStore((s) => s.extensions);
  const setExtensionLanguage = useLanguageOverrideStore((s) => s.setExtensionLanguage);
  const languages = useLanguages();
  const [extension, setExtension] = useState("");
  const [language, setLanguage] = useState("");

  useEffect(() => {
    void useLanguageOverrideStore.getState().init();
  }, []);

  const name = (id: string) => languages.find((entry) => entry.id === id)?.name ?? id;
  const options: SelectOption[] = useMemo(
    () => [{ value: "", label: t("editor.files.pickLanguage") }, ...languages.map((entry) => ({ value: entry.id, label: entry.name }))],
    [languages, t],
  );
  const normalized = extension.trim().toLowerCase().replace(/^\*?\.?/, ".");
  const valid = /^\.[a-z0-9_+-][a-z0-9_.+-]*$/.test(normalized) && !!language;
  const rows = Object.entries(extensions).sort(([a], [b]) => a.localeCompare(b));

  const add = () => {
    if (!valid) return;
    void setExtensionLanguage(normalized, language);
    setExtension("");
    setLanguage("");
  };

  return (
    <div>
      {rows.length > 0 ? (
        <div className="mb-2 overflow-hidden rounded-lg border border-[var(--cf-border)]">
          {rows.map(([ext, id]) => (
            <div key={ext} className="flex items-center gap-3 border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
              <span className="w-[120px] shrink-0 font-mono text-[12px] text-[var(--cf-text)]">{ext}</span>
              <span className="min-w-0 flex-1 text-[12.5px] text-[var(--cf-text-muted)]">{name(id)}</span>
              <button
                type="button"
                className={iconButtonClass({ size: "xs" })}
                aria-label={t("editor.files.removeAssociation", { ext })}
                title={t("editor.files.removeAssociation", { ext })}
                onClick={() => void setExtensionLanguage(ext, null)}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mb-2 text-[12px] text-[var(--cf-text-muted)]">{t("editor.files.noAssociations")}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={extension}
          onChange={(e) => setExtension(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder=".conf"
          aria-label={t("editor.files.extension")}
          className={fieldClass({ size: "sm", className: "w-[110px] font-mono" })}
        />
        <div className="w-[220px]">
          <Select size="sm" value={language} onChange={setLanguage} options={options} ariaLabel={t("editor.files.pickLanguage")} />
        </div>
        <Button size="sm" variant="secondary" disabled={!valid} onClick={add}>
          <Plus size={12} />
          {t("editor.files.add")}
        </Button>
      </div>
    </div>
  );
}

function Nesting() {
  const t = useT();
  const enabled = useFileNestingStore((s) => s.enabled);
  const setEnabled = useFileNestingStore((s) => s.setEnabled);
  useEffect(() => {
    void useFileNestingStore.getState().init();
  }, []);
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <span className="mt-[1px] shrink-0">
        <Checkbox checked={enabled} onChange={setEnabled} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-snug text-[var(--cf-text)]">{t("editor.files.nest")}</span>
        <span className="mt-0.5 block text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("editor.files.nestHint")}</span>
      </span>
    </label>
  );
}
