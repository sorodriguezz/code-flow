/**
 * What a lens is fed by: the document's sources along the foot of its panel, and the way to read
 * them again — or, for a document drawn by hand, the way to give it one. And `Evidence`: where one
 * fact came from.
 */
import { ClipboardList, Cloud, FileText, FolderGit2, Plus, RefreshCw } from "lucide-react";
import type { SourceKind } from "../../../lib/architecture/types";
import { useT } from "../../../state/languageStore";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { Tooltip } from "../../common/Tooltip";
import { useArchModelContext } from "../useArchModel";
import { useArchSourceDialog } from "./ArchSourceDialog";

const ICON: Record<SourceKind, React.ReactNode> = {
  repo: <FolderGit2 size={12} />,
  document: <FileText size={12} />,
  brief: <ClipboardList size={12} />,
  cloud: <Cloud size={12} />,
};

/** `inline` is the variant for a panel with no foot of its own (Ask, whose foot is the composer). */
export function SourcesBar({ inline = false }: { inline?: boolean }) {
  const t = useT();
  const model = useArchModelContext();
  const openAs = useArchSourceDialog((s) => s.openAs);
  const sources = model?.doc.sources ?? [];
  return (
    <div className={`flex min-w-0 shrink-0 items-center gap-1.5 text-[11.5px] ${inline ? "" : "h-9 border-t border-[var(--cf-border)] pl-3 pr-1.5"}`} data-tour="arch-sources">
      <Tooltip label={t("arch.src.title")} description={t("arch.src.titleHint")}>
        <span className="shrink-0 cursor-help text-[var(--cf-text-faint)]">{t("arch.src.title")}</span>
      </Tooltip>
      {sources.length ? (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
            {sources.map((s, i) => (
              <span key={`${s.kind}-${s.ref ?? s.name}-${i}`} title={[s.ref, s.readAt ? t("arch.src.readAt", { date: s.readAt }) : ""].filter(Boolean).join("\n")} className="inline-flex h-5 min-w-0 max-w-[150px] shrink items-center gap-1 rounded-[5px] bg-[var(--cf-hover)] px-1.5 text-[var(--cf-text)]">
                <span className="shrink-0 text-[var(--cf-text-muted)]">{ICON[s.kind]}</span>
                <span className="truncate">{s.name}</span>
              </span>
            ))}
          </div>
          <Tooltip label={t("arch.src.refresh")}>
            <button type="button" onClick={() => openAs("update")} className={iconButtonClass({ size: "xs" })} aria-label={t("arch.src.refresh")}><RefreshCw size={12} /></button>
          </Tooltip>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate text-[var(--cf-text-muted)]">{t("arch.src.noneShort")}</span>
          <Tooltip label={t("arch.src.generate")} description={t("arch.src.none")}>
            <button type="button" onClick={() => openAs("update")} className={buttonClass({ size: "sm", variant: "ghost", className: "h-[22px] gap-1 px-1.5 text-[11.5px]" })}><Plus size={12} />{t("arch.src.add")}</button>
          </Tooltip>
        </>
      )}
    </div>
  );
}

/** The lines saying where something was read from, or nothing. */
export function Evidence({ lines, max = 4 }: { lines: string[] | undefined; max?: number }) {
  const t = useT();
  if (!lines?.length) return null;
  return (
    <div className="grid gap-0.5">
      <span className="text-[10.5px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("arch.src.evidence")}</span>
      {lines.slice(0, max).map((line, i) => (
        <span key={i} className="truncate font-mono text-[10.5px] leading-[1.45] text-[var(--cf-text-muted)]" title={line}>{line}</span>
      ))}
      {lines.length > max ? <span className="text-[10.5px] text-[var(--cf-text-faint)]">{t("arch.src.more", { n: lines.length - max })}</span> : null}
    </div>
  );
}
