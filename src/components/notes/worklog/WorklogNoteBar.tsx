import { useMemo, useState } from "react";
import { ClipboardCopy, Download, ListChecks, MessageSquare, RotateCw } from "lucide-react";
import { useT } from "../../../state/languageStore";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { copyForSlack, copyForTeams, exportSummary, generateIntoNote } from "./actions";
import { requestOf, summaryOf } from "./format";

/**
 * The strip over a «Daily / Semanal» note — one whose body ends in the summary's marker — with what
 * the form offered after writing it: copy for Slack, copy for Teams, export, regenerate. Any other
 * note draws nothing.
 */
export function WorklogNoteBar({ noteId, title, content }: { noteId: string; title: string; content: string }) {
  const t = useT();
  const request = useMemo(() => requestOf(content), [content]);
  const [busy, setBusy] = useState(false);
  if (!request) return null;
  const summary = () => summaryOf(content);
  const button =
    "flex h-6 items-center gap-1 rounded-md px-1.5 text-[11.5px] text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)] hover:text-[var(--cf-text)] disabled:opacity-50";
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-[var(--cf-border)] px-4 py-1">
      <ListChecks size={12} className="text-[var(--cf-accent)]" />
      <span className="mr-1 text-[11px] font-medium text-[var(--cf-text-muted)]">{t("worklog.barLabel")}</span>
      <button type="button" className={button} onClick={() => void copyForSlack(summary())}>
        <MessageSquare size={12} />
        {t("worklog.copySlack")}
      </button>
      <button type="button" className={button} onClick={() => void copyForTeams(summary())}>
        <ClipboardCopy size={12} />
        {t("worklog.copyTeams")}
      </button>
      <button type="button" className={button} onClick={() => void exportSummary(title, summary())}>
        <Download size={12} />
        {t("worklog.export")}
      </button>
      <button
        type="button"
        className={button}
        disabled={busy}
        title={t("worklog.regenerateHint")}
        onClick={() => {
          setBusy(true);
          void generateIntoNote(request, noteId).finally(() => setBusy(false));
        }}
      >
        {busy && !request.plain ? <ThinkingOrb size="sm" /> : <RotateCw size={12} className={busy ? "animate-spin" : ""} />}
        {t("worklog.regenerate")}
      </button>
    </div>
  );
}
