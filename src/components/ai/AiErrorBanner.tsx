import { ExternalLink } from "lucide-react";
import type { ClaudeErrorInfo } from "../../lib/claudeError";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";

/**
 * How an AI failure is shown. Three cases, because the advice differs: a usage limit lifts on its
 * own (tell them when), an empty balance needs them to top up (link them straight there), and
 * anything else is a real error worth showing verbatim.
 */
export function AiErrorBanner({ error, compact = false }: { error: ClaudeErrorInfo; compact?: boolean }) {
  const t = useT();
  const size = compact ? "text-[12px]" : "text-[13px]";
  const subSize = compact ? "text-[11px]" : "text-[12px]";

  const headline = !error.isQuotaExceeded
    ? error.message
    : error.kind === "billing"
      ? t("ai.billingMessage")
      : t("changes.quotaMessage");

  return (
    // Selectable: a provider error is the text most likely to be pasted into a search or an
    // issue, and it's the one place the app has no copy button of its own.
    <div className="select-text rounded-lg border border-[var(--cf-danger)]/30 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] p-4">
      <p className={`whitespace-pre-wrap break-words ${size} text-[var(--cf-danger)]`}>{headline}</p>

      {error.isQuotaExceeded && (
        <p className={`mt-1 ${subSize} text-[var(--cf-text-muted)]`}>
          {error.kind === "billing"
            ? t("ai.billingHint")
            : error.resetHint
              ? t("changes.quotaRetry", { hint: error.resetHint })
              : t("changes.quotaRetryLater")}
        </p>
      )}

      {error.actionUrl && (
        <button
          onClick={() => void openExternalUrl(error.actionUrl!)}
          className={`mt-2 flex items-center gap-1 ${subSize} font-medium text-[var(--cf-accent)] hover:underline`}
        >
          <ExternalLink size={11} />
          {/* Providers don't always link to billing — OpenAI's quota error points at its error-code
              docs — so the label follows the URL rather than promising a payments page. */}
          {/billing|payment|plans?\b/i.test(error.actionUrl) ? t("ai.openBilling") : t("ai.openLink")}
        </button>
      )}
    </div>
  );
}
