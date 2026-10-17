import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Building2, CloudUpload, Download, Globe, Lock, ScrollText, UserRound } from "lucide-react";
import { useGitOutputStore } from "../../state/gitOutputStore";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { getGitIdentity, publishCreate, setGitIdentity, setRepoGitIdentity, type PublishProvider, type PublishTarget } from "../../lib/tauri/commands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Select } from "../common/Select";
import { useGitDialogStore } from "../../state/gitDialogStore";
import { useRepoStore } from "../../state/repoStore";
import { useT } from "../../state/languageStore";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import type { PullMode } from "../../types/domain";

/**
 * The two questions `gitDialogStore` asks mid-action: how to reconcile a pull that diverged, and
 * who is committing when git does not know.
 *
 * Portalled to `document.body`, like every overlay reached from inside the repository views: the
 * views render inside `.cf-ambient-bg`, whose `isolation: isolate` traps any `fixed` overlay under
 * the terminal dock, the AI panel and the status bar. `z-40` is the dialog layer — below the app-root
 * overlays (`z-50`) and below `ConfirmModal` (`z-[60]`), which must be able to rise over a dialog.
 *
 * Mounted once per window, by `RemoteActions` — see the store for why there.
 */
export function GitDialogs() {
  const pullChoice = useGitDialogStore((s) => s.pullChoice);
  const identity = useGitDialogStore((s) => s.identity);
  const commitFailure = useGitOutputStore((s) => s.failure);
  const publish = useGitDialogStore((s) => s.publish);
  return (
    <>
      {publish && <PublishDialog targets={publish.targets} initialName={publish.name} />}
      {pullChoice && <PullStrategyDialog branch={pullChoice.branch} upstream={pullChoice.upstream} />}
      {identity && <IdentityDialog />}
      {commitFailure && <CommitOutputDialog />}
    </>
  );
}

/** The dialog shell both questions share — `PromptModal`'s, at the dialog layer. */
function DialogShell({
  icon,
  title,
  onDismiss,
  children,
  wide = false,
}: {
  icon: React.ReactNode;
  title: string;
  onDismiss: () => void;
  children: React.ReactNode;
  /** Room for a block of output — a hook's report reads badly wrapped at 400px. */
  wide?: boolean;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onDismiss]);

  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4" onClick={onDismiss}>
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`cf-fade-in max-h-[calc(100vh-2rem)] ${wide ? "w-[640px]" : "w-[400px]"} max-w-[90vw] overflow-y-auto rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-5 shadow-[var(--cf-shadow-modal)]`}
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]">
            {icon}
          </span>
          <p className="min-w-0 flex-1 pt-1 text-[13px] leading-snug text-[var(--cf-text)] [overflow-wrap:anywhere]">
            {title}
          </p>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function PullStrategyDialog({ branch, upstream }: { branch: string; upstream: string }) {
  const answer = useGitDialogStore((s) => s.answerPullChoice);
  const t = useT();
  // Merge first and preselected: it is what `git pull` did for everyone before 2.33 started asking,
  // and the one answer that never rewrites a commit the user already has.
  const [mode, setMode] = useState<PullMode>("merge");
  const [remember, setRemember] = useState(false);

  return (
    <DialogShell
      icon={<Download size={15} />}
      title={t("pullChoice.title", { branch, upstream: upstream || `origin/${branch}` })}
      onDismiss={() => answer(null)}
    >
      <Segmented<PullMode>
        full
        layoutId="pull-strategy"
        ariaLabel={t("pullChoice.pull")}
        value={mode}
        onChange={setMode}
        options={[
          { value: "merge", label: t("pullChoice.merge"), title: t("pullChoice.mergeHint") },
          { value: "rebase", label: t("pullChoice.rebase"), title: t("pullChoice.rebaseHint") },
          { value: "ff_only", label: t("pullChoice.ffOnly"), title: t("pullChoice.ffOnlyHint") },
        ]}
      />
      <label
        title={t("pullChoice.rememberHint")}
        className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text-muted)]"
      >
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        {t("pullChoice.remember")}
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={() => answer(null)} className={buttonClass({ variant: "ghost" })}>
          {t("common.cancel")}
        </button>
        <button autoFocus onClick={() => answer({ mode, remember })} className={buttonClass({ variant: "primary" })}>
          {t("pullChoice.pull")}
        </button>
      </div>
    </DialogShell>
  );
}

type IdentityScope = "repo" | "global";

function IdentityDialog() {
  const answer = useGitDialogStore((s) => s.answerIdentity);
  const repoPath = useRepoStore((s) => s.repoPath);
  const t = useT();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // This repository by default: it changes the least, and a machine with no identity at all is as
  // often a shared or fresh one as it is the user's own.
  const [scope, setScope] = useState<IdentityScope>("repo");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whatever half of the identity git *does* have is the right starting point — a name without an
  // email is the common way to end up here.
  useEffect(() => {
    let cancelled = false;
    void getGitIdentity()
      .then((identity) => {
        if (cancelled) return;
        setName((current) => current || identity.name || "");
        setEmail((current) => current || identity.email || "");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const ready = name.trim().length > 0 && email.trim().includes("@") && !saving;

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      if (scope === "repo" && repoPath) await setRepoGitIdentity(repoPath, name.trim(), email.trim());
      else await setGitIdentity(name.trim(), email.trim());
      answer(true);
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void save();
  };

  return (
    <DialogShell icon={<UserRound size={15} />} title={t("identity.title")} onDismiss={() => answer(false)}>
      <div className="space-y-2">
        <input
          autoFocus
          value={name}
          spellCheck={false}
          placeholder={t("identity.name")}
          aria-label={t("identity.name")}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
          className={fieldClass({ className: "w-full" })}
        />
        <input
          value={email}
          type="email"
          spellCheck={false}
          placeholder={t("identity.email")}
          aria-label={t("identity.email")}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={onKeyDown}
          className={fieldClass({ className: "w-full" })}
        />
      </div>
      <Segmented<IdentityScope>
        full
        layoutId="identity-scope"
        className="mt-3"
        value={scope}
        onChange={setScope}
        options={[
          { value: "repo", label: t("identity.scopeRepo"), title: t("identity.scopeRepoHint"), disabled: !repoPath },
          { value: "global", label: t("identity.scopeGlobal"), title: t("identity.scopeGlobalHint") },
        ]}
      />
      {error && <p className="pt-2 text-[11px] leading-relaxed text-[var(--cf-danger)]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={() => answer(false)} className={buttonClass({ variant: "ghost" })}>
          {t("common.cancel")}
        </button>
        <button onClick={() => void save()} disabled={!ready} className={buttonClass({ variant: "primary" })}>
          {t("identity.save")}
        </button>
      </div>
    </DialogShell>
  );
}

/**
 * What a commit that did not land printed — a hook refusing it, or `git commit` itself failing (see
 * `gitOutputStore`). The whole output, monospaced and selectable, because the fix is in it: which lint
 * rule, which test, which file. The message the user wrote is still in the commit box.
 */
function CommitOutputDialog() {
  const failure = useGitOutputStore((s) => s.failure);
  const dismiss = useGitOutputStore((s) => s.dismiss);
  const t = useT();
  if (!failure) return null;
  return (
    <DialogShell
      wide
      icon={<ScrollText size={15} />}
      title={failure.kind === "hook" ? t("commitOutput.hookTitle") : t("commitOutput.commitTitle")}
      onDismiss={dismiss}
    >
      <pre className="max-h-[50vh] select-text overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--cf-sunken)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--cf-text)]">
        {failure.output || t("commitOutput.empty")}
      </pre>
      <p className="pt-2 text-[11px] text-[var(--cf-text-muted)]">{t("commitOutput.kept")}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={() => {
            void navigator.clipboard.writeText(failure.output).catch(() => {});
          }}
          className={buttonClass({ variant: "ghost" })}
        >
          {t("commitOutput.copy")}
        </button>
        <button autoFocus onClick={dismiss} className={buttonClass({ variant: "primary" })}>
          {t("common.close")}
        </button>
      </div>
    </DialogShell>
  );
}

/** What every host accepts in a repository name — anything else GitHub would rewrite to `-` behind
 *  our back, and Bitbucket turns into its slug anyway. */
function repoName(raw: string): string {
  return raw.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

const PROVIDER_NAME: Record<PublishProvider, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  azure: "Azure DevOps",
};

const VISIBILITY: Record<string, { label: TranslationKey; hint: TranslationKey; icon: typeof Lock }> = {
  private: { label: "publish.github.private", hint: "publish.github.privateHint", icon: Lock },
  internal: { label: "publish.internal", hint: "publish.internalHint", icon: Building2 },
  public: { label: "publish.github.public", hint: "publish.github.publicHint", icon: Globe },
};

/**
 * «Publicar», VS Code's way, on any connected host: the account (when there is more than one), the
 * owner, the name and the visibility that host offers. Creates the repository here so a taken name
 * is said in the dialog, where it can be changed, rather than after it closed; pushing is the
 * store's (`publishToHost`). An account whose owners could not be read is listed, disabled, with why.
 */
function PublishDialog({ targets, initialName }: { targets: PublishTarget[]; initialName: string }) {
  const answer = useGitDialogStore((s) => s.answerPublish);
  const t = useT();
  const usable = targets.filter((target) => !target.error && target.owners.length > 0);
  const keyOf = (target: PublishTarget) => `${target.provider}:${target.account}`;
  const [targetKey, setTargetKey] = useState(usable[0] ? keyOf(usable[0]) : "");
  const target = usable.find((candidate) => keyOf(candidate) === targetKey) ?? null;
  const [owner, setOwner] = useState(target?.owners[0]?.id ?? "");
  const [name, setName] = useState(repoName(initialName));
  const [visibility, setVisibility] = useState(target?.visibilities[0] ?? "private");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = repoName(name);
  const ready = !!target && clean.length > 0 && !creating;

  const pickTarget = (key: string) => {
    setTargetKey(key);
    const next = usable.find((candidate) => keyOf(candidate) === key);
    setOwner(next?.owners[0]?.id ?? "");
    setVisibility(next?.visibilities[0] ?? "private");
    setError(null);
  };

  const create = async () => {
    if (!ready || !target) return;
    setCreating(true);
    setError(null);
    try {
      const created = await publishCreate(target.provider, target.account, owner, clean, visibility);
      answer({ cloneUrl: created.cloneUrl, provider: target.provider, account: target.account });
    } catch (e) {
      setError(String(e));
      setCreating(false);
    }
  };

  const accountLabel = (candidate: PublishTarget) => `${PROVIDER_NAME[candidate.provider]} · ${candidate.account}`;
  const unusable = targets.filter((candidate) => !usable.includes(candidate));

  return (
    <DialogShell icon={<CloudUpload size={15} />} title={t("publish.title")} onDismiss={() => answer(null)}>
      <div className="space-y-2">
        {usable.length > 1 ? (
          <Select
            value={targetKey}
            onChange={pickTarget}
            options={usable.map((candidate) => ({ value: keyOf(candidate), label: accountLabel(candidate) }))}
            ariaLabel={t("publish.account")}
          />
        ) : (
          target && <p className="text-[12px] font-medium text-[var(--cf-text)]">{accountLabel(target)}</p>
        )}
        {target && (
          <div className="flex items-center gap-1.5">
            {target.owners.length > 1 ? (
              <div className="w-[170px] shrink-0">
                <Select value={owner} onChange={setOwner} options={target.owners.map((o) => ({ value: o.id, label: o.label }))} ariaLabel={t("publish.github.owner")} />
              </div>
            ) : (
              <span className="max-w-[170px] shrink-0 truncate text-[13px] text-[var(--cf-text-muted)]">{target.owners[0]?.label}</span>
            )}
            <span className="text-[var(--cf-text-muted)]">/</span>
            <input
              autoFocus
              value={name}
              spellCheck={false}
              placeholder={t("publish.github.name")}
              aria-label={t("publish.github.name")}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
              className={fieldClass({ className: "min-w-0 flex-1" })}
            />
          </div>
        )}
        {clean && clean !== name.trim() && <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("publish.github.willBe", { name: clean })}</p>}
        {target && target.visibilities.length > 0 ? (
          <Segmented<string>
            full
            layoutId="publish-visibility"
            ariaLabel={t("publish.github.visibility")}
            value={visibility}
            onChange={setVisibility}
            options={target.visibilities.map((value) => {
              const shown = VISIBILITY[value] ?? VISIBILITY.private;
              return { value, icon: shown.icon, label: t(shown.label), title: t(shown.hint) };
            })}
          />
        ) : (
          target && <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("publish.projectVisibility")}</p>
        )}
        {!target && <p className="text-[12px] text-[var(--cf-text-muted)]">{t("publish.noUsableAccount")}</p>}
        {unusable.map((candidate) => (
          <p key={keyOf(candidate)} className="text-[11.5px] text-[var(--cf-text-muted)] [overflow-wrap:anywhere]">
            {accountLabel(candidate)}: {candidate.error === "NO_OWNERS" ? t("publish.noOwners") : candidate.error}
          </p>
        ))}
        {error && <p className="text-[12px] text-[var(--cf-danger)] [overflow-wrap:anywhere]">{error}</p>}
      </div>
      <div className="mt-4 flex items-center justify-between gap-2">
        <button onClick={() => answer("manual")} className={buttonClass({ variant: "ghost", size: "sm" })} disabled={creating}>
          {t("publish.github.otherUrl")}
        </button>
        <div className="flex gap-2">
          <button onClick={() => answer(null)} className={buttonClass({ variant: "ghost" })} disabled={creating}>
            {t("common.cancel")}
          </button>
          <button onClick={() => void create()} disabled={!ready} className={buttonClass({ variant: "primary" })}>
            {creating ? t("publish.github.creating") : t("publish.github.confirm")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
