import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { Check, Copy, Download } from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { convert, CONVERSION_TARGETS, type ConversionTarget } from "../../lib/dbml";
import type { DbmlSchema } from "../../lib/dbml/types";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { safeFileName } from "../../lib/diagrams/exportFile";
import { useThemeStore } from "../../state/themeStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";

/**
 * The schema, as code.
 *
 * Ten targets, one model, and the generation is a pure function over it — so this recomputes on
 * every edit rather than behind a button. That is affordable (a hundred tables is a few
 * milliseconds) and it is what makes the panel useful while *writing*: change the column, watch the
 * migration change.
 *
 * Shown in Monaco rather than a `<pre>` so the generated file is highlighted as what it is — the
 * language per target comes from `CONVERSION_TARGETS`, which is also where the extension the save
 * dialog offers comes from.
 */
export function DbmlConvertPanel({ schema, title }: { schema: DbmlSchema; title: string }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [target, setTarget] = useState<ConversionTarget>("postgresql");
  const [copied, setCopied] = useState(false);

  const entry = CONVERSION_TARGETS.find((candidate) => candidate.id === target) ?? CONVERSION_TARGETS[0];
  const code = useMemo(() => convert(schema, target), [schema, target]);

  const copy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  const save = async () => {
    const name = `${safeFileName(title, "schema")}.${entry.extension}`;
    const path = await apiSaveFile(name, code).catch(() => null);
    if (path) useToastStore.getState().pushToast(t("dbml.convert.saved", { name }), "success");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-[var(--cf-border)] px-2 py-1.5">
        {CONVERSION_TARGETS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            onClick={() => setTarget(candidate.id)}
            className={`rounded-md px-2 py-[3px] text-[11px] transition-colors ${
              candidate.id === target
                ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {candidate.label}
          </button>
        ))}
        <span className="flex-1" />
        <button
          type="button"
          onClick={copy}
          title={t("dbml.convert.copy")}
          className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-[2px] text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
        >
          {copied ? <Check size={11} className="text-[var(--cf-success)]" /> : <Copy size={11} />}
          {copied ? t("dbml.convert.copied") : t("dbml.convert.copy")}
        </button>
        <button
          type="button"
          onClick={() => void save()}
          title={t("dbml.convert.save")}
          className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-1.5 py-[2px] text-[10.5px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]"
        >
          <Download size={11} />
          {entry.extension}
        </button>
      </div>

      <div className="min-h-0 flex-1">
        <Editor
          // Keyed on the target: Monaco keeps one model per `path`, and re-pointing a `sql` model
          // at TypeScript leaves the previous language's diagnostics on it.
          key={target}
          path={`cf-dbml:/generated.${entry.extension}`}
          language={entry.language}
          value={code}
          theme={monacoTheme}
          options={{
            ...OVERFLOW_SAFE_OPTIONS,
            readOnly: true,
            fontSize: 12,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderLineHighlight: "none",
            wordWrap: "off",
          }}
        />
      </div>
    </div>
  );
}
