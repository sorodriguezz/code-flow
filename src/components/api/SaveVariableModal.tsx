import { useMemo, useState } from "react";
import { Variable } from "lucide-react";
import { ApiModal } from "./ApiModal";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { useApiStore } from "../../state/apiStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { noteAuthoredScript } from "../../lib/api/scriptTrust";
import { pathToAccessor, pathToJsonPath } from "../../lib/api/jsonPath";
import type { VariableScope } from "../../types/api";

type WritableScope = Extract<VariableScope, "environment" | "collection" | "global">;

/** How a script writes each scope. */
const SCRIPT_SCOPE: Record<WritableScope, string> = {
  environment: "pm.environment",
  collection: "pm.collectionVariables",
  global: "pm.globals",
};

/** A variable's text for a value of any shape: strings as they are, the rest as JSON. */
export function variableText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The variable a path suggests: its last named segment (`data[0].id` → `id`). */
function suggestedName(path: (string | number)[]): string {
  const named = [...path].reverse().find((part): part is string => typeof part === "string");
  const clean = (named ?? "value").replace(/[^A-Za-z0-9_.-]/g, "_");
  return clean || "value";
}

/** The script line that keeps the variable up to date on every send. */
function extractionLine(scope: WritableScope, name: string, path: (string | number)[], value: unknown): string {
  const read = `pm.response.json()${pathToAccessor(path)}`;
  const expression = typeof value === "string" ? read : `JSON.stringify(${read})`;
  return `${SCRIPT_SCOPE[scope]}.set(${JSON.stringify(name)}, ${expression});`;
}

/**
 * «Guardar en variable…» from a value of the response body: written now to the chosen scope, and —
 * when asked — kept up to date by a line added to the request's post-response script, which is the
 * thing people actually want from "take the token out of the login response".
 */
export function SaveVariableModal({
  tabId,
  path,
  value,
  onClose,
}: {
  tabId: string;
  path: (string | number)[];
  value: unknown;
  onClose: () => void;
}) {
  const t = useT();
  const tab = useApiStore((s) => s.openTabs.find((entry) => entry.id === tabId) ?? null);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const environments = useApiStore((s) => s.environments);
  const collections = useApiStore((s) => s.collections);
  const activeEnvironment = environments.find((e) => e.id === activeEnvironmentId && !e.is_global) ?? null;
  const collection = collections.find((c) => c.id === tab?.collectionId) ?? null;

  const scopes = useMemo(() => {
    const out: { value: WritableScope; label: string }[] = [];
    if (activeEnvironment) out.push({ value: "environment", label: t("api.saveVar.scopeEnvironment", { name: activeEnvironment.name }) });
    if (collection) out.push({ value: "collection", label: t("api.saveVar.scopeCollection", { name: collection.name }) });
    out.push({ value: "global", label: t("api.scope.global") });
    return out;
  }, [activeEnvironment, collection, t]);

  const [name, setName] = useState(suggestedName(path));
  const [scope, setScope] = useState<WritableScope>(scopes[0].value);
  const [keepUpdated, setKeepUpdated] = useState(true);
  const [saving, setSaving] = useState(false);
  const valid = /^[A-Za-z_][\w.-]*$/.test(name.trim());

  const save = async () => {
    if (!valid || !tab) return;
    setSaving(true);
    try {
      const key = name.trim();
      await useApiStore.getState().setVariable(scope, key, variableText(value), tab.collectionId);
      if (keepUpdated) {
        const current = useApiStore.getState().openTabs.find((entry) => entry.id === tabId);
        if (current) {
          const line = extractionLine(scope, key, path, value);
          const script = current.draft.postScript;
          const next = script.includes(line) ? script : `${script.replace(/\s*$/, "")}${script.trim() ? "\n" : ""}${line}\n`;
          useApiStore.getState().updateDraft(tabId, { postScript: next });
          // Written by this dialog on the user's say-so — the same as typing it in the editor.
          noteAuthoredScript(`${tabId}/post`, next);
        }
      }
      pushSuccessToast(t("api.saveVar.saved", { name: key }));
      onClose();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const preview = variableText(value);

  return (
    <ApiModal
      icon={Variable}
      title={t("api.saveVar.title")}
      subtitle={pathToJsonPath(path)}
      width="max-w-md"
      busy={saving}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("common.cancel")}
          </button>
          <button type="button" onClick={() => void save()} disabled={!valid || saving} className={buttonClass({ variant: "primary", size: "sm" })}>
            {t("api.saveVar.save")}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("api.saveVar.name")}</span>
          <input
            autoFocus
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
            }}
            className={fieldClass({ className: "font-mono" })}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("api.saveVar.scope")}</span>
          <Select size="compact" value={scope} onChange={(next) => setScope(next as WritableScope)} options={scopes} ariaLabel={t("api.saveVar.scope")} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("api.saveVar.value")}</span>
          <code className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md bg-[var(--cf-sunken)] px-2 py-1.5 font-mono text-[11px] text-[var(--cf-text)]">
            {preview.length > 600 ? `${preview.slice(0, 600)}…` : preview}
          </code>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-[12px] text-[var(--cf-text)]">
          <Checkbox checked={keepUpdated} onChange={setKeepUpdated} />
          <span>
            {t("api.saveVar.keepUpdated")}
            <span className="mt-0.5 block font-mono text-[11px] text-[var(--cf-text-muted)]">{extractionLine(scope, name.trim() || "name", path, value)}</span>
          </span>
        </label>
      </div>
    </ApiModal>
  );
}
