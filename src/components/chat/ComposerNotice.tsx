import { useEffect, useState } from "react";
import { CircleAlert, Download, WifiOff, X } from "lucide-react";
import { buttonClass } from "../common/Button";
import { useT } from "../../state/languageStore";
import { useAiRunStore } from "../../state/aiRunStore";
import { useCliUpdatesStore } from "../../state/cliUpdatesStore";
import { getSetting, providerLastError, type ProviderLastError } from "../../lib/tauri/commands";
import { providerDisplayLabel } from "../../lib/aiProviders";
import { composerNotice, firstBackup, noticeKey, type ComposerNotice as Notice } from "./noticeLogic";

/** Mirrors `backup_models::KEY`. */
const BACKUP_MODELS_KEY = "ai_backup_models";

/** Providers that run on this machine: no network, so being offline is not their problem. */
const LOCAL_PROVIDERS = new Set(["codeflow"]);

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/**
 * One slab above the composer for what stops or threatens the next message: no connection, a signed-out
 * CLI, a spent plan (with the first backup on offer), a CLI that is missing, a newer version. One at a
 * time, by what the person can act on first (`composerNotice`); × closes it for as long as it is the
 * same thing. Nothing when all is well — and no box for that.
 */
export function ComposerNotice({
  provider,
  onPickEngine,
}: {
  provider: string;
  onPickEngine?: (provider: string, model: string, account?: string) => void | Promise<void>;
}) {
  const t = useT();
  const online = useOnline();
  const [lastError, setLastError] = useState<ProviderLastError | null>(null);
  const [backups, setBackups] = useState<{ provider: string; model: string }[]>([]);
  const [closed, setClosed] = useState<string[]>([]);
  const card = useCliUpdatesStore((s) => s.cards[provider]);
  const install = useCliUpdatesStore((s) => s.install);
  // A turn ending is when a provider's last error can change.
  const running = useAiRunStore((s) => Object.values(s.active).filter(Boolean).length);

  useEffect(() => {
    let live = true;
    providerLastError(provider)
      .then((found) => live && setLastError(found))
      .catch(() => live && setLastError(null));
    return () => {
      live = false;
    };
  }, [provider, running]);

  useEffect(() => {
    let live = true;
    void getSetting(BACKUP_MODELS_KEY)
      .then((raw) => {
        if (!live) return;
        try {
          const parsed: unknown = raw ? JSON.parse(raw) : [];
          setBackups(Array.isArray(parsed) ? parsed.filter((e) => typeof e?.provider === "string").map((e) => ({ provider: e.provider, model: String(e.model ?? "") })) : []);
        } catch {
          setBackups([]);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const notice = composerNotice({
    provider,
    local: LOCAL_PROVIDERS.has(provider),
    online,
    lastError,
    backup: firstBackup(backups, provider),
    update: card && card.state === "available" ? { label: card.update.label, from: card.update.installed, to: card.update.latest } : null,
  });
  if (!notice) return null;
  const key = noticeKey(notice);
  if (closed.includes(key)) return null;

  return (
    <div
      role="alert"
      onKeyDown={(e) => {
        if (e.key === "Escape") setClosed((all) => [...all, key]);
      }}
      className="mb-2 flex items-start gap-2 rounded-xl border border-[color-mix(in_oklab,var(--cf-warning)_35%,var(--cf-border))] bg-[color-mix(in_oklab,var(--cf-warning)_8%,var(--cf-surface-raised))] px-3 py-2 text-[12px] leading-snug"
    >
      {notice.kind === "offline" ? (
        <WifiOff size={14} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
      ) : notice.kind === "update" ? (
        <Download size={14} className="mt-0.5 shrink-0 text-[var(--cf-accent)]" />
      ) : (
        <CircleAlert size={14} className="mt-0.5 shrink-0 text-[var(--cf-warning)]" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[var(--cf-text)]">{text(notice, t)}</p>
        {notice.kind === "quota" && notice.message && (
          <p className="mt-0.5 truncate text-[11px] text-[var(--cf-text-muted)]" title={notice.message}>
            {notice.message}
          </p>
        )}
      </div>
      {notice.kind === "quota" && notice.backup && onPickEngine && (
        <button
          type="button"
          onClick={() => void onPickEngine(notice.backup!.provider, notice.backup!.model)}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          {t("composerNotice.useBackup", { model: notice.backup.model })}
        </button>
      )}
      {notice.kind === "update" && (
        <button type="button" onClick={() => void install(notice.provider)} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {t("cliUpdates.install")}
        </button>
      )}
      <button
        type="button"
        onClick={() => setClosed((all) => [...all, key])}
        aria-label={t("cliUpdates.close")}
        className="-mr-1 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function text(notice: Notice, t: ReturnType<typeof useT>): string {
  switch (notice.kind) {
    case "offline":
      return t("composerNotice.offline");
    case "signIn":
      return t("composerNotice.signIn", { provider: providerDisplayLabel(notice.provider, t) });
    case "quota":
      return t("composerNotice.quota", { provider: providerDisplayLabel(notice.provider, t) });
    case "cliMissing":
      return t("composerNotice.cliMissing", { provider: providerDisplayLabel(notice.provider, t) });
    case "update":
      return t("composerNotice.update", { name: notice.label, from: notice.from, to: notice.to });
  }
}
