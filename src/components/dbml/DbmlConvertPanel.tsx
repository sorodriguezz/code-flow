import { useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { Download } from "lucide-react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import {
  convert,
  CONVERSION_KINDS,
  CONVERSION_TARGETS,
  type ConversionTarget,
} from "../../lib/dbml";
import type { DbmlSchema } from "../../lib/dbml/types";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { safeFileName } from "../../lib/diagrams/exportFile";
import { useThemeStore } from "../../state/themeStore";
import { useToastStore } from "../../state/toastStore";
import { CopyButton } from "./CopyButton";
import {
  SEG_GROUP_LABEL,
  SEG_TRACK,
  TOOL_BAR,
  TOOL_BTN,
  TOOL_BTN_PRIMARY,
  ToolClose,
  segItem,
} from "./toolChrome";
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
export function DbmlConvertPanel({
  schema,
  title,
  onClose,
}: {
  schema: DbmlSchema;
  title: string;
  /** Closes the tool. Rendered here rather than in a strip above the panel — see `ToolClose`. */
  onClose: () => void;
}) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [target, setTarget] = useState<ConversionTarget>("postgresql");

  const entry = CONVERSION_TARGETS.find((candidate) => candidate.id === target) ?? CONVERSION_TARGETS[0];
  const code = useMemo(() => convert(schema, target), [schema, target]);

  const save = async () => {
    const name = `${safeFileName(title, "schema")}.${entry.extension}`;
    const path = await apiSaveFile(name, code).catch(() => null);
    if (path) useToastStore.getState().pushToast(t("dbml.convert.saved", { name }), "success");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={TOOL_BAR}>
        {/* Ten targets as three named choices. Flat, they were a row of ten words you had to read
            left to right to find Prisma in; grouped, the kind you want is the first thing you pick
            and the list under it is short. The group names are the acronyms themselves — see
            `ConversionKind`. */}
        {CONVERSION_KINDS.map((kind) => {
          const group = CONVERSION_TARGETS.filter((candidate) => candidate.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="flex items-center gap-1.5">
              <span className={SEG_GROUP_LABEL}>{kind}</span>
              <div className={SEG_TRACK} role="group" aria-label={kind}>
                {group.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => setTarget(candidate.id)}
                    aria-pressed={candidate.id === target}
                    className={segItem(candidate.id === target)}
                  >
                    {candidate.label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}

        {/* Pushed to the end of the bar and kept together: these two act on whatever is showing,
            where everything to their left changes what that is. */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <CopyButton text={code} className={TOOL_BTN} />
          {/* The extension is the useful half — it is what tells you the save is going to be a
              `.prisma` and not a `.sql` — so it stays on the button, beside a verb instead of
              standing in for one. */}
          <button
            type="button"
            onClick={() => void save()}
            title={t("dbml.convert.save")}
            className={TOOL_BTN_PRIMARY}
          >
            <Download size={12} />
            {t("dbml.convert.saveShort")}
            <span className="font-mono opacity-70">.{entry.extension}</span>
          </button>
          <ToolClose onClose={onClose} />
        </div>
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
