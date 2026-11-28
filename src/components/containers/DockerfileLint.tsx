import { useEffect, useState } from "react";
import { CheckCircle2, ClipboardCheck, Loader2 } from "lucide-react";
import { containersDockerfileLint, containersHadolint } from "../../lib/tauri/containersCommands";
import { useT } from "../../state/languageStore";
import { useToolSetupStore } from "../../state/toolSetupStore";
import { ToolInstallationLink } from "../common/ToolInstallationLink";
import type { LintFinding } from "../../types/containers";

/**
 * «Revisión del Dockerfile» in the build form: what hadolint says about the chosen Dockerfile, read
 * when the path settles. Informative only — a build never waits for it, and without hadolint the
 * section says how to install it instead.
 */

/** The Dockerfile's full path: as written when absolute, else inside the build folder. */
export function dockerfilePath(folder: string, dockerfile: string): string {
  const file = dockerfile.trim();
  const dir = folder.trim().replace(/[\\/]+$/, "");
  if (!file) return "";
  if (file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file)) return file;
  if (!dir) return "";
  return `${dir}${dir.includes("\\") && !dir.includes("/") ? "\\" : "/"}${file.replace(/^\.[\\/]/, "")}`;
}

const LEVEL_STYLE: Record<string, string> = {
  error: "bg-[color-mix(in_srgb,var(--cf-danger)_14%,transparent)] text-[var(--cf-danger)]",
  warning: "bg-[var(--cf-warning-soft)] text-[var(--cf-warning-text)]",
  info: "bg-[var(--cf-hover)] text-[var(--cf-text-muted)]",
  style: "bg-[var(--cf-hover)] text-[var(--cf-text-faint)]",
};

export function DockerfileLint({ folder, dockerfile }: { folder: string; dockerfile: string }) {
  const t = useT();
  const [hadolint, setHadolint] = useState<string | null | undefined>(undefined);
  const [findings, setFindings] = useState<LintFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const path = dockerfilePath(folder, dockerfile);
  const detectedHadolint = useToolSetupStore((state) => state.tools?.find((tool) => tool.id === "hadolint")?.installed);

  useEffect(() => {
    let alive = true;
    void containersHadolint().catch(() => null).then((found) => alive && setHadolint(found));
    return () => {
      alive = false;
    };
  }, [detectedHadolint]);
  useEffect(() => {
    setFindings(null);
    setError(null);
    if (!hadolint || !path) return;
    let alive = true;
    // Typed path by path: read once it has stopped changing.
    const timer = setTimeout(() => {
      setLoading(true);
      containersDockerfileLint(path)
        .then((found) => alive && setFindings(found))
        .catch((e: unknown) => alive && setError(String(e)))
        .finally(() => alive && setLoading(false));
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [hadolint, path]);

  if (hadolint === undefined || !path) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-[9px] border border-[var(--cf-border)] p-2.5">
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-[var(--cf-text-muted)]">
        <ClipboardCheck size={12} />
        {t("containers.m.build.lintTitle")}
        {loading && <Loader2 size={11} className="animate-spin" />}
      </div>
      {hadolint === null ? (
        <p className="text-[11.5px] leading-relaxed text-[var(--cf-text-faint)]">
          {t("containers.m.build.lintNone")}{" "}
          <ToolInstallationLink tool="hadolint" />
        </p>
      ) : error ? (
        <p className="text-[11.5px] text-[var(--cf-text-faint)]">{error}</p>
      ) : findings && findings.length === 0 ? (
        <p className="flex items-center gap-1 text-[11.5px] text-[var(--cf-success)]">
          <CheckCircle2 size={12} />
          {t("containers.m.build.lintClean")}
        </p>
      ) : findings ? (
        <div className="flex max-h-[160px] flex-col gap-0.5 overflow-auto font-mono text-[11px]">
          {findings.map((f, i) => (
            <div key={`${f.line}|${f.code}|${i}`} className="grid grid-cols-[34px_62px_minmax(0,1fr)] items-start gap-2">
              <span className="text-[var(--cf-text-faint)]">L{f.line}</span>
              <span className={`rounded px-1 text-center font-semibold ${LEVEL_STYLE[f.level] ?? LEVEL_STYLE.info}`}>{f.code}</span>
              <span className="font-sans text-[11.5px] text-[var(--cf-text)]">{f.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
