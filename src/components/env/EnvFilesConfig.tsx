/**
 * «Archivos detectados»: which files «Entorno» reads in this repository — the user's ask
 * (2026-10-23: «que se puedan configurar los archivos que detecta»). The patterns are the app's
 * defaults (Settings › Workspaces y proyectos › Entorno) with this repository's changes on top: a
 * pattern added or one of the defaults switched off, a file added by hand, a file ignored. Every
 * change rescans at once.
 */

import { useEffect, useRef, useState } from "react";
import { EyeOff, FilePlus2, Plus, RotateCcw, Settings2, TriangleAlert, X } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { chipClass, fieldClass, popoverClass, sectionLabelClass } from "../common/recipes";
import { Tooltip } from "../common/Tooltip";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { globalPatterns, useRepoEnvStore } from "../../state/repoEnvStore";
import { addFile, addPattern, emptyRepoConfig, ignoreFile, removePattern, unignoreFile } from "../../lib/env/config";
import type { EnvRepoConfig, EnvScan } from "../../lib/tauri/envCommands";

export function EnvFilesConfig({
  projectId,
  repoPath,
  scan,
  onClose,
}: {
  projectId: string;
  repoPath: string;
  scan: EnvScan | null;
  onClose: () => void;
}) {
  const t = useT();
  const config = useRepoEnvStore((s) => s.repoConfig[projectId]) ?? emptyRepoConfig();
  const defaults = useRepoEnvStore((s) => globalPatterns(s));
  const [pattern, setPattern] = useState("");
  const [file, setFile] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useRepoEnvStore.getState().loadConfig(projectId);
  }, [projectId]);

  // A popover: a press outside or Escape closes it.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const save = (next: EnvRepoConfig) => void useRepoEnvStore.getState().saveConfig(projectId, repoPath, next);
  const patterns = scan?.config.patterns ?? [];
  const removedDefaults = config.remove.filter((p) => defaults.includes(p));

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("env.files.title")}
      className={`${popoverClass} absolute right-0 top-full z-40 mt-1 flex max-h-[70vh] w-[420px] flex-col overflow-y-auto p-3`}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-[var(--cf-text)]">{t("env.files.title")}</h3>
        <Tooltip label={t("env.files.defaults")}>
          <button
            type="button"
            aria-label={t("env.files.defaults")}
            className={iconButtonClass({ size: "xs" })}
            onClick={() => useUiStore.getState().openSettingsAt("projects", "repoEnv")}
          >
            <Settings2 size={13} />
          </button>
        </Tooltip>
      </div>

      <p className={sectionLabelClass}>{t("env.files.patterns")}</p>
      <div className="flex flex-wrap gap-1">
        {patterns.map((p) => (
          <span key={p} className={chipClass(config.add.includes(p) ? "accent" : "neutral", "font-mono")}>
            {p}
            <button type="button" aria-label={t("env.files.removePattern", { pattern: p })} onClick={() => save(removePattern(config, p))}>
              <X size={11} />
            </button>
          </span>
        ))}
        {removedDefaults.map((p) => (
          <span key={p} className={chipClass("neutral", "font-mono line-through opacity-70")}>
            {p}
            <button type="button" aria-label={t("env.files.restorePattern", { pattern: p })} onClick={() => save(addPattern(config, p, defaults))}>
              <RotateCcw size={11} />
            </button>
          </span>
        ))}
      </div>
      {scan && scan.invalidPatterns.length > 0 && (
        <p className="mt-1 flex items-center gap-1 text-[11.5px] text-[var(--cf-warning)]">
          <TriangleAlert size={12} />
          {t("env.files.invalid", { patterns: scan.invalidPatterns.join(", ") })}
        </p>
      )}
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pattern.trim()) return;
          save(addPattern(config, pattern, defaults));
          setPattern("");
        }}
      >
        <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t("env.files.patternPlaceholder")} className={fieldClass({ size: "sm", className: "flex-1 font-mono" })} />
        <Button type="submit" size="sm" disabled={!pattern.trim()}>
          <Plus size={12} />
          {t("env.files.add")}
        </Button>
      </form>

      <p className={sectionLabelClass}>{t("env.files.detected")}</p>
      <ul className="space-y-0.5">
        {(scan?.files ?? []).map((f) => (
          <li key={f.path} className="group flex min-h-[26px] items-center gap-2 rounded-md px-1.5 text-[12px] hover:bg-[var(--cf-hover)]">
            <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text)]" title={f.path}>
              {f.path}
            </span>
            {f.manual && <span className={chipClass("accent")}>{t("env.files.manual")}</span>}
            {f.error ? (
              <Tooltip label={f.error}>
                <span className={chipClass("bad")}>{t("env.files.unreadable")}</span>
              </Tooltip>
            ) : (
              <span className="shrink-0 tabular-nums text-[11px] text-[var(--cf-text-faint)]">{t("env.files.variables", { count: f.variables })}</span>
            )}
            <Tooltip label={t("env.files.ignore")}>
              <button
                type="button"
                aria-label={t("env.files.ignore")}
                className={iconButtonClass({ size: "xs", className: "opacity-0 group-hover:opacity-100 focus-visible:opacity-100" })}
                onClick={() => save(ignoreFile(config, f.path))}
              >
                <EyeOff size={12} />
              </button>
            </Tooltip>
          </li>
        ))}
      </ul>
      {scan?.truncated && <p className="mt-1 text-[11.5px] text-[var(--cf-text-muted)]">{t("env.files.truncated")}</p>}
      {config.ignore.length > 0 && (
        <>
          <p className={sectionLabelClass}>{t("env.files.ignored")}</p>
          <ul className="space-y-0.5">
            {config.ignore.map((path) => (
              <li key={path} className="flex min-h-[26px] items-center gap-2 px-1.5 text-[12px]">
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-[var(--cf-text-muted)] line-through">{path}</span>
                <Button size="sm" variant="ghost" onClick={() => save(unignoreFile(config, path))}>
                  {t("env.files.unignore")}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file.trim()) return;
          save(addFile(config, file));
          setFile("");
        }}
      >
        <input value={file} onChange={(e) => setFile(e.target.value)} placeholder={t("env.files.filePlaceholder")} className={fieldClass({ size: "sm", className: "flex-1 font-mono" })} />
        <Button type="submit" size="sm" disabled={!file.trim()}>
          <FilePlus2 size={12} />
          {t("env.files.addFile")}
        </Button>
      </form>
    </div>
  );
}
