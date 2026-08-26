import { useEffect, useMemo, useState } from "react";
import { Check, Globe, Pencil, RotateCcw, TriangleAlert, User, X } from "lucide-react";
import {
  getEffectiveIdentity,
  listWorkspaceIdentities,
  setWorkspaceIdentity,
} from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useRepoStore } from "../../state/repoStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import type { EffectiveIdentity } from "../../types/domain";

/**
 * Per-workspace git identity: who each workspace commits as, and what that resolves to right now.
 *
 * The design question this screen answers is **provenance**, not storage. Git resolves an identity
 * through three levels of config and a name on its own tells you nothing about which one won — so a
 * panel that showed two text boxes would let someone set a workspace identity, watch it apparently
 * not take effect (because that repository has a hand-written `user.email`), and have no way to
 * find out why. Hence the card at the top: it reads the *effective* identity out of git itself, the
 * same call `repo.signature()` makes, and says where it came from.
 *
 * The list below is every workspace, not just the active one. Keeping two identities apart is a
 * thing people set up once, across all their workspaces, and making them switch workspace to edit
 * each one would turn a five-minute setup into a hunt.
 */

/** Deliberately loose. A stricter pattern rejects addresses that are perfectly valid, and git will
 *  accept anything — this only exists to catch a missing `@` before it reaches a commit. */
function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 2 && /^[^\s@]+@[^\s@]+$/.test(trimmed);
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The badge that says which level of config supplied the identity on screen. */
function SourceBadge({ source }: { source: EffectiveIdentity["source"] }) {
  const t = useT();
  const label =
    source === "workspace"
      ? t("settings.identityFromWorkspace")
      : source === "repository"
        ? t("settings.identityFromRepo")
        : t("settings.identityFromGlobal");
  const hint =
    source === "workspace"
      ? t("settings.identityFromWorkspaceHint")
      : source === "repository"
        ? t("settings.identityFromRepoHint")
        : t("settings.identityFromGlobalHint");
  return (
    <span
      title={hint}
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        source === "workspace"
          ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
          : "border border-[var(--cf-border)] text-[var(--cf-text-muted)]"
      }`}
    >
      {label}
    </span>
  );
}

/** One workspace's row: its override, or the fact that it inherits. */
function WorkspaceRow({
  id,
  name,
  color,
  identity,
  onSaved,
}: {
  id: string;
  name: string;
  color: string;
  identity: { name: string; email: string } | null;
  onSaved: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(identity?.name ?? "");
  const [draftEmail, setDraftEmail] = useState(identity?.email ?? "");
  const [busy, setBusy] = useState(false);

  // The row is rebuilt from the server after every save, so a fresh prop is the source of truth.
  useEffect(() => {
    setDraftName(identity?.name ?? "");
    setDraftEmail(identity?.email ?? "");
  }, [identity?.name, identity?.email]);

  const emailValid = draftEmail.trim() === "" || looksLikeEmail(draftEmail);
  const canSave = draftName.trim() !== "" && looksLikeEmail(draftEmail) && !busy;

  const apply = async (next: { name: string; email: string } | null) => {
    setBusy(true);
    try {
      const failures = await setWorkspaceIdentity(id, next?.name ?? null, next?.email ?? null);
      // The row is written whatever happens; what can fail is projecting it into a repository, and
      // that is worth naming rather than swallowing — a repository this missed will still commit as
      // whoever it committed as before.
      if (failures.length > 0) {
        pushErrorToast(t("settings.identityPartial", { repos: failures.join(", ") }));
      } else {
        useToastStore
          .getState()
          .pushToast(
            next ? t("settings.identitySaved", { name }) : t("settings.identityCleared", { name }),
            "success",
          );
      }
      setEditing(false);
      onSaved();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--cf-text)]">
          {name}
        </span>

        {!editing && identity && (
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
            <User size={11} className="shrink-0" />
            <span className="truncate">{identity.name}</span>
            <span className="shrink-0 opacity-50">·</span>
            <span className="truncate">{identity.email}</span>
          </span>
        )}
        {!editing && !identity && (
          <span
            title={t("settings.identityInheritsHint")}
            className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]"
          >
            <Globe size={11} />
            {t("settings.identityInherits")}
          </span>
        )}

        {!editing && (
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => setEditing(true)}
              title={identity ? t("settings.identityEdit") : t("settings.identitySet")}
              aria-label={identity ? t("settings.identityEdit") : t("settings.identitySet")}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.08]"
            >
              <Pencil size={12} />
            </button>
            {identity && (
              <button
                type="button"
                onClick={() => void apply(null)}
                disabled={busy}
                title={t("settings.identityReset")}
                aria-label={t("settings.identityReset")}
                className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-text)] disabled:opacity-40 dark:hover:bg-white/[0.08]"
              >
                <RotateCcw size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="mt-2.5 space-y-1.5">
          <div className="flex gap-2">
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder={t("settings.name")}
              className="min-w-0 flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
            />
            <input
              value={draftEmail}
              onChange={(e) => setDraftEmail(e.target.value)}
              placeholder={t("settings.email")}
              className={`min-w-0 flex-1 rounded-md border bg-transparent px-2.5 py-1.5 text-[13px] outline-none ${
                emailValid
                  ? "border-[var(--cf-border)] focus:border-[var(--cf-accent)]"
                  : "border-[var(--cf-danger)]"
              }`}
            />
            <button
              type="button"
              onClick={() => void apply({ name: draftName.trim(), email: draftEmail.trim() })}
              disabled={!canSave}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
            >
              <Check size={13} />
              {t("common.save")}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              title={t("common.cancel")}
              aria-label={t("common.cancel")}
              className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={13} />
            </button>
          </div>
          {!emailValid && (
            <p className="text-[11px] text-[var(--cf-danger)]">{t("settings.identityBadEmail")}</p>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkspaceIdentities() {
  const t = useT();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const repoPath = useRepoStore((s) => s.repoPath);
  const [overrides, setOverrides] = useState<Map<string, { name: string; email: string }>>(new Map());
  const [effective, setEffective] = useState<EffectiveIdentity | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void listWorkspaceIdentities()
      .then((rows) => {
        if (cancelled) return;
        setOverrides(new Map(rows.map(([id, name, email]) => [id, { name, email }])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  // Read from git rather than derived from the rows above, and that is the point: this is what will
  // actually author the next commit, including a hand-written repo override this app refuses to
  // touch. Re-read after every save so the card and the list can never disagree.
  useEffect(() => {
    if (!repoPath) {
      setEffective(null);
      return;
    }
    let cancelled = false;
    void getEffectiveIdentity(repoPath)
      .then((value) => {
        if (!cancelled) setEffective(value);
      })
      .catch(() => {
        if (!cancelled) setEffective(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, nonce]);

  const sorted = useMemo(
    () => [...workspaces].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [workspaces],
  );

  return (
    <div className="mt-5">
      <p className="mb-2 text-[13px] font-medium text-[var(--cf-text)]">
        {t("settings.identityPerWorkspace")}
      </p>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">
        {t("settings.identityPerWorkspaceHint")}
      </p>

      {/* The effective identity, first and largest. Everything below is a way of changing this
          number; showing it after the controls would make the user guess at the result. */}
      {effective && (
        <div className="mb-3 flex items-center gap-3 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[12px] font-semibold text-[var(--cf-accent)]">
            {initialsOf(effective.name ?? "?")}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[11px] uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("settings.identityEffective")}
            </span>
            <span className="block truncate text-[13px] font-medium text-[var(--cf-text)]">
              {effective.name ?? t("settings.identityUnset")}
            </span>
            <span className="block truncate text-[12px] text-[var(--cf-text-muted)]">
              {effective.email ?? t("settings.identityUnsetHint")}
            </span>
          </span>
          <SourceBadge source={effective.source} />
        </div>
      )}

      {/* A repository whose identity a human wrote by hand is the one case the workspace setting
          cannot reach, so it is called out rather than left to look like a bug. */}
      {effective?.source === "repository" && (
        <p className="mb-3 flex items-start gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-2 text-[12px] text-[var(--cf-text-muted)]">
          <TriangleAlert size={12} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
          {t("settings.identityRepoOverrideNote")}
        </p>
      )}

      {sorted.length === 0 ? (
        <p className="text-[13px] text-[var(--cf-text-muted)]">{t("settings.identityNoWorkspaces")}</p>
      ) : (
        <div className="space-y-1.5">
          {sorted.map((workspace) => (
            <WorkspaceRow
              key={workspace.id}
              id={workspace.id}
              name={workspace.name}
              color={workspace.color}
              identity={overrides.get(workspace.id) ?? null}
              onSaved={() => setNonce((n) => n + 1)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
