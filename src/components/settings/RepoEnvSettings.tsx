import { useEffect, useState } from "react";
import { Plus, RotateCcw, X } from "lucide-react";
import { Button } from "../common/Button";
import { chipClass, fieldClass } from "../common/recipes";
import { PaneBlock } from "./settingsNav";
import { useT } from "../../state/languageStore";
import { globalExclude, globalPatterns, useRepoEnvStore } from "../../state/repoEnvStore";
import { addToList } from "../../lib/env/config";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * «Workspaces y proyectos › Entorno»: the files «Entorno» reads in every repository, and the
 * folders it never walks into (user, 2026-10-23: «que se puedan configurar los archivos que
 * detecta»). A repository changes these on top from its own «Archivos detectados» popover; the
 * lists here are the defaults those changes apply to. Saved as `repo_env_patterns`.
 */
export function RepoEnvSettings() {
  const t = useT();
  const patterns = useRepoEnvStore((s) => globalPatterns(s));
  const exclude = useRepoEnvStore((s) => globalExclude(s));
  const global = useRepoEnvStore((s) => s.global);
  const defaults = useRepoEnvStore((s) => s.defaults);

  useEffect(() => {
    void useRepoEnvStore.getState().loadGlobal();
  }, []);

  if (!defaults) return null;
  const save = (change: { patterns?: string[] | null; exclude?: string[] | null }) =>
    void useRepoEnvStore.getState().saveGlobal({ patterns: global?.patterns ?? null, exclude: global?.exclude ?? null, ...change });

  return (
    <div>
      <PaneBlock title={t("env.settings.patterns")} hint={t("env.settings.patternsHint")}>
        <ListEditor
          values={patterns}
          placeholder="config/*.env"
          addKey="env.files.add"
          customised={global?.patterns != null}
          onChange={(next) => save({ patterns: next })}
          onReset={() => save({ patterns: null })}
        />
      </PaneBlock>
      <PaneBlock title={t("env.settings.exclude")} hint={t("env.settings.excludeHint")}>
        <ListEditor
          values={exclude}
          placeholder="generated"
          addKey="env.files.add"
          customised={global?.exclude != null}
          onChange={(next) => save({ exclude: next })}
          onReset={() => save({ exclude: null })}
        />
      </PaneBlock>
    </div>
  );
}

function ListEditor({
  values,
  placeholder,
  addKey,
  customised,
  onChange,
  onReset,
}: {
  values: string[];
  placeholder: string;
  addKey: TranslationKey;
  customised: boolean;
  onChange: (next: string[]) => void;
  onReset: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  return (
    <div className="max-w-[560px]">
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <span key={value} className={chipClass("neutral", "font-mono")}>
            {value}
            <button type="button" aria-label={t("env.files.removePattern", { pattern: value })} onClick={() => onChange(values.filter((v) => v !== value))}>
              <X size={11} />
            </button>
          </span>
        ))}
      </div>
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          onChange(addToList(values, draft));
          setDraft("");
        }}
      >
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={placeholder} className={fieldClass({ size: "sm", className: "w-[240px] font-mono" })} />
        <Button type="submit" size="sm" disabled={!draft.trim()}>
          <Plus size={12} />
          {t(addKey)}
        </Button>
        {customised && (
          <Button size="sm" variant="ghost" onClick={onReset}>
            <RotateCcw size={12} />
            {t("env.settings.reset")}
          </Button>
        )}
      </form>
    </div>
  );
}
