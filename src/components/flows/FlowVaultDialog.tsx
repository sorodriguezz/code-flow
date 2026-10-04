import { useEffect, useState } from "react";
import { Globe, KeyRound, Pencil, Plus, Trash2, Variable } from "lucide-react";
import { ApiModal } from "../api/ApiModal";
import { Button, iconButtonClass } from "../common/Button";
import { Select } from "../common/Select";
import { fieldClass, underlineStripClass, underlineTabClass } from "../common/recipes";
import type { FlowCredential, FlowCredentialKind } from "../../lib/tauri/flowsCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { chooseAction } from "../../state/confirmStore";
import { useFlowVaultStore } from "../../state/flowVaultStore";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * The workspace's `$vars` and its credentials, in one dialog with two tabs.
 *
 * A variable is plain text everybody may read — an API's base URL, a region. A credential is a
 * secret a node sends (a token, a password): it is typed here once, goes to the operating system's
 * keychain, and is never shown again — editing one means replacing it.
 */

const KINDS: FlowCredentialKind[] = ["bearer", "basic", "header", "query"];

function VariablesTab() {
  const t = useT();
  const variables = useFlowVaultStore((s) => s.variables);
  const workspaceId = useFlowVaultStore((s) => s.workspaceId);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string; value: string } | null>(null);
  const store = useFlowVaultStore.getState;

  const add = async () => {
    if (!name.trim()) return;
    if (await store().putVariable(name.trim(), value)) {
      setName("");
      setValue("");
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] items-center gap-2">
        <input className={fieldClass({ size: "sm", className: "font-mono" })} placeholder="API_BASE" value={name} onChange={(e) => setName(e.target.value)} />
        <input
          className={fieldClass({ size: "sm" })}
          placeholder={t("flows.vault.value")}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void add()}
        />
        <Button size="sm" onClick={() => void add()} disabled={!name.trim()}>
          <Plus size={12} />
          {t("flows.vault.add")}
        </Button>
      </div>
      <div className="flex flex-col">
        {variables.length === 0 && <p className="py-3 text-[12px] text-[var(--cf-text-muted)]">{t("flows.vault.noVariables")}</p>}
        {variables.map((variable) =>
          editing?.id === variable.id ? (
            <div key={variable.id} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto] items-center gap-2 py-1">
              <input className={fieldClass({ size: "sm", className: "font-mono" })} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <input className={fieldClass({ size: "sm" })} value={editing.value} onChange={(e) => setEditing({ ...editing, value: e.target.value })} />
              <span className="flex gap-1">
                <Button size="sm" onClick={() => setEditing(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={async () => {
                    if (editing.name.trim() !== variable.name && !(await store().renameVariable(variable.id, editing.name.trim()))) return;
                    if (await store().putVariable(editing.name.trim(), editing.value)) setEditing(null);
                  }}
                >
                  {t("common.save")}
                </Button>
              </span>
            </div>
          ) : (
            <div key={variable.id} className="group flex min-h-[30px] items-center gap-2 border-b border-[var(--cf-border)] py-1 last:border-b-0">
              <code className="w-[38%] min-w-0 truncate text-[12px] text-[var(--cf-text)]">$vars.{variable.name}</code>
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--cf-text-muted)]">{variable.value}</span>
              {variable.scope === "global" && (
                <span title={variable.workspaceId === workspaceId ? t("flows.vault.globalHere") : t("flows.vault.globalElsewhere")}>
                  <Globe size={12} className="text-[var(--cf-text-faint)]" />
                </span>
              )}
              <span className="flex opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  className={iconButtonClass({ size: "xs" })}
                  title={variable.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
                  aria-label={variable.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
                  onClick={() => void store().setVariableScope(variable.id, variable.scope !== "global")}
                >
                  <Globe size={12} />
                </button>
                <button type="button" className={iconButtonClass({ size: "xs" })} title={t("common.edit")} aria-label={t("common.edit")} onClick={() => setEditing({ id: variable.id, name: variable.name, value: variable.value })}>
                  <Pencil size={12} />
                </button>
                <button type="button" className={iconButtonClass({ size: "xs" })} title={t("common.delete")} aria-label={t("common.delete")} onClick={() => void store().deleteVariable(variable.id)}>
                  <Trash2 size={12} />
                </button>
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

interface CredentialDraft {
  id: string | null;
  name: string;
  kind: FlowCredentialKind;
  user: string;
  field: string;
  secret: string;
}

const blankCredential = (): CredentialDraft => ({ id: null, name: "", kind: "bearer", user: "", field: "", secret: "" });

function CredentialsTab() {
  const t = useT();
  const credentials = useFlowVaultStore((s) => s.credentials);
  const [draft, setDraft] = useState<CredentialDraft | null>(null);
  const store = useFlowVaultStore.getState;

  const edit = (credential: FlowCredential) =>
    setDraft({
      id: credential.id,
      name: credential.name,
      kind: credential.kind,
      user: credential.meta.user ?? "",
      field: credential.meta.name ?? "",
      secret: "",
    });

  const save = async () => {
    if (!draft) return;
    const meta: Record<string, string> = draft.kind === "basic" ? { user: draft.user } : draft.kind === "header" || draft.kind === "query" ? { name: draft.field } : {};
    const ok = draft.id
      ? await store().updateCredential(draft.id, draft.name, meta, draft.secret || null)
      : !!(await store().createCredential(draft.name, draft.kind, meta, draft.secret));
    if (ok) setDraft(null);
  };

  if (draft) {
    const secretLabel = draft.kind === "basic" ? t("flows.vault.password") : draft.kind === "bearer" ? t("flows.vault.token") : t("flows.vault.value");
    return (
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.name")}</span>
          <input autoFocus className={fieldClass({ size: "sm" })} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t("flows.vault.namePlaceholder")} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.kind")}</span>
          <div className="max-w-[260px]">
            <Select
              value={draft.kind}
              disabled={draft.id !== null}
              onChange={(kind) => setDraft({ ...draft, kind: kind as FlowCredentialKind })}
              options={KINDS.map((kind) => ({ value: kind, label: t(`flows.cred.${kind}` as TranslationKey) }))}
              size="sm"
            />
          </div>
        </div>
        {draft.kind === "basic" && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{t("flows.vault.user")}</span>
            <input className={fieldClass({ size: "sm" })} value={draft.user} onChange={(e) => setDraft({ ...draft, user: e.target.value })} />
          </label>
        )}
        {(draft.kind === "header" || draft.kind === "query") && (
          <label className="flex flex-col gap-1">
            <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{draft.kind === "header" ? t("flows.vault.headerName") : t("flows.vault.queryName")}</span>
            <input className={fieldClass({ size: "sm", className: "font-mono" })} value={draft.field} placeholder={draft.kind === "header" ? "X-API-Key" : "api_key"} onChange={(e) => setDraft({ ...draft, field: e.target.value })} />
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-[var(--cf-text-muted)]">{secretLabel}</span>
          <input
            type="password"
            autoComplete="new-password"
            className={fieldClass({ size: "sm" })}
            value={draft.secret}
            placeholder={draft.id ? t("flows.vault.keepSecret") : ""}
            onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button size="sm" onClick={() => setDraft(null)}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={!draft.name.trim() || (!draft.id && !draft.secret)}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button size="sm" onClick={() => setDraft(blankCredential())}>
          <Plus size={12} />
          {t("flows.vault.newCredential")}
        </Button>
      </div>
      {credentials.length === 0 && <p className="py-3 text-[12px] text-[var(--cf-text-muted)]">{t("flows.vault.noCredentials")}</p>}
      {credentials.map((credential) => (
        <div key={credential.id} className="group flex min-h-[32px] items-center gap-2 border-b border-[var(--cf-border)] py-1 last:border-b-0">
          <KeyRound size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
          <span className="min-w-0 flex-1 truncate text-[12.5px]">{credential.name}</span>
          <span className="shrink-0 text-[11.5px] text-[var(--cf-text-muted)]">
            {t(`flows.cred.${credential.kind}` as TranslationKey)}
            {credential.meta.name ? ` · ${credential.meta.name}` : credential.meta.user ? ` · ${credential.meta.user}` : ""}
          </span>
          {credential.scope === "global" && <Globe size={12} className="shrink-0 text-[var(--cf-text-faint)]" />}
          <span className="flex opacity-0 transition-opacity group-hover:opacity-100">
            <button
              type="button"
              className={iconButtonClass({ size: "xs" })}
              title={credential.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
              aria-label={credential.scope === "global" ? t("flows.vault.makeLocal") : t("flows.vault.makeGlobal")}
              onClick={() => void store().setCredentialScope(credential.id, credential.scope !== "global")}
            >
              <Globe size={12} />
            </button>
            <button type="button" className={iconButtonClass({ size: "xs" })} title={t("common.edit")} aria-label={t("common.edit")} onClick={() => edit(credential)}>
              <Pencil size={12} />
            </button>
            <button
              type="button"
              className={iconButtonClass({ size: "xs" })}
              title={t("common.delete")}
              aria-label={t("common.delete")}
              onClick={() =>
                void chooseAction({
                  message: t("flows.vault.deleteCredential", { name: credential.name }),
                  danger: true,
                  choices: [{ id: "delete", label: t("common.delete"), variant: "danger" }],
                }).then((answer) => answer === "delete" && void store().deleteCredential(credential.id))
              }
            >
              <Trash2 size={12} />
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

export function FlowVaultDialog() {
  const t = useT();
  const tab = useFlowVaultStore((s) => s.dialog);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  useEffect(() => {
    if (tab && workspaceId) void useFlowVaultStore.getState().load(workspaceId);
  }, [tab, workspaceId]);
  if (!tab) return null;
  const close = () => useFlowVaultStore.getState().openDialog(null);
  return (
    <ApiModal icon={tab === "variables" ? Variable : KeyRound} title={t("flows.vault.title")} width="max-w-2xl" height="h-[520px]" onClose={close} dismissOnBackdrop={false}>
      <div className={`${underlineStripClass} h-9 px-4`}>
        {(["variables", "credentials"] as const).map((name) => (
          <button key={name} type="button" className={underlineTabClass(tab === name)} onClick={() => useFlowVaultStore.getState().openDialog(name)}>
            {t(name === "variables" ? "flows.vault.variables" : "flows.vault.credentials")}
            {tab === name && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded bg-[var(--cf-accent)]" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{tab === "variables" ? <VariablesTab /> : <CredentialsTab />}</div>
    </ApiModal>
  );
}
