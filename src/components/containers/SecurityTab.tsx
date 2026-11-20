import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Loader2, RefreshCw, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { FilterChips, MutedNote, Td, Th, trClass } from "./ui";
import { containersImageScan, containersScanner } from "../../lib/tauri/containersCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { Finding, RuntimeId, ScanResult, Scanner, Severity } from "../../types/containers";

/**
 * «Seguridad»: an image's known vulnerabilities, from the scanner installed on this computer (Trivy
 * or Grype — see `containers::scan`). Never started on its own: the first scan downloads the
 * scanner's database and takes a while, so it waits for its button. A result is kept for the rest
 * of the session, per image, so going back to the tab shows it again without scanning anew.
 */

let scannerAsked: Promise<Scanner | null> | null = null;
/** Asked once per session — whether Trivy or Grype is installed does not change while the app runs. */
function detectScanner(): Promise<Scanner | null> {
  scannerAsked ??= containersScanner().catch(() => null);
  return scannerAsked;
}

const results = new Map<string, ScanResult>();
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unknown"];
type SevFilter = "all" | Severity;

const sevTone = (s: Severity): "bad" | "warn" | "idle" => (s === "critical" || s === "high" ? "bad" : s === "medium" ? "warn" : "idle");
const SEV_STYLE: Record<Severity, string> = {
  critical: "bg-[var(--cf-danger)] text-white",
  high: "bg-[color-mix(in_srgb,var(--cf-danger)_18%,transparent)] text-[var(--cf-danger)]",
  medium: "bg-[var(--cf-warning-soft)] text-[var(--cf-warning-text)]",
  low: "bg-[var(--cf-hover)] text-[var(--cf-text-muted)]",
  unknown: "bg-[var(--cf-hover)] text-[var(--cf-text-faint)]",
};

export function SecurityTab({ runtime, context, reference }: { runtime: RuntimeId; context: string | null; reference: string }) {
  const t = useT();
  const key = `${runtime}|${context ?? ""}|${reference}`;
  const [scanner, setScanner] = useState<Scanner | null | undefined>(undefined);
  const [result, setResult] = useState<ScanResult | null>(() => results.get(key) ?? null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<SevFilter>("all");
  const [fixable, setFixable] = useState(false);

  useEffect(() => {
    let alive = true;
    void detectScanner().then((found) => alive && setScanner(found));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => setResult(results.get(key) ?? null), [key]);

  const scan = () => {
    setScanning(true);
    setError(null);
    containersImageScan(runtime, context, reference)
      .then((found) => {
        results.set(key, found);
        setResult(found);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setScanning(false));
  };

  const findings = result?.findings ?? [];
  const counts = useMemo(() => {
    const by: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    for (const f of findings) by[f.severity] = (by[f.severity] ?? 0) + 1;
    return by;
  }, [findings]);
  const shown = useMemo(() => findings.filter((f) => (severity === "all" || f.severity === severity) && (!fixable || !!f.fixed)), [findings, severity, fixable]);
  const scannerName = scanner ? (scanner.id === "trivy" ? "Trivy" : "Grype") : "";

  if (scanner === undefined) return <MutedNote>{t("containers.m.loading")}</MutedNote>;
  if (scanner === null) {
    return (
      <div className="m-4 flex max-w-[640px] items-start gap-3 rounded-[10px] border border-[var(--cf-border)] p-4">
        <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-[var(--cf-text-muted)]" />
        <p className="text-[12.5px] leading-relaxed text-[var(--cf-text-muted)]">{t("containers.m.scan.none")}</p>
      </div>
    );
  }
  const errorText = error === "remote" ? t("containers.m.scan.remote") : error === "unsupported" ? t("containers.m.scan.unsupported") : error;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2.5">
        {result ? (
          <span className="text-[12.5px] text-[var(--cf-text)]">
            {findings.length === 0
              ? t("containers.m.scan.clean")
              : t("containers.m.scan.summary", { count: findings.length, packages: new Set(findings.map((f) => f.package)).size, fixable: findings.filter((f) => f.fixed).length })}
            <span className="ml-1.5 text-[11.5px] text-[var(--cf-text-faint)]">{t("containers.m.scan.with", { scanner: scannerName })}</span>
          </span>
        ) : (
          <span className="text-[12.5px] text-[var(--cf-text-muted)]">{scanning ? t("containers.m.scan.scanning", { scanner: scannerName }) : t("containers.m.scan.intro", { scanner: scannerName })}</span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant={result ? "secondary" : "primary"} onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 size={12} className="animate-spin" /> : result ? <RefreshCw size={12} /> : <ShieldCheck size={12} />}
          {result ? t("containers.m.scan.again") : t("containers.m.scan.run")}
        </Button>
      </div>
      {errorText && <p className="mx-4 mb-2 whitespace-pre-wrap rounded-md bg-[color-mix(in_srgb,var(--cf-danger)_10%,transparent)] px-3 py-2 text-[12px] text-[var(--cf-danger)]">{errorText}</p>}
      {result && findings.length > 0 && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-y border-[var(--cf-border)] px-4 py-1.5">
            <FilterChips
              label={t("containers.m.scan.col.severity")}
              value={severity}
              onChange={setSeverity}
              options={[
                { value: "all" as SevFilter, label: t("containers.m.scan.filter.all"), count: findings.length },
                ...SEVERITIES.filter((s) => counts[s] > 0).map((s) => ({ value: s as SevFilter, label: t(`containers.m.scan.sev.${s}` as TranslationKey), count: counts[s], tone: sevTone(s) })),
              ]}
            />
            <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
              <Checkbox checked={fixable} onChange={() => setFixable((v) => !v)} />
              {t("containers.m.scan.hasFix")}
            </label>
          </div>
          <FindingsTable findings={shown} />
        </>
      )}
    </div>
  );
}

function FindingsTable({ findings }: { findings: Finding[] }) {
  const t = useT();
  if (findings.length === 0) return <MutedNote>{t("containers.m.scan.noMatch")}</MutedNote>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full table-fixed border-separate border-spacing-0 text-[12px]" style={{ minWidth: 640 }}>
        <thead>
          <tr>
            <Th width={96}>{t("containers.m.scan.col.severity")}</Th>
            <Th width={170}>ID</Th>
            <Th>{t("containers.m.scan.col.package")}</Th>
            <Th width={150}>{t("containers.m.scan.col.installed")}</Th>
            <Th width={150}>{t("containers.m.scan.col.fixed")}</Th>
          </tr>
        </thead>
        <tbody>
          {findings.map((f) => (
            <tr key={`${f.id}|${f.package}|${f.installed}`} className={trClass(false)} title={f.title || undefined}>
              <Td>
                <span className={`inline-block rounded-full px-2 py-px text-[10.5px] font-semibold ${SEV_STYLE[f.severity]}`}>{t(`containers.m.scan.sev.${f.severity}` as TranslationKey)}</span>
              </Td>
              <Td>
                {f.url ? (
                  <button onClick={() => void openExternalUrl(f.url)} className="inline-flex max-w-full items-center gap-1 font-mono text-[11.5px] text-[var(--cf-accent)] hover:underline">
                    <span className="truncate">{f.id}</span>
                    <ExternalLink size={9} className="shrink-0" />
                  </button>
                ) : (
                  <span className="font-mono text-[11.5px]">{f.id}</span>
                )}
              </Td>
              <Td className="truncate font-medium text-[var(--cf-text)]">{f.package}</Td>
              <Td className="truncate font-mono text-[11.5px] text-[var(--cf-text-muted)]">{f.installed}</Td>
              <Td className={`truncate font-mono text-[11.5px] ${f.fixed ? "text-[var(--cf-success)]" : "text-[var(--cf-text-faint)]"}`}>{f.fixed || "—"}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
