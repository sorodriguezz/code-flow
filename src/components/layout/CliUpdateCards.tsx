import { useEffect, useState } from "react";
import { ChevronDown, CircleAlert, CircleCheck, Copy, Loader2, X } from "lucide-react";
import { NoticeStack } from "../common/NoticeDock";
import { ProviderGlyph } from "../ai/ProviderGlyph";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useToastStore } from "../../state/toastStore";
import { listenForCliUpdateProgress, useCliUpdatesStore, type CliUpdateCard } from "../../state/cliUpdatesStore";
import type { TranslationKey } from "../../lib/i18n/translations";

/** Always the top-right corner: this is a notice about the app itself, not one a person routes. */
const PLACEMENT = { edge: "top", align: "right" } as const;

/** The sentence for a failure, by the kind the backend classified it as. */
const FAILURE_TEXT: Record<string, TranslationKey> = {
  permission: "cliUpdates.failure.permission",
  network: "cliUpdates.failure.network",
  timeout: "cliUpdates.failure.timeout",
  storage: "cliUpdates.failure.storage",
  conflict: "cliUpdates.failure.conflict",
};

/**
 * One card per AI CLI that has a newer version, top right: Install, Skip this version, and ×.
 *
 * Closing a card never stops an update that is already running (stopping one half-way leaves a CLI
 * half-installed); it only hides the card until the next launch.
 */
export function CliUpdateCards() {
  const cards = useCliUpdatesStore((s) => s.cards);
  const installAll = useCliUpdatesStore((s) => s.installAll);
  const t = useT();

  useEffect(() => listenForCliUpdateProgress(), []);

  const list = Object.values(cards);
  if (list.length === 0) return null;
  const waiting = list.filter((card) => card.state === "available");

  return (
    <NoticeStack kind="popups" placement={PLACEMENT}>
      {waiting.length > 1 && (
        <button type="button" onClick={() => void installAll()} className={`${buttonClass({ variant: "secondary", size: "sm" })} pointer-events-auto`}>
          {t("cliUpdates.installAll", { count: waiting.length })}
        </button>
      )}
      {/* The dock hangs from the top and runs its column the other way round (newest nearest the edge,
          which is right for notices). These are a list, so the first one is drawn first. */}
      {[...list].reverse().map((card) => (
        <Card key={card.update.provider} card={card} />
      ))}
    </NoticeStack>
  );
}

function versionLabel(version: string): string {
  return version.startsWith("v") ? version : `v${version}`;
}

function Card({ card }: { card: CliUpdateCard }) {
  const t = useT();
  const { update, state, result } = card;
  const install = useCliUpdatesStore((s) => s.install);
  const close = useCliUpdatesStore((s) => s.close);
  const skip = useCliUpdatesStore((s) => s.skip);
  const pushToast = useToastStore((s) => s.pushToast);
  const [details, setDetails] = useState(false);
  const busy = state === "updating" || state === "waiting";

  const title =
    state === "failed"
      ? t("cliUpdates.failed", { name: update.label })
      : state === "done"
        ? t("cliUpdates.done", { name: update.label })
        : state === "updating" || state === "waiting"
          ? t("cliUpdates.updating", { name: update.label })
          : t("cliUpdates.available", { name: update.label });

  const copy = async () => {
    const text = [result?.reference, result?.details].filter(Boolean).join("\n");
    await navigator.clipboard.writeText(text).catch(() => {});
    pushToast(t("cliUpdates.copied"), "success");
  };

  return (
    <div
      role="status"
      className="pointer-events-auto w-[340px] rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-3 shadow-[var(--cf-toast-shadow)]"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0">
          {state === "failed" ? (
            <CircleAlert size={16} className="text-[var(--cf-danger)]" />
          ) : state === "done" ? (
            <CircleCheck size={16} className="text-[var(--cf-success)]" />
          ) : (
            <ProviderGlyph providerId={update.provider} size={16} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium text-[var(--cf-text)]">{title}</p>
          <p className="mt-0.5 text-[12px] text-[var(--cf-text-muted)]">
            {state === "done" && result?.versionAfter
              ? versionLabel(result.versionAfter)
              : `${versionLabel(update.installed)} → ${versionLabel(update.latest)}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => close(update.provider)}
          aria-label={t("cliUpdates.close")}
          title={t("cliUpdates.close")}
          className="-mr-1 -mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"
        >
          <X size={13} />
        </button>
      </div>

      {state === "available" && (
        <div className="mt-2.5 flex items-center gap-2">
          <button type="button" onClick={() => void install(update.provider)} className={buttonClass({ variant: "primary", size: "sm" })}>
            {t("cliUpdates.install")}
          </button>
          <button type="button" onClick={() => skip(update.provider)} className={buttonClass({ variant: "ghost", size: "sm" })}>
            {t("cliUpdates.skip")}
          </button>
        </div>
      )}

      {busy && (
        <div className="mt-2.5">
          {/* No percentage: none of these commands reports one, and a number made up to look like
              progress is worse than an honest bar that says "working". */}
          <div className="h-1 overflow-hidden rounded-full bg-[var(--cf-border)]">
            <div className="cf-indeterminate h-full w-1/3 rounded-full bg-[var(--cf-accent)]" />
          </div>
          <p className="mt-1.5 flex items-center gap-1.5 truncate text-[11px] text-[var(--cf-text-faint)]">
            <Loader2 size={11} className="shrink-0 animate-spin" />
            <span className="truncate">{state === "waiting" ? t("cliUpdates.waiting") : card.lastLine || t("cliUpdates.working")}</span>
          </p>
        </div>
      )}

      {state === "failed" && result && (
        <div className="mt-2 space-y-2">
          <p className="text-[12px] leading-snug text-[var(--cf-text-muted)]">
            {result.outcome === "not_applied"
              ? t("cliUpdates.failure.notApplied", { version: result.versionAfter ? versionLabel(result.versionAfter) : "?" })
              : result.outcome === "broken"
                ? t("cliUpdates.failure.broken")
                : t(FAILURE_TEXT[result.errorKind ?? ""] ?? "cliUpdates.failure.unknown")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void install(update.provider)} className={buttonClass({ variant: "secondary", size: "sm" })}>
              {t("cliUpdates.retry")}
            </button>
            {result.reference && <span className={chipClass("neutral", "font-mono")}>{result.reference}</span>}
            <button
              type="button"
              onClick={() => setDetails((open) => !open)}
              className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] underline-offset-2 hover:underline"
            >
              <ChevronDown size={11} className={details ? "" : "-rotate-90"} />
              {details ? t("cliUpdates.hideDetails") : t("cliUpdates.showDetails")}
            </button>
          </div>
          {details && (
            <div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--cf-surface)] p-2 font-mono text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                {result.details || "—"}
              </pre>
              <button type="button" onClick={() => void copy()} className={buttonClass({ variant: "ghost", size: "sm", className: "mt-1" })}>
                <Copy size={12} />
                {t("cliUpdates.copy")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
