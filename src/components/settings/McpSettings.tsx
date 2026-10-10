import { useEffect, useState } from "react";
import { Download, Pencil, Plus, ShieldAlert, Trash2 } from "lucide-react";
import {
  mcpApprove,
  mcpDelete,
  mcpImport,
  mcpImportCandidates,
  mcpList,
  mcpSave,
  type McpImportCandidate,
  type McpServer,
  type McpServerInput,
} from "../../lib/tauri/mcpCommands";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { confirmAction } from "../../state/confirmStore";
import { useT } from "../../state/languageStore";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { SettingsHeader } from "../api/settingsChrome";
import { buttonClass } from "../common/Button";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import { fieldClass } from "../common/recipes";

/** What a stored secret reads as, and what sending it back means: keep it. */
const REDACTED = "•••";

/** The engines a declared server can be handed to — the rest take none (see `mcp_registry::supports`). */
const PROVIDERS: Array<{ id: string; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "grok", label: "Grok" },
];

interface Draft {
  id: string | null;
  scope: "global" | "workspace";
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  /** One argument per line — an argument with a space in it stays one argument. */
  args: string;
  /** `KEY=value` per line; a stored value shows as `KEY=•••`. */
  env: string;
  url: string;
  /** `Name: value` per line. */
  headers: string;
  defaultOn: boolean;
}

const EMPTY: Draft = {
  id: null,
  scope: "global",
  name: "",
  transport: "stdio",
  command: "",
  args: "",
  env: "",
  url: "",
  headers: "",
  defaultOn: false,
};

function draftOf(server: McpServer): Draft {
  return {
    id: server.id,
    scope: server.scope,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args.join("\n"),
    env: Object.keys(server.env).map((key) => `${key}=${REDACTED}`).join("\n"),
    url: server.url,
    headers: Object.keys(server.headers).map((key) => `${key}: ${REDACTED}`).join("\n"),
    defaultOn: server.defaultOn,
  };
}

function pairs(text: string, separator: "=" | ":"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(separator);
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

/**
 * MCP servers declared once in CodeFlow and handed to whichever engine a chat turn runs on, in that
 * engine's own terms — Claude Code, Codex and (for servers with no secrets) Grok.
 *
 * The values of environment variables and headers are secrets: the backend keeps them in the OS
 * keychain and this screen only ever sees `•••`, sending it back to mean "keep what is stored".
 * A server that arrived without being written here — a restored backup — waits for "Approve" before
 * any engine starts it.
 */
/** `bare`: inside «Herramientas de IA», whose rail names the pane — the hint stays, the heading goes. */
/** The setting that keeps the repository map out of the CLI agents' runs; anything but "false" is on. */
const CODEMAP_MCP_KEY = "codemap_mcp";

/**
 * Whether Claude Code and Codex get CodeFlow's own server — the repository map (`codemap::mcp`) —
 * on every run in a repository. Not a row of the list below: it is not the user's server, has no
 * command, and is not per workspace.
 */
function CodemapServerToggle() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void getSetting(CODEMAP_MCP_KEY)
      .then((value) => setOn(value !== "false"))
      .catch(() => setOn(true));
  }, []);
  if (on === null) return null;
  return (
    <label className="mb-3 flex items-start gap-2.5 py-1.5">
      <span className="mt-[1px]">
        <Checkbox
          checked={on}
          onChange={(next) => {
            setOn(next);
            void setSetting(CODEMAP_MCP_KEY, next ? "true" : "false").catch((e: unknown) => pushErrorToast(String(e)));
          }}
        />
      </span>
      <span className="text-[12.5px] text-[var(--cf-text)]">
        {t("codemap.mcpLabel")}
        <span className="mt-0.5 block text-[11.5px] text-[var(--cf-text-muted)]">{t("codemap.mcpHint")}</span>
      </span>
    </label>
  );
}

export function McpSettings({ bare = false }: { bare?: boolean } = {}) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [candidates, setCandidates] = useState<McpImportCandidate[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const reload = async (id: string) => {
    const loaded = await mcpList(id);
    // A workspace switch while this was in flight: the answer belongs to a screen that moved on.
    if (useWorkspaceStore.getState().activeWorkspaceId !== id) return;
    setServers(loaded);
  };

  useEffect(() => {
    setDraft(null);
    setCandidates(null);
    if (workspaceId) void reload(workspaceId).catch((e: unknown) => pushErrorToast(String(e)));
    else setServers([]);
  }, [workspaceId]);

  if (!workspaceId) {
    return (
      <section>
        {bare ? (
          <p className="mb-3 max-w-[62ch] text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("settings.skillsSelectWorkspace")}</p>
        ) : (
          <SettingsHeader title={t("settings.mcpTitle")} hint={t("settings.skillsSelectWorkspace")} />
        )}
      </section>
    );
  }

  const update = async (server: McpServer, patch: Partial<McpServerInput>) => {
    try {
      const input: McpServerInput = {
        id: server.id,
        workspaceId: server.workspaceId,
        scope: server.scope,
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
        enabled: server.enabled,
        defaultOn: server.defaultOn,
        excluded: server.excluded,
        ...patch,
      };
      await mcpSave(input);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const existing = servers.find((s) => s.id === draft.id);
      await mcpSave({
        id: draft.id,
        workspaceId,
        scope: draft.scope,
        name: draft.name.trim(),
        transport: draft.transport,
        command: draft.command.trim(),
        args: draft.args.split("\n").map((a) => a.trim()).filter(Boolean),
        env: pairs(draft.env, "="),
        url: draft.url.trim(),
        headers: pairs(draft.headers, ":"),
        enabled: existing?.enabled ?? true,
        defaultOn: draft.defaultOn,
        excluded: existing?.excluded ?? [],
      });
      setDraft(null);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (server: McpServer) => {
    if (!(await confirmAction(t("settings.mcpDeleteConfirm", { name: server.name })))) return;
    try {
      await mcpDelete(server.id);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const approve = async (server: McpServer) => {
    try {
      await mcpApprove(server.id);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const openImport = async () => {
    try {
      const found = await mcpImportCandidates();
      setCandidates(found.filter((c) => !servers.some((s) => s.name === c.name)));
      setPicked(new Set());
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const runImport = async () => {
    if (!candidates) return;
    try {
      for (const source of ["claude", "codex"] as const) {
        const names = candidates.filter((c) => c.source === source && picked.has(`${source}:${c.name}`)).map((c) => c.name);
        if (names.length > 0) await mcpImport(workspaceId, source, names);
      }
      setCandidates(null);
      await reload(workspaceId);
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  return (
    <section>
      {bare ? (
        <p className="mb-3 max-w-[62ch] text-[12px] leading-snug text-[var(--cf-text-muted)]">{t("settings.mcpHint")}</p>
      ) : (
        <SettingsHeader title={t("settings.mcpTitle")} hint={t("settings.mcpHint")} />
      )}

      <CodemapServerToggle />

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setDraft({ ...EMPTY })} className={buttonClass({ variant: "primary", size: "sm" })}>
          <Plus size={13} />
          {t("settings.mcpAdd")}
        </button>
        <button type="button" onClick={() => void openImport()} className={buttonClass({ size: "sm" })}>
          <Download size={13} />
          {t("settings.mcpImport")}
        </button>
      </div>

      {candidates && (
        <div className="mb-3 space-y-1.5 rounded-lg border border-[var(--cf-border)] p-3">
          {candidates.length === 0 ? (
            <p className="text-[12px] text-[var(--cf-text-muted)]">{t("settings.mcpImportNone")}</p>
          ) : (
            candidates.map((candidate) => {
              const key = `${candidate.source}:${candidate.name}`;
              return (
                <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-[var(--cf-hover)]">
                  <Checkbox
                    checked={picked.has(key)}
                    onChange={(checked) =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        if (checked) next.add(key);
                        else next.delete(key);
                        return next;
                      })
                    }
                  />
                  <span className="font-mono text-[12px] text-[var(--cf-text)]">{candidate.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text-muted)]" title={candidate.summary}>
                    {candidate.summary}
                  </span>
                  <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                    {candidate.source === "claude" ? "Claude Code" : "Codex"}
                  </span>
                </label>
              );
            })
          )}
          <div className="flex gap-1.5 pt-1">
            <button
              type="button"
              disabled={picked.size === 0}
              onClick={() => void runImport()}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              {t("settings.mcpImportPicked", { count: picked.size })}
            </button>
            <button type="button" onClick={() => setCandidates(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {draft && (
        <div className="mb-3 space-y-2 rounded-lg border border-[var(--cf-accent)]/40 p-3">
          <div className="flex gap-1.5">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={t("settings.mcpName")}
              className={fieldClass({ className: "flex-1 font-mono" })}
            />
            <div className="w-32">
              <Select
                value={draft.transport}
                onChange={(value) => setDraft({ ...draft, transport: value as Draft["transport"] })}
                options={[
                  { value: "stdio", label: "stdio" },
                  { value: "http", label: "HTTP" },
                  { value: "sse", label: "SSE" },
                ]}
              />
            </div>
            <div className="w-40">
              <Select
                value={draft.scope}
                onChange={(value) => setDraft({ ...draft, scope: value as Draft["scope"] })}
                options={[
                  { value: "global", label: t("settings.mcpScopeGlobal") },
                  { value: "workspace", label: t("settings.mcpScopeWorkspace") },
                ]}
              />
            </div>
          </div>
          {draft.transport === "stdio" ? (
            <>
              <input
                value={draft.command}
                onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                placeholder={t("settings.mcpCommand")}
                className={fieldClass({ className: "w-full font-mono" })}
              />
              <textarea
                value={draft.args}
                onChange={(e) => setDraft({ ...draft, args: e.target.value })}
                placeholder={t("settings.mcpArgs")}
                rows={3}
                className={`${fieldClass({ className: "w-full font-mono" })} h-auto py-1.5`}
              />
              <textarea
                value={draft.env}
                onChange={(e) => setDraft({ ...draft, env: e.target.value })}
                placeholder={t("settings.mcpEnv")}
                title={t("settings.mcpSecretsHint")}
                rows={2}
                className={`${fieldClass({ className: "w-full font-mono" })} h-auto py-1.5`}
              />
            </>
          ) : (
            <>
              <input
                value={draft.url}
                onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                placeholder="https://…"
                className={fieldClass({ className: "w-full font-mono" })}
              />
              <textarea
                value={draft.headers}
                onChange={(e) => setDraft({ ...draft, headers: e.target.value })}
                placeholder={t("settings.mcpHeaders")}
                title={t("settings.mcpSecretsHint")}
                rows={2}
                className={`${fieldClass({ className: "w-full font-mono" })} h-auto py-1.5`}
              />
            </>
          )}
          <label className="flex w-fit cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]" title={t("settings.mcpDefaultOnHint")}>
            <Checkbox checked={draft.defaultOn} onChange={(checked) => setDraft({ ...draft, defaultOn: checked })} />
            {t("settings.mcpDefaultOn")}
          </label>
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={saving || !draft.name.trim()}
              onClick={() => void save()}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              {t("common.save")}
            </button>
            <button type="button" onClick={() => setDraft(null)} className={buttonClass({ variant: "ghost", size: "sm" })}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {servers.map((server) => (
          <div
            key={server.id}
            className={`rounded-lg border p-3 ${server.trusted ? "border-[var(--cf-border)]" : "border-[var(--cf-warning)]/50"}`}
          >
            <div className="flex items-center gap-2">
              <Checkbox checked={server.enabled} onChange={(enabled) => void update(server, { enabled })} />
              <span className="font-mono text-[13px] font-medium text-[var(--cf-text)]">{server.name}</span>
              <span className="rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                {server.transport}
              </span>
              <span className="rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                {server.scope === "global" ? t("settings.mcpScopeGlobal") : t("settings.mcpScopeWorkspace")}
              </span>
              <span className="flex-1" />
              {!server.trusted && (
                <button
                  type="button"
                  onClick={() => void approve(server)}
                  title={t("settings.mcpUntrustedHint")}
                  className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-[var(--cf-warning)] hover:bg-[var(--cf-hover)]"
                >
                  <ShieldAlert size={12} />
                  {t("settings.mcpApprove")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setDraft(draftOf(server))}
                aria-label={t("common.edit")}
                title={t("common.edit")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)]"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => void remove(server)}
                aria-label={t("common.delete")}
                title={t("common.delete")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-danger)]"
              >
                <Trash2 size={12} />
              </button>
            </div>
            <p className="mt-1 truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]">
              {server.transport === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-[var(--cf-text-muted)]">
              <label className="flex cursor-pointer items-center gap-1.5" title={t("settings.mcpDefaultOnHint")}>
                <Checkbox checked={server.defaultOn} onChange={(defaultOn) => void update(server, { defaultOn })} />
                {t("settings.mcpDefaultOn")}
              </label>
              {PROVIDERS.map((provider) => {
                const handed = !server.excluded.includes(provider.id);
                return (
                  <label key={provider.id} className="flex cursor-pointer items-center gap-1.5">
                    <Checkbox
                      checked={handed}
                      onChange={(checked) =>
                        void update(server, {
                          excluded: checked
                            ? server.excluded.filter((p) => p !== provider.id)
                            : [...server.excluded, provider.id],
                        })
                      }
                    />
                    {provider.label}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
