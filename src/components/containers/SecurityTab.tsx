import { useCallback, useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ChevronDown, ExternalLink, FileDown, GitCompare, History, Loader2, RefreshCw, ShieldCheck, ShieldQuestion, Trash2 } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { FilterChips, MutedNote, Td, Th, trClass } from "./ui";
import {
  containersImageSbom,
  containersImageScan,
  containersSbomTool,
  containersScanCompare,
  containersScanForget,
  containersScanGet,
  containersScanHistory,
  containersScanner,
} from "../../lib/tauri/containersCommands";
import { confirmAction } from "../../state/confirmStore";
import { useLanguageStore } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { Finding, RuntimeId, SbomFormat, ScanComparison, ScanResult, ScanSummary, Scanner, Severity } from "../../types/containers";

/**
 * «Seguridad»: an image's known vulnerabilities, from the scanner installed on this computer (Trivy
 * or Grype — see `containers::scan`). Never started on its own: the first scan downloads the
 * scanner's database and takes a while, so it waits for its button.
 *
 * Every scan is kept (the last 20 of each image, on this machine): the tab opens on the latest one,
 * and «Historial» lists them with their counts — two picked side by side say what was fixed and what
 * appeared between them, which is what a rebuild or a new base image is judged by. «SBOM» writes the
 * image's inventory of packages with Trivy or Syft.
 */

let scannerAsked: Promise<Scanner | null> | null = null;
/** Asked once per session — whether Trivy or Grype is installed does not change while the app runs. */
function detectScanner(): Promise<Scanner | null> {
  scannerAsked ??= containersScanner().catch(() => null);
  return scannerAsked;
}
let sbomAsked: Promise<Scanner | null> | null = null;
function detectSbomTool(): Promise<Scanner | null> {
  sbomAsked ??= containersSbomTool().catch(() => null);
  return sbomAsked;
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
  const [history, setHistory] = useState<ScanSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [sbomTool, setSbomTool] = useState<Scanner | null | undefined>(undefined);
  const [sbomBusy, setSbomBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void detectScanner().then((found) => alive && setScanner(found));
    void detectSbomTool().then((found) => alive && setSbomTool(found));
    return () => {
      alive = false;
    };
  }, []);

  const loadHistory = useCallback(async () => {
    const kept = await containersScanHistory(reference).catch(() => [] as ScanSummary[]);
    setHistory(kept);
    return kept;
  }, [reference]);
  // The session's result when there is one, else the latest kept scan of this image.
  useEffect(() => {
    let alive = true;
    const session = results.get(key) ?? null;
    setResult(session);
    void loadHistory().then(async (kept) => {
      if (!alive || session || !kept[0]) return;
      const latest = await containersScanGet(kept[0].id).catch(() => null);
      if (alive && latest) setResult(latest);
    });
    return () => {
      alive = false;
    };
  }, [key, loadHistory]);

  const scan = () => {
    setScanning(true);
    setError(null);
    containersImageScan(runtime, context, reference)
      .then((found) => {
        results.set(key, found);
        setResult(found);
        void loadHistory();
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setScanning(false));
  };

  const exportSbom = async (format: SbomFormat) => {
    const base = reference.replace(/[^\w.-]+/g, "_");
    const path = await saveDialog({ defaultPath: `${base}.${format === "spdx" ? "spdx" : "cdx"}.json`, filters: [{ name: "JSON", extensions: ["json"] }] }).catch(() => null);
    if (!path) return;
    setSbomBusy(true);
    try {
      const tool = await containersImageSbom(runtime, context, reference, format, path);
      pushSuccessToast(t("containers.m.scan.sbomDone", { tool: tool === "syft" ? "Syft" : "Trivy" }));
    } catch (e) {
      const text = String(e);
      pushErrorToast(text === "remote" ? t("containers.m.scan.remote") : text === "unsupported" ? t("containers.m.scan.unsupported") : text);
    } finally {
      setSbomBusy(false);
    }
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
        {history.length > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory}>
            <History size={12} />
            {t("containers.m.scan.history", { count: history.length })}
            <ChevronDown size={11} className={showHistory ? "" : "-rotate-90"} />
          </Button>
        )}
        <SbomButton tool={sbomTool} busy={sbomBusy} onPick={(format) => void exportSbom(format)} />
        <Button size="sm" variant={result ? "secondary" : "primary"} onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 size={12} className="animate-spin" /> : result ? <RefreshCw size={12} /> : <ShieldCheck size={12} />}
          {result ? t("containers.m.scan.again") : t("containers.m.scan.run")}
        </Button>
      </div>
      {showHistory && history.length > 0 && (
        <ScanHistory
          history={history}
          current={result?.id ?? ""}
          onOpen={(id) => void containersScanGet(id).then((kept) => kept && setResult(kept))}
          onForget={async () => {
            if (!(await confirmAction(t("containers.m.scan.forgetConfirm", { image: reference }), true))) return;
            await containersScanForget(reference).catch(() => 0);
            results.delete(key);
            setShowHistory(false);
            void loadHistory();
          }}
        />
      )}
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

/** «SBOM ▾»: the format to write, or why it cannot be written here. */
function SbomButton({ tool, busy, onPick }: { tool: Scanner | null | undefined; busy: boolean; onPick: (format: SbomFormat) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (tool === undefined) return null;
  if (tool === null) {
    return (
      <span title={t("containers.m.scan.sbomNone")}>
        <Button size="sm" variant="ghost" disabled>
          <FileDown size={12} />
          SBOM
        </Button>
      </span>
    );
  }
  return (
    <div className="relative">
      <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)} disabled={busy} title={t("containers.m.scan.sbomHint", { tool: tool.id === "syft" ? "Syft" : "Trivy" })}>
        {busy ? <Loader2 size={12} className="animate-spin" /> : <FileDown size={12} />}
        SBOM
        <ChevronDown size={11} />
      </Button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-[9px] border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-1 shadow-lg" onMouseLeave={() => setOpen(false)}>
          {(["cyclonedx", "spdx"] as SbomFormat[]).map((format) => (
            <button
              key={format}
              onClick={() => {
                setOpen(false);
                onPick(format);
              }}
              className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12px] text-[var(--cf-text)] hover:bg-[var(--cf-hover)]"
            >
              {format === "cyclonedx" ? "CycloneDX (JSON)" : "SPDX (JSON)"}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The kept scans of the image, and what changed between the two picked. */
function ScanHistory({ history, current, onOpen, onForget }: { history: ScanSummary[]; current: string; onOpen: (id: string) => void; onForget: () => void }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  // Newest against the one before it, to start: what the last scan changed.
  const [later, setLater] = useState(history[0]?.id ?? "");
  const [earlier, setEarlier] = useState(history[1]?.id ?? "");
  const [diff, setDiff] = useState<ScanComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setLater((v) => (history.some((h) => h.id === v) ? v : (history[0]?.id ?? "")));
    setEarlier((v) => (history.some((h) => h.id === v) ? v : (history[1]?.id ?? "")));
  }, [history]);
  useEffect(() => {
    setDiff(null);
    setError(null);
    if (!earlier || !later || earlier === later) return;
    let alive = true;
    containersScanCompare(earlier, later)
      .then((found) => alive && setDiff(found))
      .catch((e: unknown) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [earlier, later]);
  const when = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(language === "es" ? "es" : "en", { dateStyle: "medium", timeStyle: "short" });
  };
  const byId = new Map(history.map((h) => [h.id, h]));
  const rebuilt = earlier && later && byId.get(earlier)?.imageId && byId.get(earlier)?.imageId !== byId.get(later)?.imageId;
  const count = (n: number, tone: string) => <span className={`inline-block min-w-[22px] text-right tabular-nums ${n > 0 ? tone : "text-[var(--cf-text-faint)]"}`}>{n}</span>;
  return (
    <div className="mx-4 mb-3 flex shrink-0 flex-col gap-3 rounded-[10px] border border-[var(--cf-border)] p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-[var(--cf-text)]">{t("containers.m.scan.historyTitle")}</span>
        <span className="text-[11px] text-[var(--cf-text-faint)]">{t("containers.m.scan.historyHint")}</span>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={onForget}>
          <Trash2 size={12} />
          {t("containers.m.scan.forget")}
        </Button>
      </div>
      <div className="max-h-[220px] overflow-auto">
        <table className="w-full border-separate border-spacing-0 text-[12px]" style={{ minWidth: 560 }}>
          <thead>
            <tr>
              <Th>{t("containers.m.scan.col.when")}</Th>
              <Th width={130}>{t("containers.m.scan.col.imageId")}</Th>
              <Th width={56}>{t("containers.m.scan.sev.critical")}</Th>
              <Th width={56}>{t("containers.m.scan.sev.high")}</Th>
              <Th width={56}>{t("containers.m.scan.sev.medium")}</Th>
              <Th width={56}>{t("containers.m.scan.sev.low")}</Th>
              <Th width={76}>{t("containers.m.scan.col.before")}</Th>
              <Th width={76}>{t("containers.m.scan.col.after")}</Th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id} className={trClass(h.id === current)} onClick={() => onOpen(h.id)} style={{ cursor: "pointer" }} title={t("containers.m.scan.open")}>
                <Td className="text-[var(--cf-text)]">{when(h.scannedAt)}</Td>
                <Td className="truncate font-mono text-[11px] text-[var(--cf-text-muted)]">{h.imageId ? h.imageId.replace("sha256:", "").slice(0, 12) : "—"}</Td>
                <Td>{count(h.critical, "font-semibold text-[var(--cf-danger)]")}</Td>
                <Td>{count(h.high, "text-[var(--cf-danger)]")}</Td>
                <Td>{count(h.medium, "text-[var(--cf-warning-text)]")}</Td>
                <Td>{count(h.low, "text-[var(--cf-text-muted)]")}</Td>
                <Td>
                  <input type="radio" name="scan-earlier" checked={earlier === h.id} onChange={() => setEarlier(h.id)} onClick={(e) => e.stopPropagation()} aria-label={t("containers.m.scan.col.before")} />
                </Td>
                <Td>
                  <input type="radio" name="scan-later" checked={later === h.id} onChange={() => setLater(h.id)} onClick={(e) => e.stopPropagation()} aria-label={t("containers.m.scan.col.after")} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {history.length > 1 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
            <GitCompare size={12} />
            {earlier === later ? t("containers.m.scan.pickTwo") : diff ? t("containers.m.scan.compareSummary", { fixed: diff.fixed.length, added: diff.added.length, kept: diff.kept }) : t("containers.m.loading")}
            {rebuilt && <span className="text-[11px] text-[var(--cf-text-faint)]">· {t("containers.m.scan.rebuilt")}</span>}
          </div>
          {error && <p className="text-[12px] text-[var(--cf-danger)]">{error}</p>}
          {diff && (diff.fixed.length > 0 || diff.added.length > 0) && (
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <CompareList title={t("containers.m.scan.fixedSince", { count: diff.fixed.length })} tone="text-[var(--cf-success)]" findings={diff.fixed} />
              <CompareList title={t("containers.m.scan.addedSince", { count: diff.added.length })} tone="text-[var(--cf-danger)]" findings={diff.added} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CompareList({ title, tone, findings }: { title: string; tone: string; findings: Finding[] }) {
  const t = useT();
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[9px] border border-[var(--cf-border)] p-2.5">
      <span className={`text-[12px] font-medium ${tone}`}>{title}</span>
      <div className="flex max-h-[160px] flex-col gap-0.5 overflow-auto">
        {findings.map((f) => (
          <div key={`${f.id}|${f.package}`} className="flex items-center justify-between gap-2 font-mono text-[11px]" title={f.title || undefined}>
            <span className="truncate text-[var(--cf-text)]">
              {f.id} <span className="text-[var(--cf-text-muted)]">{f.package}</span>
            </span>
            <span className={`shrink-0 rounded-full px-1.5 py-px font-sans text-[10px] font-semibold ${SEV_STYLE[f.severity]}`}>{t(`containers.m.scan.sev.${f.severity}` as TranslationKey)}</span>
          </div>
        ))}
        {findings.length === 0 && <span className="text-[11.5px] text-[var(--cf-text-faint)]">—</span>}
      </div>
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
