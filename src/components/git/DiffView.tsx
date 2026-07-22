import { FileDiff } from "lucide-react";
import type { FileDiffInfo } from "../../types/domain";
import { EmptyState } from "../common/EmptyState";
import { useT } from "../../state/languageStore";

function lineClasses(origin: string): string {
  if (origin === "+") return "bg-[color-mix(in_oklab,var(--cf-success)_14%,transparent)] text-[var(--cf-text)]";
  if (origin === "-") return "bg-[color-mix(in_oklab,var(--cf-danger)_14%,transparent)] text-[var(--cf-text)]";
  return "text-[var(--cf-text-muted)]";
}

function statusColor(status: string): string {
  switch (status) {
    case "added":
    case "untracked":
      return "var(--cf-success)";
    case "deleted":
      return "var(--cf-danger)";
    case "renamed":
    case "copied":
      return "var(--cf-accent)";
    default:
      return "var(--cf-warning)";
  }
}

export function DiffView({ files }: { files: FileDiffInfo[] }) {
  const t = useT();
  if (files.length === 0) {
    return <EmptyState icon={FileDiff} title={t("diff.noChanges")} subtitle={t("diff.noChangesHint")} />;
  }

  return (
    <div className="divide-y divide-[var(--cf-border)]">
      {files.map((file, i) => {
        const color = statusColor(file.status);
        return (
          <div key={i}>
            <div
              className="sticky top-0 z-10 flex items-center gap-2 border-b-2 bg-[var(--cf-surface-raised)] px-3 py-2 text-[12px] font-semibold shadow-sm"
              style={{ borderBottomColor: color, willChange: "transform", contain: "paint" }}
            >
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                style={{ background: `color-mix(in oklab, ${color} 18%, transparent)`, color }}
              >
                {file.status}
              </span>
              <span className="truncate font-mono text-[var(--cf-text)]">{file.new_path ?? file.old_path}</span>
            </div>
            {file.hunks.map((hunk, hIdx) => (
              <div key={hIdx} className="font-mono text-[12px] leading-5">
                <div className="bg-[var(--cf-accent-soft)] px-3 py-1 text-[var(--cf-accent)]">{hunk.header}</div>
                {hunk.lines.map((line, lIdx) => (
                  <div key={lIdx} className={`flex gap-3 px-3 ${lineClasses(line.origin)}`}>
                    <span className="w-8 shrink-0 select-none text-right text-[var(--cf-text-muted)]">
                      {line.old_lineno ?? ""}
                    </span>
                    <span className="w-8 shrink-0 select-none text-right text-[var(--cf-text-muted)]">
                      {line.new_lineno ?? ""}
                    </span>
                    <span className="whitespace-pre-wrap break-all">
                      {line.origin === "+" || line.origin === "-" ? line.origin : " "}
                      {line.content}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
