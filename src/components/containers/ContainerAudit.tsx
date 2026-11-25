import { useEffect, useState } from "react";
import { FilePlus2, FileMinus2, FilePen, Loader2, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "../common/Button";
import { MutedNote } from "./ui";
import { containersContainerDiff, containersHardening } from "../../lib/tauri/containersCommands";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { DiffEntry, HardeningFinding, RuntimeId } from "../../types/containers";

/**
 * Two read-only views of a container that need no scanner:
 *
 * - «Endurecimiento» — what in its own configuration weakens its isolation (`containers::hardening`):
 *   privileged mode, the engine's socket mounted, the host's network or processes shared, dangerous
 *   capabilities, root, no limits. Each finding says what to change; the same rules are what a
 *   workspace policy enforces before an agent's container starts.
 * - «Cambios» — what it added, changed and deleted in its filesystem against its image (`diff`):
 *   what would be lost on a recreate, and what a «Crear imagen» would keep.
 */

const SEV_STYLE: Record<HardeningFinding["severity"], string> = {
  high: "bg-[color-mix(in_srgb,var(--cf-danger)_14%,transparent)] text-[var(--cf-danger)]",
  medium: "bg-[var(--cf-warning-soft)] text-[var(--cf-warning-text)]",
  low: "bg-[var(--cf-hover)] text-[var(--cf-text-muted)]",
};

export function HardeningTab({ runtime, context, id }: { runtime: RuntimeId; context: string | null; id: string }) {
  const t = useT();
  const [findings, setFindings] = useState<HardeningFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setError(null);
    containersHardening(runtime, context, id)
      .then((found) => alive && setFindings(found))
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [runtime, context, id, tick]);

  if (error) return <MutedNote>{error}</MutedNote>;
  if (!findings) return <MutedNote>{t("containers.m.loading")}</MutedNote>;
  const count = (s: HardeningFinding["severity"]) => findings.filter((f) => f.severity === s).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5 text-[12.5px]">
        {findings.length === 0 ? (
          <span className="flex items-center gap-1.5 text-[var(--cf-success)]">
            <ShieldCheck size={14} />
            {t("containers.m.harden.clean")}
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-[var(--cf-text)]">
            <ShieldAlert size={14} className={count("high") ? "text-[var(--cf-danger)]" : "text-[var(--cf-warning-text)]"} />
            {t("containers.m.harden.summary", { high: count("high"), medium: count("medium"), low: count("low") })}
          </span>
        )}
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.harden.source")}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setTick((n) => n + 1)}>
          <RefreshCw size={12} />
          {t("containers.m.harden.again")}
        </Button>
      </div>
      <div className="flex flex-col gap-0 border-t border-[var(--cf-border)]">
        {findings.map((f, i) => (
          <div key={`${f.rule}|${f.detail}|${i}`} className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 border-b border-[var(--cf-border)] px-4 py-2.5">
            <span className={`h-fit rounded-md px-1.5 py-px text-center text-[10.5px] font-semibold uppercase tracking-wide ${SEV_STYLE[f.severity]}`}>
              {t(`containers.m.harden.sev.${f.severity}` as TranslationKey)}
            </span>
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-[var(--cf-text)]">{t(`containers.m.harden.rule.${f.rule}` as TranslationKey)}</div>
              {f.detail && <div className="truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]">{f.detail}</div>}
              <div className="text-[11.5px] leading-relaxed text-[var(--cf-text-muted)]">{t(`containers.m.harden.fix.${f.rule}` as TranslationKey)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const KIND_ICON = { added: FilePlus2, changed: FilePen, deleted: FileMinus2 } as const;
const KIND_TONE = { added: "text-[var(--cf-success)]", changed: "text-[var(--cf-warning-text)]", deleted: "text-[var(--cf-danger)]" } as const;

export function ChangesTab({ runtime, context, id }: { runtime: RuntimeId; context: string | null; id: string }) {
  const t = useT();
  const [entries, setEntries] = useState<DiffEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    containersContainerDiff(runtime, context, id)
      .then((found) => alive && setEntries(found))
      .catch((e: unknown) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [runtime, context, id, tick]);

  if (error) return <MutedNote>{error}</MutedNote>;
  if (!entries) return <MutedNote>{t("containers.m.loading")}</MutedNote>;
  const count = (k: DiffEntry["kind"]) => entries.filter((e) => e.kind === k).length;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5 text-[12.5px]">
        <span className="text-[var(--cf-text)]">
          {entries.length === 0 ? t("containers.m.diff.none") : t("containers.m.diff.summary", { added: count("added"), changed: count("changed"), deleted: count("deleted") })}
        </span>
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.diff.hint")}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setTick((n) => n + 1)} disabled={loading}>
          {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
          {t("containers.m.harden.again")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t border-[var(--cf-border)] px-4 py-2 font-mono text-[11.5px]">
        {entries.map((e) => {
          const Icon = KIND_ICON[e.kind];
          return (
            <div key={`${e.kind}|${e.path}`} className="flex items-center gap-2 py-0.5" title={t(`containers.m.diff.kind.${e.kind}` as TranslationKey)}>
              <Icon size={12} className={`shrink-0 ${KIND_TONE[e.kind]}`} />
              <span className="truncate text-[var(--cf-text)]">{e.path}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
