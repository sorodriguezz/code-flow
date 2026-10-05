import { useEffect, useState } from "react";
import { Copy, Hourglass, UserCheck, Webhook } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { flowsDecideWait, flowsWebhookBase, resumeUrlOf, type FlowWait } from "../../lib/tauri/flowsCommands";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { formatWhen } from "./runFormat";

/**
 * A run parked at a node, and what can be done about it from here: an approval is answered, a wait
 * for a call shows the URL to call, a timed wait says until when. The phone shows the same waits
 * (`FlowsScreen` in the mobile client) — whichever answers first decides, and the other's buttons
 * get `already-decided`, which is not an error worth a toast.
 */
export function WaitCard({ wait, showFlow = true }: { wait: FlowWait; showFlow?: boolean }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (wait.kind !== "webhook") return;
    let alive = true;
    void flowsWebhookBase().then((base) => alive && setUrl(resumeUrlOf(base, wait.runId)));
    return () => {
      alive = false;
    };
  }, [wait.kind, wait.runId]);

  const decide = async (decision: "approved" | "rejected") => {
    setBusy(true);
    try {
      await flowsDecideWait(wait.id, decision);
    } catch (error) {
      if (String(error) !== "already-decided") pushErrorToast(String(error));
    } finally {
      setBusy(false);
    }
  };

  const Icon = wait.kind === "approval" ? UserCheck : wait.kind === "webhook" ? Webhook : Hourglass;
  const until = wait.expiresAt ? new Date(wait.expiresAt).toLocaleString(language, { dateStyle: "short", timeStyle: "short" }) : null;
  const headline =
    wait.kind === "approval"
      ? wait.message || t("flows.wait.approval")
      : wait.kind === "webhook"
        ? t("flows.wait.call")
        : t("flows.wait.time", { when: until ?? "" });
  const meta = [showFlow ? wait.flowName : null, wait.nodeName, formatWhen(wait.createdAt, language), wait.kind !== "time" && until ? t("flows.wait.until", { when: until }) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] px-3 py-2.5">
      <Icon size={15} className="mt-[2px] shrink-0 text-[var(--cf-warning)]" />
      <div className="min-w-0 flex-1">
        <div className="whitespace-pre-wrap break-words text-[12.5px] font-medium text-[var(--cf-text)]">{headline}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-[var(--cf-text-muted)]">{meta}</div>
        {url && (
          <div className="mt-1.5 flex min-w-0 items-center gap-1">
            <code className="min-w-0 truncate rounded bg-[var(--cf-sunken)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--cf-text-muted)]">{url}</code>
            <button
              type="button"
              className={iconButtonClass({ size: "xs" })}
              title={t("flows.wait.copyUrl")}
              aria-label={t("flows.wait.copyUrl")}
              onClick={() => void navigator.clipboard.writeText(url)}
            >
              <Copy size={11} />
            </button>
          </div>
        )}
      </div>
      {wait.kind === "approval" && (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="sm" variant="danger-ghost" disabled={busy} onClick={() => void decide("rejected")}>
            {t("flows.wait.reject")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void decide("approved")}>
            {t("flows.wait.approve")}
          </Button>
        </div>
      )}
    </div>
  );
}
