import { useEffect, useState } from "react";
import { create } from "zustand";
import { ClipboardCopy, Download, ListChecks, MessageSquare, RotateCw, X } from "lucide-react";
import type { WorklogFormat, WorklogOutcome, WorklogPeriodKind, WorklogRequest } from "../../../lib/tauri/worklogCommands";
import { useT } from "../../../state/languageStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { ChatModelPicker } from "../../ai/ChatModelPicker";
import { buttonClass } from "../../common/Button";
import { Checkbox } from "../../common/Checkbox";
import { DateField } from "../../common/DateField";
import { Select } from "../../common/Select";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { copyForSlack, copyForTeams, exportSummary, generateIntoNote } from "./actions";
import { isoDay } from "./format";

/**
 * «Nueva nota › Daily / Semanal» (user, 2026-10-23): the period, the workspace, the format and the
 * engine, then the summary is written and kept as a note — opened behind this dialog, which stays
 * with the copy buttons.
 *
 * The engine picker writes the Notes row (`task="notes"`): a summary is written into a note, and the
 * Rust side routes it there when the picker is left alone (`worklog::writer`).
 */

/** The glyph of the summary — the menu row, the dialog, the note's strip. */
export const WORKLOG_ICON = ListChecks;

const useWorklogForm = create<{ open: boolean }>(() => ({ open: false }));

export function openWorklogForm(): void {
  useWorklogForm.setState({ open: true });
}

/** Mounted once by the Notes explorer; draws the dialog while it is open. */
export function WorklogModalHost() {
  const open = useWorklogForm((s) => s.open);
  if (!open) return null;
  return <WorklogModal onClose={() => useWorklogForm.setState({ open: false })} />;
}

type Scope = "workspace" | "all";
type FormatChoice = "auto" | WorklogFormat;

function WorklogModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [period, setPeriod] = useState<WorklogPeriodKind>("previousWorkday");
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [scope, setScope] = useState<Scope>("workspace");
  const [format, setFormat] = useState<FormatChoice>("auto");
  const [plain, setPlain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<WorklogOutcome | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The model menu closes first (it is a `role="menu"`).
      if (event.key === "Escape" && !document.querySelector('[role="menu"]')) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const request = (): WorklogRequest => ({
    period,
    from: period === "custom" ? from : null,
    to: period === "custom" ? to : null,
    format: format === "auto" ? null : format,
    workspaceId: scope === "workspace" ? workspaceId : null,
    engine: null,
    plain,
    language: "",
  });

  const generate = async (noteId: string | null = null) => {
    if (busy) return;
    setBusy(true);
    const result = await generateIntoNote(outcome?.request ?? request(), noteId);
    setBusy(false);
    if (result) setOutcome(result);
  };

  const label = "mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]";
  const periods: { value: WorklogPeriodKind; label: string }[] = [
    { value: "previousWorkday", label: t("worklog.period.previousWorkday") },
    { value: "today", label: t("worklog.period.today") },
    { value: "thisWeek", label: t("worklog.period.thisWeek") },
    { value: "lastWeek", label: t("worklog.period.lastWeek") },
    { value: "custom", label: t("worklog.period.custom") },
  ];

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4" onClick={busy ? undefined : onClose}>
      <form
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void generate();
        }}
        className="cf-fade-in w-[460px] max-w-[92vw] overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
      >
        <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <ListChecks size={14} className="text-[var(--cf-accent)]" />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">{t("worklog.title")}</h2>
          <button type="button" onClick={onClose} aria-label={t("notes.close")} className="text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
            <X size={15} />
          </button>
        </div>

        {outcome ? (
          <div className="space-y-3 p-4">
            <p className="text-[12.5px] font-medium text-[var(--cf-text)]">{outcome.title}</p>
            <p className="text-[11.5px] text-[var(--cf-text-muted)]">
              {outcome.engine === "none" ? t("worklog.writtenPlain") : t("worklog.writtenBy").replace("{engine}", outcome.engine)}
              {" · "}
              {t("worklog.savedInNotes")}
            </p>
            {outcome.log.notices.length > 0 && (
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-[var(--cf-text-muted)]">
                {outcome.log.notices.slice(0, 5).map((notice) => (
                  <li key={notice}>{notice}</li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={() => void copyForSlack(outcome.markdown)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                <MessageSquare size={12} />
                {t("worklog.copySlack")}
              </button>
              <button type="button" onClick={() => void copyForTeams(outcome.markdown)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                <ClipboardCopy size={12} />
                {t("worklog.copyTeams")}
              </button>
              <button type="button" onClick={() => void exportSummary(outcome.title, outcome.markdown)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                <Download size={12} />
                {t("worklog.export")}
              </button>
              <button type="button" disabled={busy} onClick={() => void generate(outcome.note?.id ?? null)} className={buttonClass({ variant: "secondary", size: "sm" })}>
                {busy && !outcome.request.plain ? <ThinkingOrb size="sm" /> : <RotateCw size={12} className={busy ? "animate-spin" : ""} />}
                {t("worklog.regenerate")}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 p-4">
            <div>
              <span className={label}>{t("worklog.periodLabel")}</span>
              <Select value={period} onChange={(value) => setPeriod(value as WorklogPeriodKind)} options={periods} ariaLabel={t("worklog.periodLabel")} />
            </div>
            {period === "custom" && (
              <div className="flex gap-2">
                <label className="flex-1">
                  <span className={label}>{t("worklog.from")}</span>
                  <DateField value={from} max={to} onChange={setFrom} ariaLabel={t("worklog.from")} className="w-full" />
                </label>
                <label className="flex-1">
                  <span className={label}>{t("worklog.to")}</span>
                  <DateField value={to} min={from} onChange={setTo} ariaLabel={t("worklog.to")} className="w-full" />
                </label>
              </div>
            )}
            <div className="flex gap-2">
              <div className="flex-1">
                <span className={label}>{t("worklog.scopeLabel")}</span>
                <Select
                  value={scope}
                  onChange={(value) => setScope(value as Scope)}
                  options={[
                    { value: "workspace", label: t("worklog.scope.workspace") },
                    { value: "all", label: t("worklog.scope.all") },
                  ]}
                  ariaLabel={t("worklog.scopeLabel")}
                />
              </div>
              <div className="flex-1">
                <span className={label}>{t("worklog.formatLabel")}</span>
                <Select
                  value={format}
                  onChange={(value) => setFormat(value as FormatChoice)}
                  options={[
                    { value: "auto", label: t("worklog.format.auto") },
                    { value: "daily", label: t("worklog.format.daily") },
                    { value: "weekly", label: t("worklog.format.weekly") },
                  ]}
                  ariaLabel={t("worklog.formatLabel")}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              {!plain && <ChatModelPicker task="notes" liveModel={null} chatActive={false} />}
              <label className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
                <Checkbox checked={plain} onChange={setPlain} />
                {t("worklog.plain")}
              </label>
            </div>
            <p className="text-[10.5px] leading-relaxed text-[var(--cf-text-muted)]">{t("worklog.hint")}</p>
          </div>
        )}

        {!outcome && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
            {busy && (
              <span className="mr-auto flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                {/* The orb marks a model reasoning; the plain list has none. */}
                {!plain && <ThinkingOrb size="sm" />}
                {t("worklog.working")}
              </span>
            )}
            <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] transition-colors hover:text-[var(--cf-text)]">
              {t("notes.cancel")}
            </button>
            <button type="submit" disabled={busy || !workspaceId} className={buttonClass({ variant: "primary" })}>
              {t("worklog.generate")}
            </button>
          </div>
        )}
      </form>
    </div>
  );
}
