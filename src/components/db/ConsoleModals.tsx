import { useEffect, useRef, useState } from "react";
import { Braces, FolderCode, Plus, Trash2 } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { INPUT } from "./dbChrome";
import { useT } from "../../state/languageStore";
import { ensureDbPrefsLoaded, useDbPrefsStore } from "../../state/dbPrefsStore";
import type { ParamValue, QueryParam } from "../../lib/db/queryParams";
import type { DbSnippet } from "../../lib/db/snippets";

/**
 * What was typed for each placeholder, by its key, for the rest of the session — running the same
 * statement again should not mean typing the same id again.
 */
const remembered = new Map<string, ParamValue>();

/** Asks for each placeholder's value, then runs the statement with them written in. */
export function ParamsModal({
  params,
  onRun,
  onClose,
}: {
  params: QueryParam[];
  onRun: (values: Record<string, ParamValue>) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [values, setValues] = useState<Record<string, ParamValue>>(() =>
    Object.fromEntries(params.map((param) => [param.key, remembered.get(param.key) ?? { value: "", raw: false }])),
  );
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    first.current?.select();
  }, []);

  const submit = () => {
    for (const [key, value] of Object.entries(values)) remembered.set(key, value);
    onRun(values);
    onClose();
  };

  return (
    <ApiModal icon={Braces} title={t("db.params.title")} subtitle={t("db.params.subtitle")} onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={submit}>{t("db.run")}</PrimaryButton>
        </div>
      }
    >
      <form
        className="min-h-0 flex-1 space-y-2.5 overflow-auto p-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {params.map((param, index) => {
          const value = values[param.key];
          return (
            <div key={param.key} className="grid grid-cols-[110px_1fr_auto] items-center gap-2">
              <span className="truncate font-mono text-[12px] text-[var(--cf-text)]" title={param.token}>
                {param.token.startsWith("?") ? `? #${param.key.slice(1)}` : param.token}
              </span>
              <input
                ref={index === 0 ? first : undefined}
                value={value.value}
                onChange={(e) => setValues((current) => ({ ...current, [param.key]: { ...value, value: e.target.value } }))}
                className={INPUT}
                spellCheck={false}
              />
              <label
                className="flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]"
                title={t("db.params.rawHint")}
              >
                <Checkbox
                  checked={value.raw}
                  onChange={(raw) => setValues((current) => ({ ...current, [param.key]: { ...value, raw } }))}
                />
                {t("db.params.raw")}
              </label>
            </div>
          );
        })}
        {/* Enter in any field submits. */}
        <button type="submit" hidden />
      </form>
    </ApiModal>
  );
}

/**
 * The console's snippets: a list on the left, the one picked on the right. `draft` arrives from
 * "save selection as snippet" and opens as a new entry already filled in.
 */
export function SnippetsModal({
  draft,
  onClose,
}: {
  draft?: { body: string; language: DbSnippet["language"] };
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => ensureDbPrefsLoaded(), []);
  const stored = useDbPrefsStore((s) => s.snippets);
  const [list, setList] = useState<DbSnippet[]>(() => {
    const base = useDbPrefsStore.getState().snippets;
    return draft ? [...base, { id: crypto.randomUUID(), prefix: "", description: "", body: draft.body, language: draft.language }] : base;
  });
  const [picked, setPicked] = useState<string | null>(() => (draft ? list[list.length - 1]?.id ?? null : list[0]?.id ?? null));
  // The store finishing its first load replaces the defaults the dialog opened on.
  useEffect(() => {
    if (!draft) setList(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  const current = list.find((snippet) => snippet.id === picked) ?? null;
  const patch = (next: Partial<DbSnippet>) =>
    setList((all) => all.map((snippet) => (snippet.id === picked ? { ...snippet, ...next } : snippet)));
  const invalid = list.some((snippet) => !snippet.prefix.trim() || !snippet.body.trim());

  return (
    <ApiModal
      icon={FolderCode}
      title={t("db.snippets")}
      subtitle={t("db.snippetsHint")}
      width="max-w-3xl"
      height="h-[70vh]"
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          {invalid && <span className="mr-auto text-[11px] text-[var(--cf-warning)]">{t("db.snippetInvalid")}</span>}
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton
            disabled={invalid}
            onClick={() => {
              useDbPrefsStore.getState().saveSnippets(list.map((snippet) => ({ ...snippet, prefix: snippet.prefix.trim() })));
              onClose();
            }}
          >
            {t("common.save")}
          </PrimaryButton>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex w-[220px] shrink-0 flex-col border-r border-[var(--cf-border)]">
          <div className="min-h-0 flex-1 overflow-auto py-1">
            {list.map((snippet) => (
              <button
                key={snippet.id}
                type="button"
                onClick={() => setPicked(snippet.id)}
                className={`flex w-full flex-col items-start px-3 py-1.5 text-left ${
                  snippet.id === picked ? "bg-[var(--cf-accent-soft)]" : "hover:bg-[var(--cf-hover)]"
                }`}
              >
                <span className="font-mono text-[12px] text-[var(--cf-text)]">{snippet.prefix || "…"}</span>
                <span className="w-full truncate text-[11px] text-[var(--cf-text-muted)]">{snippet.description}</span>
              </button>
            ))}
          </div>
          <div className="flex border-t border-[var(--cf-border)] p-1.5">
            <GhostButton
              onClick={() => {
                const id = crypto.randomUUID();
                setList((all) => [...all, { id, prefix: "", description: "", body: "", language: "sql" }]);
                setPicked(id);
              }}
            >
              <Plus size={12} />
              {t("db.snippetAdd")}
            </GhostButton>
          </div>
        </div>
        {current ? (
          <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-4">
            <div className="grid grid-cols-[1fr_2fr_140px_auto] items-end gap-2">
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {t("db.snippetPrefix")}
                </span>
                <input value={current.prefix} onChange={(e) => patch({ prefix: e.target.value })} className={INPUT} spellCheck={false} />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                  {t("db.snippetDescription")}
                </span>
                <input value={current.description} onChange={(e) => patch({ description: e.target.value })} className={INPUT} />
              </label>
              <Select
                size="sm"
                ariaLabel={t("db.snippetLanguage")}
                value={current.language}
                onChange={(language) => patch({ language: language as DbSnippet["language"] })}
                options={[
                  { value: "sql", label: "SQL" },
                  { value: "javascript", label: "MongoDB" },
                  { value: "redis", label: "Redis" },
                  { value: "any", label: t("db.snippetAnyLanguage") },
                ]}
              />
              <GhostButton
                onClick={() => {
                  setList((all) => all.filter((snippet) => snippet.id !== current.id));
                  setPicked(list.find((snippet) => snippet.id !== current.id)?.id ?? null);
                }}
              >
                <Trash2 size={12} />
              </GhostButton>
            </div>
            <textarea
              value={current.body}
              onChange={(e) => patch({ body: e.target.value })}
              spellCheck={false}
              className={`${INPUT} min-h-0 flex-1 resize-none py-2 font-mono text-[12px] leading-[1.6]`}
            />
            <p className="text-[11px] text-[var(--cf-text-muted)]">{t("db.snippetSyntax")}</p>
          </div>
        ) : (
          <p className="flex flex-1 items-center justify-center text-[12px] text-[var(--cf-text-muted)]">{t("db.snippetNone")}</p>
        )}
      </div>
    </ApiModal>
  );
}
