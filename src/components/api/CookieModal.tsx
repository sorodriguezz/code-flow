import { useState, type ReactNode } from "react";
import { Cookie, Globe, Plus, Trash2 } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Tooltip } from "../common/Tooltip";
import { ApiModal, GhostButton } from "./ApiModal";
import { useApiStore } from "../../state/apiStore";
import { confirmAction } from "../../state/confirmStore";
import { useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { ApiCookie } from "../../types/api";

const GRID = "minmax(0,1fr) minmax(0,1.5fr) minmax(0,0.7fr) minmax(0,1.1fr) 64px 76px 30px";
const NEW_GRID = `minmax(0,1fr) ${GRID}`;

/** The key/value table's box, header row and hairline rows — the same `.kv` look as the variables
 *  table, so a cookie jar and an environment read as the same kind of sheet. */
const TABLE = "min-w-0 overflow-hidden rounded-md border border-[var(--cf-border)]";
const HEAD =
  "grid h-[30px] items-center gap-1 border-b border-[var(--cf-border)] bg-[color-mix(in_oklab,var(--cf-sunken)_60%,var(--cf-surface))] px-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]";
const ROW = "grid items-center gap-1 border-b border-[var(--cf-border)] px-1 py-0.5 last:border-b-0";

/** A cell's input: borderless on the row, the field fill and an inset accent ring once focused. */
const CELL =
  "h-7 w-full min-w-0 rounded-md bg-transparent px-2.5 font-mono text-[12px] text-[var(--cf-text)] outline-none transition-[background-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:bg-[var(--cf-field)] focus:shadow-[inset_0_0_0_1px_var(--cf-accent)]";

function Cell({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
      className={CELL}
    />
  );
}

/** The header row's labels, padded to sit over the text of the cells below them. */
function HeadLabel({ children, center = false }: { children?: ReactNode; center?: boolean }) {
  return <span className={`truncate ${center ? "text-center" : "px-2.5"}`}>{children}</span>;
}

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
            <Plus size={14} />
            {t("api.cookie.add")}
          </GhostButton>
          <span className="ml-auto" />
          <button
            type="button"
            onClick={() => void clearAll()}
            disabled={cookies.length === 0}
            className={buttonClass({ variant: "danger-ghost" })}
          >
            <Trash2 size={14} />
            {t("api.settings.clearCookies")}
          </button>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {cookies.length === 0 && pending.length === 0 && (
          <p className="py-2 text-[12px] text-[var(--cf-text-muted)]">{t("api.cookie.none")}</p>
        )}

        {domains.map((domain) => (
          <section key={domain} className="mb-5">
            <h3 className="mb-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[12px] font-semibold text-[var(--cf-text)]">
              <Globe size={13} className="shrink-0 text-[var(--cf-text-faint)]" />
              <span className="truncate">{domain}</span>
            </h3>

            <div className={TABLE}>
              <div className={HEAD} style={{ gridTemplateColumns: GRID }}>
                <HeadLabel>{t("api.cookie.name")}</HeadLabel>
                <HeadLabel>{t("api.value")}</HeadLabel>
                <HeadLabel>{t("api.cookie.path")}</HeadLabel>
                <HeadLabel>{t("api.cookie.expires")}</HeadLabel>
                <HeadLabel center>{t("api.cookie.secure")}</HeadLabel>
                <HeadLabel center>{t("api.cookie.httpOnly")}</HeadLabel>
                <span />
              </div>

              {(byDomain.get(domain) ?? []).map((cookie) => {
                const row = current(cookie);
                return (
                  <div
                    key={cookie.id}
                    className={ROW}
                    style={{ gridTemplateColumns: GRID }}
                    onBlur={() => commit(cookie)}
                  >
                    <Cell
                      value={row.name}
                      placeholder={t("api.cookie.name")}
                      label={t("api.cookie.name")}
                      onChange={(name) => edit(cookie, { name })}
                    />
                    <Cell
                      value={row.value}
                      placeholder={t("api.value")}
                      label={t("api.value")}
                      onChange={(value) => edit(cookie, { value })}
                    />
                    <Cell
                      value={row.path}
                      placeholder="/"
                      label={t("api.cookie.path")}
                      onChange={(path) => edit(cookie, { path })}
                    />
                    <Cell
                      value={row.expires ?? ""}
                      placeholder={t("api.cookie.session")}
                      label={t("api.cookie.expires")}
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
                    <span className="flex justify-center">
                      <Tooltip label={t("api.delete")}>
                        <button
                          type="button"
                          onClick={() => void remove(cookie)}
                          aria-label={t("api.delete")}
                          className={iconButtonClass({ size: "xs" })}
                        >
                          <Trash2 size={13} />
                        </button>
                      </Tooltip>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {pending.length > 0 && (
          <section className={TABLE}>
            <div className={HEAD} style={{ gridTemplateColumns: NEW_GRID }}>
              <HeadLabel>{t("api.cookie.domain")}</HeadLabel>
              <HeadLabel>{t("api.cookie.name")}</HeadLabel>
              <HeadLabel>{t("api.value")}</HeadLabel>
              <HeadLabel>{t("api.cookie.path")}</HeadLabel>
              <HeadLabel>{t("api.cookie.expires")}</HeadLabel>
              <HeadLabel center>{t("api.cookie.secure")}</HeadLabel>
              <HeadLabel center>{t("api.cookie.httpOnly")}</HeadLabel>
              <span />
            </div>

            {pending.map((row) => (
              <div
                key={row.id}
                className={ROW}
                style={{ gridTemplateColumns: NEW_GRID }}
                onBlur={() => void commitPending(row)}
              >
                <Cell
                  value={row.domain}
                  placeholder={t("api.cookie.domain")}
                  label={t("api.cookie.domain")}
                  onChange={(domain) => editPending(row.id, { domain })}
                />
                <Cell
                  value={row.name}
                  placeholder={t("api.cookie.name")}
                  label={t("api.cookie.name")}
                  onChange={(name) => editPending(row.id, { name })}
                />
                <Cell
                  value={row.value}
                  placeholder={t("api.value")}
                  label={t("api.value")}
                  onChange={(value) => editPending(row.id, { value })}
                />
                <Cell
                  value={row.path}
                  placeholder="/"
                  label={t("api.cookie.path")}
                  onChange={(path) => editPending(row.id, { path })}
                />
                <Cell
                  value={row.expires ?? ""}
                  placeholder={t("api.cookie.session")}
                  label={t("api.cookie.expires")}
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
                <span className="flex justify-center">
                  <Tooltip label={t("api.removeRow")}>
                    <button
                      type="button"
                      onClick={() => setPending((previous) => previous.filter((entry) => entry.id !== row.id))}
                      aria-label={t("api.removeRow")}
                      className={iconButtonClass({ size: "xs" })}
                    >
                      <Trash2 size={13} />
                    </button>
                  </Tooltip>
                </span>
              </div>
            ))}
          </section>
        )}
      </div>
    </ApiModal>
  );
}
