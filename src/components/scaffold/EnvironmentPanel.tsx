import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Check, ChevronDown, CircleAlert, CircleX, Download, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { useT } from "../../state/languageStore";
import { sourceKey, useScaffoldStore } from "../../state/scaffoldStore";
import type { ScaffoldPlatform, ToolStatus } from "../../lib/scaffold/api";
import type { Requirement } from "../../lib/scaffold/catalog";
import { previewStep, shellFor, type Step } from "../../lib/scaffold/script";
import { describeRange, pickLine } from "../../lib/scaffold/semver";
import { TOOLS, recipesFor, type Recipe, type ToolId } from "../../lib/scaffold/tools";
import { openExternalUrl } from "../../lib/tauri/commands";
import { pushErrorToast } from "../../state/toastStore";
import { buttonClass, iconButtonClass } from "../common/Button";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { sectionLabelClass } from "../common/recipes";
import { TemplateLogo } from "./TemplateLogo";

/** One requirement, checked against what the machine has. */
export interface CheckedRequirement {
  req: Requirement;
  status: ToolStatus | undefined;
  /** `missing`: not found. `version`: found, but outside the range. `null`: satisfied. */
  problem: "missing" | "version" | null;
  /** A way round it that is not an install — "use Angular 21", say. */
  hint?: ReactNode;
}

/** What starting an install needs: the steps, and what to call it while it runs. */
export interface InstallRequest {
  tool: ToolId;
  steps: Step[];
  /** "Node.js 24", "uv". */
  label: string;
}

/**
 * The environment check, one row per tool the chosen template needs.
 *
 * A row says what was found and what is needed, and when the two disagree it offers the fix in place:
 * which version to install (defaulting to the best line for the range — a living LTS if one fits),
 * which route to take (the version manager already in use first — see `lib/scaffold/tools.ts`), and
 * the exact commands, before anything runs. The run itself happens in the dialog's terminal.
 */
export function EnvironmentPanel({
  rows,
  platform,
  onInstall,
  onInstallAll,
}: {
  rows: CheckedRequirement[];
  platform: ScaffoldPlatform | null;
  onInstall: (request: InstallRequest) => void;
  /** Everything missing, each through its default route, one after another. */
  onInstallAll: () => void;
}) {
  const t = useT();
  const detecting = useScaffoldStore((s) => s.detecting);
  const detectError = useScaffoldStore((s) => s.detectError);
  const detect = useScaffoldStore((s) => s.detect);
  const [open, setOpen] = useState<ToolId | null>(null);
  const missing = rows.filter((row) => row.problem !== null).length;

  return (
    <section data-tour="scaffold-environment">
      <div className="flex items-center gap-1">
        <div className={`${sectionLabelClass} flex-1 px-0`}>{t("scaffold.env.title")}</div>
        {missing > 0 && !detecting && (
          <Tooltip label={t("scaffold.env.installAll")} description={t("scaffold.env.installAllHint")} side="top">
            <button type="button" onClick={onInstallAll} className={buttonClass({ variant: "ghost", size: "sm", className: "gap-1 text-[var(--cf-accent)]" })}>
              <Download size={12} />
              {t("scaffold.env.installAll")}
            </button>
          </Tooltip>
        )}
        <Tooltip label={t("scaffold.env.refresh")} description={t("scaffold.env.refreshHint")} side="left">
          <button
            type="button"
            onClick={() => void detect(true)}
            disabled={detecting}
            aria-label={t("scaffold.env.refresh")}
            className={iconButtonClass({ size: "xs" })}
          >
            <RefreshCw size={12} className={detecting ? "animate-spin" : ""} />
          </button>
        </Tooltip>
      </div>
      {detectError && <p className="mb-1 text-[11px] text-[var(--cf-danger)]">{detectError}</p>}
      <div className="divide-y divide-[var(--cf-border)] rounded-lg border border-[var(--cf-border)]">
        {rows.map((row) => (
          <RequirementRow
            key={row.req.tool}
            row={row}
            platform={platform}
            detecting={detecting && !row.status}
            expanded={open === row.req.tool}
            onToggle={() => setOpen((current) => (current === row.req.tool ? null : row.req.tool))}
            onInstall={(request) => {
              setOpen(null);
              onInstall(request);
            }}
          />
        ))}
      </div>
    </section>
  );
}

function RequirementRow({
  row,
  platform,
  detecting,
  expanded,
  onToggle,
  onInstall,
}: {
  row: CheckedRequirement;
  platform: ScaffoldPlatform | null;
  detecting: boolean;
  expanded: boolean;
  onToggle: () => void;
  onInstall: (request: InstallRequest) => void;
}) {
  const t = useT();
  const info = TOOLS[row.req.tool];
  const { status, problem } = row;
  const range = row.req.range ? describeRange(row.req.range) : null;

  const state = detecting ? (
    <Loader2 size={13} className="animate-spin text-[var(--cf-text-muted)]" />
  ) : problem === null ? (
    <Check size={13} className="text-[var(--cf-success)]" />
  ) : problem === "version" ? (
    <CircleAlert size={13} className="text-[var(--cf-warning)]" />
  ) : (
    <CircleX size={13} className="text-[var(--cf-danger)]" />
  );

  return (
    <div>
      <div className="flex h-9 items-center gap-2.5 px-2.5">
        <TemplateLogo logo={info.logo} name={info.name} size={15} />
        <span className="min-w-0 truncate text-[13px] text-[var(--cf-text)]">{info.name}</span>
        {range && (
          <Tooltip label={t("scaffold.env.needs", { range })} description={row.req.because} side="top">
            <span className="min-w-0 max-w-[45%] truncate font-mono text-[11px] text-[var(--cf-text-faint)]">{range}</span>
          </Tooltip>
        )}
        <span className="flex-1" />
        <span
          title={status?.path ?? status?.detail ?? undefined}
          className={`shrink-0 font-mono text-[11.5px] ${
            problem === "missing" ? "text-[var(--cf-text-faint)]" : "text-[var(--cf-text-muted)]"
          }`}
        >
          {detecting ? "" : status?.found ? (status.version ?? t("scaffold.env.found")) : t("scaffold.env.missing")}
        </span>
        <span className="flex w-4 shrink-0 justify-center">{state}</span>
        {problem !== null && !detecting && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className={buttonClass({ variant: expanded ? "secondary" : "ghost", size: "sm", className: "gap-1" })}
          >
            <Download size={12} />
            {problem === "version" ? t("scaffold.env.update") : t("scaffold.env.install")}
            <ChevronDown size={11} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>
      {row.hint && problem !== null && !detecting && <div className="-mt-1 px-2.5 pb-2 pl-[36px] text-[11.5px]">{row.hint}</div>}
      {expanded && platform && <InstallPanel tool={row.req.tool} range={row.req.range ?? null} platform={platform} onInstall={onInstall} />}
    </div>
  );
}

/** How to install one tool: version, route, and the commands that will run. */
function InstallPanel({
  tool,
  range,
  platform,
  onInstall,
}: {
  tool: ToolId;
  range: string | null;
  platform: ScaffoldPlatform;
  onInstall: (request: InstallRequest) => void;
}) {
  const t = useT();
  const info = TOOLS[tool];
  const tools = useScaffoldStore((s) => s.tools);
  const loadVersions = useScaffoldStore((s) => s.loadVersions);
  const prefs = useScaffoldStore((s) => s.prefs);
  const savePrefs = useScaffoldStore((s) => s.savePrefs);
  const versions = useScaffoldStore((s) => (info.versions ? s.versions[sourceKey(info.versions)] : undefined));

  useEffect(() => {
    if (info.versions) loadVersions(info.versions);
  }, [info.versions, loadVersions]);

  const lines = versions?.data ?? [];
  const [line, setLine] = useState<string | null>(null);
  const best = useMemo(() => pickLine(lines, range, info.dialect), [lines, range, info.dialect]);
  const chosen = lines.find((l) => l.line === line) ?? best;

  const present = useMemo(
    () => new Set(Object.values(tools).filter((status) => status.found).map((status) => status.id)),
    [tools],
  );
  const recipes = useMemo(
    () => recipesFor(tool, { platform, present, line: chosen?.line, lts: chosen ? chosen.channel === "lts" : undefined }),
    [tool, platform, present, chosen],
  );
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const recipe: Recipe | undefined =
    recipes.find((r) => r.id === recipeId) ?? recipes.find((r) => r.id === prefs?.recipes?.[tool]) ?? recipes[0];
  const shell = shellFor(platform);

  if (recipes.length === 0) {
    return (
      <div className="flex items-center gap-2 border-t border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2.5 text-[12px] text-[var(--cf-text-muted)]">
        {t("scaffold.env.noRecipe")}
        <button
          type="button"
          onClick={() => void openExternalUrl(info.homepage).catch((e: unknown) => pushErrorToast(String(e)))}
          className="inline-flex items-center gap-1 text-[var(--cf-accent)] hover:underline"
        >
          {new URL(info.homepage).host}
          <ExternalLink size={11} />
        </button>
      </div>
    );
  }

  const label = chosen && info.versions ? `${info.name} ${chosen.line}` : info.name;

  return (
    <div className="space-y-2 border-t border-[var(--cf-border)] bg-[var(--cf-sunken)] px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {info.versions && (
          <div className="w-[190px] shrink-0">
            <Select
              size="sm"
              value={chosen?.line ?? ""}
              onChange={setLine}
              ariaLabel={t("scaffold.env.version")}
              placeholder={versions?.status === "loading" ? t("scaffold.loading") : t("scaffold.latest")}
              options={lines.map((l) => ({
                value: l.line,
                label: `${l.line}${l.channel === "lts" ? " · LTS" : ""}${l.eol ? ` · ${t("scaffold.eol")}` : ""}  (${l.version})`,
              }))}
            />
          </div>
        )}
        <div className="w-[190px] shrink-0">
          <Select
            size="sm"
            value={recipe?.id ?? ""}
            onChange={setRecipeId}
            ariaLabel={t("scaffold.env.via")}
            options={recipes.map((r) => ({ value: r.id, label: `${t("scaffold.env.viaPrefix")} ${r.label}` }))}
          />
        </div>
        <span className="flex-1" />
        <button
          type="button"
          disabled={!recipe}
          onClick={() => {
            if (!recipe) return;
            savePrefs({ recipes: { ...(prefs?.recipes ?? {}), [tool]: recipe.id } });
            onInstall({ tool, steps: recipe.steps, label });
          }}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          <Download size={12} />
          {t("scaffold.env.run")}
        </button>
      </div>
      {recipe && (
        <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2 py-1.5 font-mono text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
          {recipe.steps.map((step) => previewStep(shell, step)).join("\n")}
        </pre>
      )}
      {recipe?.sudo && <p className="text-[11px] text-[var(--cf-text-muted)]">{t("scaffold.env.sudo")}</p>}
    </div>
  );
}
