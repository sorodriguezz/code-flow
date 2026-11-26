import { useCallback, useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { t, type MobileKey } from "../i18n";
import { rpc } from "../transport";
import { PushBar } from "../ui/AppBar";
import { Screen } from "../ui/Screen";
import { Card, Divider, Section } from "../ui/List";
import { Badge, EmptyState, ErrorState, SkeletonList } from "../ui/Feedback";
import type { ProviderQuota, QuotaLimit, QuotaReport } from "../../types/domain";

/**
 * The plans' limits, as each provider publishes them.
 *
 * # Why a phone wants this
 *
 * A run that stops overnight has usually stopped on a limit, and the question from a phone the next
 * morning is not "what went wrong" but "when does it come back". The desktop has had the answer in
 * its status bar all along; `ai_quota_status` has been in the allowlist all along too, and nothing
 * on this client ever called it.
 *
 * Read from what the desktop already knows: the dispatcher forces a `poll`, so opening this screen
 * never makes the desk run a provider's CLI to refresh a number (see the arm). That is why a row can
 * be a few minutes old, and why each one says how old.
 *
 * The thresholds are the desktop's — amber from 80 %, red from 95 % — so a colour means the same
 * thing in the pocket as it does on the desk.
 */

function tone(percent: number): "danger" | "warning" | "accent" {
  return percent >= 95 ? "danger" : percent >= 80 ? "warning" : "accent";
}

const BAR: Record<ReturnType<typeof tone>, string> = {
  danger: "bg-[var(--cf-danger)]",
  warning: "bg-[var(--cf-warning)]",
  accent: "bg-[var(--cf-accent)]",
};

const KIND: Record<string, MobileKey> = {
  session: "usage.session",
  weekly: "usage.weekly",
  model: "usage.model",
};

/** "en 2 h 10 min", "en 3 d", or nothing when the provider did not say when the window rolls over. */
function resetsIn(iso: string): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t("usage.resetsIn", { time: `${minutes} min` });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return t("usage.resetsIn", { time: `${hours} h ${minutes % 60} min` });
  return t("usage.resetsIn", { time: `${Math.round(hours / 24)} d` });
}

function LimitRow({ limit }: { limit: QuotaLimit }) {
  const percent = Math.max(0, Math.min(100, limit.used_percent));
  const level = tone(percent);
  const name = [t(KIND[limit.kind] ?? "usage.limit"), limit.scope].filter(Boolean).join(" · ");
  return (
    <div className="px-3 py-2.5">
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-md">{name}</span>
        <span
          className={`shrink-0 text-md font-semibold tabular-nums ${
            level === "danger" ? "text-[var(--cf-danger-text)]" : level === "warning" ? "text-[var(--cf-warning-text)]" : ""
          }`}
        >
          {Math.round(percent)}%
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--cf-sunken)]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-label={name}
      >
        <div className={`h-full rounded-full ${BAR[level]}`} style={{ width: `${Math.max(2, percent)}%` }} />
      </div>
      {resetsIn(limit.resets_at) && <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{resetsIn(limit.resets_at)}</p>}
    </div>
  );
}

/** A provider's display name: its id with the first letter raised, which is how every one of them
 *  spells itself (`claude` → Claude). The desk's catalogue of names is not on this client. */
function providerName(id: string): string {
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : id;
}

function ProviderCard({ quota, routed, account }: { quota: ProviderQuota; routed: boolean; account: number | null }) {
  const title = [providerName(quota.provider), account ? t("usage.account", { n: account }) : "", quota.plan].filter(Boolean).join(" · ");
  return (
    <Section
      title={title}
      action={routed ? <Badge tone="accent">{t("usage.inUse")}</Badge> : undefined}
    >
      <Card>
        {quota.error && quota.limits.length === 0 ? (
          <p className="px-3 py-2.5 text-base text-[var(--cf-text-muted)]">
            {quota.error === "signed_out" ? t("usage.signedOut") : t("usage.unavailable")}
          </p>
        ) : quota.limits.length === 0 ? (
          <p className="px-3 py-2.5 text-base text-[var(--cf-text-muted)]">{t("usage.noLimits")}</p>
        ) : (
          quota.limits.map((limit, index) => (
            <div key={`${limit.kind}:${limit.scope}`}>
              {index > 0 && <Divider />}
              <LimitRow limit={limit} />
            </div>
          ))
        )}
      </Card>
    </Section>
  );
}

export function UsageScreen() {
  const [report, setReport] = useState<QuotaReport | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await rpc<QuotaReport>("ai_quota_status"));
      setState("ready");
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setState((current) => (current === "ready" ? "ready" : "error"));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const bar = <PushBar title={t("usage.title")} />;

  if (state === "loading") {
    return (
      <Screen bar={bar}>
        <Section>
          <SkeletonList rows={4} />
        </Section>
      </Screen>
    );
  }
  if (state === "error" || !report) {
    return (
      <Screen bar={bar}>
        <ErrorState title={t("usage.failed")} detail={failure} onRetry={() => void load()} />
      </Screen>
    );
  }
  if (report.providers.length === 0) {
    return (
      <Screen bar={bar} onRefresh={() => load()}>
        <EmptyState icon={<Gauge size={26} aria-hidden />} title={t("usage.none")} hint={t("usage.noneHint")} />
      </Screen>
    );
  }

  // The ones work is routed to first, then by how close each is to its tightest limit. Several
  // accounts of one provider are numbered in the order the desktop sent them, because an account's
  // name is the desk's to know and its position is all a phone can honestly say.
  const seen = new Map<string, number>();
  const several = new Set(
    report.providers.map((p) => p.provider).filter((id, _, all) => all.filter((other) => other === id).length > 1),
  );
  const rows = report.providers.map((quota) => {
    const n = (seen.get(quota.provider) ?? 0) + 1;
    seen.set(quota.provider, n);
    return {
      quota,
      account: several.has(quota.provider) ? n : null,
      routed: report.routed.includes(quota.provider),
      worst: quota.limits.reduce((max, limit) => Math.max(max, limit.used_percent), 0),
    };
  });
  rows.sort((a, b) => Number(b.routed) - Number(a.routed) || b.worst - a.worst);

  return (
    <Screen bar={bar} onRefresh={() => load()}>
      {rows.map((row) => (
        <ProviderCard
          key={`${row.quota.provider}:${row.quota.account_id ?? "system"}`}
          quota={row.quota}
          routed={row.routed}
          account={row.account}
        />
      ))}
      <p className="mt-4 px-1 text-xs text-[var(--cf-text-muted)]">{t("usage.footnote")}</p>
    </Screen>
  );
}
