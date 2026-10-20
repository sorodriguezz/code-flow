import { useCallback, useEffect, useState } from "react";
import { Check, Download, Trash2, X } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { buttonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { chipClass } from "../common/recipes";
import { Note } from "../api/settingsChrome";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useConfirmStore } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import {
  aiExperienceDelete,
  aiExperienceSetQuality,
  aiExperiencesClear,
  aiExperiencesCounts,
  aiExperiencesExport,
  aiExperiencesList,
  aiSetTrainingAllowed,
  aiTrainingAllowed,
  type Experience,
  type ExperienceFilter,
  type ExperienceQuality,
} from "../../lib/tauri/experiencesCommands";
import type { TranslationKey } from "../../lib/i18n/translations";
import { AiLearningTraining } from "./AiLearningTraining";

const SIGNAL_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = {
  accepted: "ok",
  passed: "ok",
  corrected: "neutral",
  rejected: "warn",
  reverted: "warn",
  failed: "bad",
  error: "bad",
  cancelled: "neutral",
};

const SOURCE_KEY: Record<string, TranslationKey> = {
  turn_review: "learning.sourceTurnReview",
  apply_code: "learning.sourceApplyCode",
  checkpoint_restore: "learning.sourceRestore",
  hybrid_check: "learning.sourceHybridCheck",
  fix_verify: "learning.sourceFixVerify",
  chat: "learning.sourceChat",
  memory: "learning.sourceMemory",
  manual: "learning.sourceManual",
};

const SIGNAL_KEY: Record<string, TranslationKey> = {
  accepted: "learning.signalAccepted",
  rejected: "learning.signalRejected",
  reverted: "learning.signalReverted",
  passed: "learning.signalPassed",
  failed: "learning.signalFailed",
  error: "learning.signalError",
  cancelled: "learning.signalCancelled",
  corrected: "learning.signalCorrected",
};

/** One line of evidence: the file, the command, or the start of what was kept. */
function evidence(experience: Experience): string {
  const detail = experience.detail ?? {};
  const pick = (key: string) => (typeof detail[key] === "string" ? (detail[key] as string) : null);
  const paths = Array.isArray(detail.paths) ? (detail.paths as unknown[]).filter((p) => typeof p === "string").join(", ") : null;
  return pick("command") ?? pick("path") ?? paths ?? pick("error") ?? (experience.prompt ?? experience.response ?? "").slice(0, 140);
}

/**
 * Settings › Aprendizaje: what CodeFlow has kept as evidence about AI answers (`crate::experiences`)
 * and, below it, the datasets, training runs and adapters built from it (`crate::learning`).
 *
 * Nothing here trains by itself. An experience reaches a dataset only when its workspace allows it
 * and it was approved here; the switch is off on every workspace until it is turned on.
 */
export function AiLearningSettings() {
  const t = useT();
  const ask = useConfirmStore((s) => s.ask);
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [filter, setFilter] = useState<ExperienceFilter>({});
  const [rows, setRows] = useState<Experience[]>([]);
  const [counts, setCounts] = useState<[string, number][]>([]);
  const [allowed, setAllowed] = useState(false);

  const reload = useCallback(async () => {
    try {
      const scoped = { ...filter, workspaceId };
      const [list, totals, training] = await Promise.all([
        aiExperiencesList({ ...scoped, limit: 200 }),
        aiExperiencesCounts(workspaceId),
        workspaceId ? aiTrainingAllowed(workspaceId) : Promise.resolve(false),
      ]);
      setRows(list);
      setCounts(totals);
      setAllowed(training);
    } catch (e) {
      pushErrorToast(String(e));
    }
  }, [filter, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const setQuality = async (id: string, quality: ExperienceQuality) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, quality } : row)));
    await aiExperienceSetQuality(id, quality).catch((e: unknown) => pushErrorToast(String(e)));
  };

  const exportAll = async () => {
    const path = await saveDialog({ defaultPath: "codeflow-experiences.jsonl", filters: [{ name: "JSON Lines", extensions: ["jsonl"] }] });
    if (!path) return;
    await aiExperiencesExport(path, { ...filter, workspaceId }).catch((e: unknown) => pushErrorToast(String(e)));
  };

  const clearAll = async () => {
    const ok = await ask({ message: t("learning.clearConfirm"), confirmLabel: t("learning.clear"), danger: true });
    if (!ok) return;
    await aiExperiencesClear(workspaceId).catch((e: unknown) => pushErrorToast(String(e)));
    void reload();
  };

  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const option = (value: string, key: TranslationKey) => ({ value, label: t(key) });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12px] text-[var(--cf-text)]">
          <Checkbox
            checked={allowed}
            disabled={!workspaceId}
            onChange={(value) => {
              if (!workspaceId) return;
              setAllowed(value);
              void aiSetTrainingAllowed(workspaceId, value)
                .then(reload)
                .catch((e: unknown) => pushErrorToast(String(e)));
            }}
          />
          {t("learning.allowTraining")}
        </label>
        <span className="text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("learning.allowTrainingHint")}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("learning.experiences", { count: String(total) })}</span>
          {counts.map(([signal, n]) => (
            <span key={signal} className={chipClass(SIGNAL_TONE[signal] ?? "neutral")}>
              {t(SIGNAL_KEY[signal] ?? "learning.signalAccepted")} {n}
            </span>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-[170px]">
            <Select
              size="sm"
              value={filter.source ?? ""}
              ariaLabel={t("learning.source")}
              onChange={(value) => setFilter((f) => ({ ...f, source: value || null }))}
              options={[{ value: "", label: t("learning.anySource") }, ...Object.entries(SOURCE_KEY).map(([value, key]) => option(value, key))]}
            />
          </div>
          <div className="w-[150px]">
            <Select
              size="sm"
              value={filter.signal ?? ""}
              ariaLabel={t("learning.signal")}
              onChange={(value) => setFilter((f) => ({ ...f, signal: value || null }))}
              options={[{ value: "", label: t("learning.anySignal") }, ...Object.entries(SIGNAL_KEY).map(([value, key]) => option(value, key))]}
            />
          </div>
          <div className="w-[150px]">
            <Select
              size="sm"
              value={filter.quality ?? ""}
              ariaLabel={t("learning.quality")}
              onChange={(value) => setFilter((f) => ({ ...f, quality: value || null }))}
              options={[
                { value: "", label: t("learning.anyQuality") },
                option("unreviewed", "learning.unreviewed"),
                option("approved", "learning.approved"),
                option("excluded", "learning.excluded"),
              ]}
            />
          </div>
          <button type="button" disabled={rows.length === 0} onClick={() => void exportAll()} className={buttonClass({ variant: "ghost", size: "sm" })}>
            <Download size={13} /> {t("learning.export")}
          </button>
          <button type="button" disabled={total === 0} onClick={() => void clearAll()} className={buttonClass({ variant: "ghost", size: "sm" })}>
            <Trash2 size={13} /> {t("learning.clear")}
          </button>
        </div>
        {rows.length === 0 ? (
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("learning.noExperiences")}</span>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[var(--cf-border)]">
            {rows.map((row) => (
              <div key={row.id} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 last:border-b-0">
                <span className={chipClass(SIGNAL_TONE[row.signal] ?? "neutral")}>{t(SIGNAL_KEY[row.signal] ?? "learning.signalAccepted")}</span>
                <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t(SOURCE_KEY[row.source] ?? "learning.sourceManual")}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text)]" title={[evidence(row), row.model].filter(Boolean).join(" · ")}>
                  {evidence(row)}
                  {row.model && <span className="text-[var(--cf-text-muted)]"> · {row.model}</span>}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">{new Date(row.createdAt).toLocaleDateString()}</span>
                <button
                  type="button"
                  title={t("learning.approve")}
                  aria-pressed={row.quality === "approved"}
                  onClick={() => void setQuality(row.id, row.quality === "approved" ? "unreviewed" : "approved")}
                  className={`${buttonClass({ variant: "ghost", size: "sm" })} ${row.quality === "approved" ? "text-[var(--cf-success)]" : ""}`}
                >
                  <Check size={13} />
                </button>
                <button
                  type="button"
                  title={t("learning.exclude")}
                  aria-pressed={row.quality === "excluded"}
                  onClick={() => void setQuality(row.id, row.quality === "excluded" ? "unreviewed" : "excluded")}
                  className={`${buttonClass({ variant: "ghost", size: "sm" })} ${row.quality === "excluded" ? "text-[var(--cf-warning)]" : ""}`}
                >
                  <X size={13} />
                </button>
                <button
                  type="button"
                  title={t("learning.delete")}
                  onClick={() => {
                    setRows((current) => current.filter((r) => r.id !== row.id));
                    void aiExperienceDelete(row.id).catch((e: unknown) => pushErrorToast(String(e)));
                  }}
                  className={buttonClass({ variant: "ghost", size: "sm" })}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
        {!allowed && rows.some((row) => row.quality === "approved") && <Note>{t("learning.approvedButNotAllowed")}</Note>}
      </div>

      <AiLearningTraining />
    </div>
  );
}
