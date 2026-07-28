import { useState } from "react";
import { Cookie, Plus, Trash2 } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { ApiModal, Field, GhostButton } from "./ApiModal";
import { useApiStore } from "../../state/apiStore";
import { confirmAction } from "../../state/confirmStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { ApiCookie } from "../../types/api";

const GRID = "minmax(0,1fr) minmax(0,1.5fr) minmax(0,0.7fr) minmax(0,1.1fr) 52px 62px 24px";
const NEW_GRID = `minmax(0,1fr) ${GRID}`;

function newCookie(workspaceId: string): ApiCookie {
  return {
    id: `cookie-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    workspace_id: workspaceId,
    domain: "",
    path: "/",
    name: "",
    value: "",
    secure: false,
    http_only: false,
    expires: null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * The DB's unique key is `(workspace_id, domain, path, name)` — editing any of the three fields
 * below is a move, not an edit. The workspace isn't compared: every row in the jar is this
 * workspace's, and none of them can be dragged into another one.
 */
function sameIdentity(a: ApiCookie, b: ApiCookie): boolean {
  return a.domain === b.domain && a.path === b.path && a.name === b.name;
}

/** Everything a blur could have changed; `updated_at` is stamped on write, so it can't be part of it. */
function sameValues(a: ApiCookie, b: ApiCookie): boolean {
  return (
    sameIdentity(a, b) &&
    a.value === b.value &&
    a.secure === b.secure &&
    a.http_only === b.http_only &&
    a.expires === b.expires
  );
}

export function CookieModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const cookies = useApiStore((s) => s.cookies);
  const workspaceId = useApiStore((s) => s.workspaceId);
  const upsertCookie = useApiStore((s) => s.upsertCookie);
  const deleteCookie = useApiStore((s) => s.deleteCookie);
  const clearCookies = useApiStore((s) => s.clearCookies);
  const pushToast = useToastStore((s) => s.pushToast);

  /**
   * The live editing overlay. Text fields write here and only reach SQLite on blur, so typing a
   * cookie name doesn't produce one insert per character into a table keyed by that very name.
   *
   * Entries are kept after they're written rather than cleared: the store's own update lands one
   * IPC round trip later, and dropping the overlay in between would flash the pre-edit value back
   * into a field the user is still typing in.
   */
  const [drafts, setDrafts] = useState<Record<string, ApiCookie>>({});
  /** Rows the user added that aren't saved yet: a cookie with no domain or name has no identity
   * to store under, so it stays here until it has one. */
  const [pending, setPending] = useState<ApiCookie[]>([]);

  const current = (cookie: ApiCookie): ApiCookie => drafts[cookie.id] ?? cookie;

  const edit = (cookie: ApiCookie, patch: Partial<ApiCookie>) =>
    setDrafts((previous) => ({ ...previous, [cookie.id]: { ...current(cookie), ...patch } }));

  const persist = async (stored: ApiCookie, next: ApiCookie) => {
    if (!next.domain.trim() || !next.name.trim()) return;
    // The old row would otherwise survive alongside the renamed one, since the insert lands under
    // a key the conflict clause never sees.
    if (!sameIdentity(next, stored)) await deleteCookie(stored.id);
    await upsertCookie({ ...next, updated_at: new Date().toISOString() });
  };

  const commit = (cookie: ApiCookie) => {
    const draft = drafts[cookie.id];
    if (!draft || sameValues(draft, cookie)) return;
    void persist(cookie, draft);
  };

  /** A toggle has no blur to wait for, so it writes as soon as it flips. */
  const toggle = (cookie: ApiCookie, patch: Partial<ApiCookie>) => {
    const next = { ...current(cookie), ...patch };
    setDrafts((previous) => ({ ...previous, [cookie.id]: next }));
    void persist(cookie, next);
  };

  const editPending = (id: string, patch: Partial<ApiCookie>) =>
    setPending((previous) => previous.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const commitPending = async (row: ApiCookie) => {
    if (!row.domain.trim() || !row.name.trim()) return;
    setPending((previous) => previous.filter((entry) => entry.id !== row.id));
    await upsertCookie({ ...row, updated_at: new Date().toISOString() });
  };

  /** A cookie is stored under a workspace, so there is nothing to add before one is loaded. */
  const addPending = () => {
    if (workspaceId === null) return;
    setPending((previous) => [...previous, newCookie(workspaceId)]);
  };

  const remove = async (cookie: ApiCookie) => {
    if (!(await confirmAction(t("api.cookie.deleteConfirm", { name: cookie.name })))) return;
    await deleteCookie(cookie.id);
  };

  const clearAll = async () => {
    if (!(await confirmAction(t("api.cookie.clearAllConfirm")))) return;
    await clearCookies();
    setDrafts({});
    setPending([]);
    pushToast(t("api.toast.cookieCleared"), "success");
  };

  // Grouped by the stored domain, not the draft's: a row must not jump between sections (and lose
  // focus) while it's being edited. The domain itself is therefore fixed once a cookie exists.
  const byDomain = new Map<string, ApiCookie[]>();
  for (const cookie of cookies) {
    const key = cookie.domain || "—";
    const bucket = byDomain.get(key);
    if (bucket) bucket.push(cookie);
    else byDomain.set(key, [cookie]);
  }
  const domains = [...byDomain.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <ApiModal
      icon={Cookie}
      title={t("api.cookies")}
      width="max-w-3xl"
      height="h-[70vh]"
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={addPending} disabled={workspaceId === null}>
            <Plus size={12} />
            {t("api.cookie.add")}
          </GhostButton>
          <span className="ml-auto" />
          <GhostButton onClick={() => void clearAll()} disabled={cookies.length === 0}>
            <Trash2 size={12} />
            {t("api.settings.clearCookies")}
          </GhostButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {cookies.length === 0 && pending.length === 0 && (
          <p className="p-3 text-[12px] text-[var(--cf-text-muted)]">{t("api.cookie.none")}</p>
        )}

        {domains.map((domain) => (
          <section key={domain} className="mb-4">
            <h3 className="mb-1 font-mono text-[11px] font-semibold text-[var(--cf-accent)]">
              {domain}
            </h3>

            <div
              className="grid items-center gap-2 border-b border-[var(--cf-border)] pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]"
              style={{ gridTemplateColumns: GRID }}
            >
              <span>{t("api.cookie.name")}</span>
              <span>{t("api.value")}</span>
              <span>{t("api.cookie.path")}</span>
              <span>{t("api.cookie.expires")}</span>
              <span>{t("api.cookie.secure")}</span>
              <span>{t("api.cookie.httpOnly")}</span>
              <span />
            </div>

            {(byDomain.get(domain) ?? []).map((cookie) => {
              const row = current(cookie);
              return (
                <div
                  key={cookie.id}
                  className="grid items-center gap-2 border-b border-[var(--cf-border)] py-1"
                  style={{ gridTemplateColumns: GRID }}
                  onBlur={() => commit(cookie)}
                >
                  <Field
                    mono
                    value={row.name}
                    placeholder={t("api.cookie.name")}
                    onChange={(name) => edit(cookie, { name })}
                  />
                  <Field
                    mono
                    value={row.value}
                    placeholder={t("api.value")}
                    onChange={(value) => edit(cookie, { value })}
                  />
                  <Field
                    mono
                    value={row.path}
                    placeholder="/"
                    onChange={(path) => edit(cookie, { path })}
                  />
                  <Field
                    mono
                    value={row.expires ?? ""}
                    placeholder={t("api.cookie.session")}
                    onChange={(expires) => edit(cookie, { expires: expires.trim() || null })}
                  />
                  <span className="flex justify-center">
                    <Checkbox
                      checked={row.secure}
                      onChange={(secure) => toggle(cookie, { secure })}
                    />
                  </span>
                  <span className="flex justify-center">
                    <Checkbox
                      checked={row.http_only}
                      onChange={(http_only) => toggle(cookie, { http_only })}
                    />
                  </span>
                  <button
                    onClick={() => void remove(cookie)}
                    title={t("api.delete")}
                    className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </section>
        ))}

        {pending.length > 0 && (
          <section>
            <div
              className="grid items-center gap-2 border-b border-[var(--cf-border)] pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]"
              style={{ gridTemplateColumns: NEW_GRID }}
            >
              <span>{t("api.cookie.domain")}</span>
              <span>{t("api.cookie.name")}</span>
              <span>{t("api.value")}</span>
              <span>{t("api.cookie.path")}</span>
              <span>{t("api.cookie.expires")}</span>
              <span>{t("api.cookie.secure")}</span>
              <span>{t("api.cookie.httpOnly")}</span>
              <span />
            </div>

            {pending.map((row) => (
              <div
                key={row.id}
                className="grid items-center gap-2 border-b border-[var(--cf-border)] py-1"
                style={{ gridTemplateColumns: NEW_GRID }}
                onBlur={() => void commitPending(row)}
              >
                <Field
                  mono
                  value={row.domain}
                  placeholder={t("api.cookie.domain")}
                  onChange={(domain) => editPending(row.id, { domain })}
                />
                <Field
                  mono
                  value={row.name}
                  placeholder={t("api.cookie.name")}
                  onChange={(name) => editPending(row.id, { name })}
                />
                <Field
                  mono
                  value={row.value}
                  placeholder={t("api.value")}
                  onChange={(value) => editPending(row.id, { value })}
                />
                <Field mono value={row.path} placeholder="/" onChange={(path) => editPending(row.id, { path })} />
                <Field
                  mono
                  value={row.expires ?? ""}
                  placeholder={t("api.cookie.session")}
                  onChange={(expires) => editPending(row.id, { expires: expires.trim() || null })}
                />
                <span className="flex justify-center">
                  <Checkbox
                    checked={row.secure}
                    onChange={(secure) => editPending(row.id, { secure })}
                  />
                </span>
                <span className="flex justify-center">
                  <Checkbox
                    checked={row.http_only}
                    onChange={(http_only) => editPending(row.id, { http_only })}
                  />
                </span>
                <button
                  onClick={() => setPending((previous) => previous.filter((entry) => entry.id !== row.id))}
                  title={t("api.removeRow")}
                  className="rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </section>
        )}
      </div>
    </ApiModal>
  );
}
