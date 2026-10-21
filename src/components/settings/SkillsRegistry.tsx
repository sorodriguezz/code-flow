import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, PackagePlus, Search } from "lucide-react";
import { skillsRegistryDescribe, skillsRegistrySearch, type RegistryDetail, type RegistrySkill } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { Skeleton } from "../common/Skeleton";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import type { WorkspaceSkill } from "../../types/domain";

/** How long typing has to pause before the registry is asked. */
const SEARCH_DELAY_MS = 350;

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/**
 * skills.sh, browsed in place: a search as you type, and — on the row you open — what the skill is
 * for (its `SKILL.md`'s own description, the text an agent reads to decide when to use it) and the
 * start of its instructions, before installing it with one button.
 *
 * Replaces having to find the repository and the skill's name on the website and copy both over;
 * the two fields stay behind «Instalar por repo y nombre» for a skill the search does not return.
 */
export function SkillsRegistry({
  installed,
  installing,
  onInstall,
}: {
  installed: WorkspaceSkill[];
  installing: boolean;
  onInstall: (source: string, skillId: string) => Promise<void>;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RegistrySkill[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, RegistryDetail | { error: string }>>({});
  /** The query whose answer may still be shown — anything older that arrives late is dropped. */
  const latest = useRef("");

  useEffect(() => {
    const wanted = query.trim();
    latest.current = wanted;
    if (wanted.length < 2) {
      setResults(null);
      setError(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      skillsRegistrySearch(wanted)
        .then((found) => {
          if (latest.current !== wanted) return;
          setResults(found);
          setError(null);
        })
        .catch((e) => {
          if (latest.current !== wanted) return;
          setError(String(e));
        })
        .finally(() => {
          if (latest.current === wanted) setSearching(false);
        });
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const open = (skill: RegistrySkill) => {
    if (openId === skill.id) {
      setOpenId(null);
      return;
    }
    setOpenId(skill.id);
    if (details[skill.id] && !("error" in details[skill.id])) return;
    skillsRegistryDescribe(skill.source, skill.skillId)
      .then((detail) => setDetails((prev) => ({ ...prev, [skill.id]: detail })))
      .catch((e) => setDetails((prev) => ({ ...prev, [skill.id]: { error: String(e) } })));
  };

  const isInstalled = (skill: RegistrySkill) => installed.some((s) => s.skill_name === skill.skillId && s.source_repo === skill.source);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--cf-text-muted)]" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("settings.skillSearchPlaceholder")}
          aria-label={t("settings.skillSearchPlaceholder")}
          className={fieldClass({ className: "w-full pl-8" })}
        />
        {searching && <Loader2 size={13} className="absolute right-2.5 top-1/2 -translate-y-1/2 animate-spin text-[var(--cf-text-muted)]" />}
      </div>

      {error && <p className="text-[11.5px] text-[var(--cf-danger)]">{error}</p>}
      {results && results.length === 0 && !searching && <p className="text-[11.5px] text-[var(--cf-text-muted)]">{t("settings.skillSearchEmpty")}</p>}

      {results && results.length > 0 && (
        <div className="max-h-[340px] overflow-auto rounded-md border border-[var(--cf-border)]">
          {results.map((skill) => {
            const expanded = openId === skill.id;
            const detail = details[skill.id];
            const already = isInstalled(skill);
            return (
              <div key={skill.id} className="border-b border-[var(--cf-border)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => open(skill)}
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--cf-hover)]"
                >
                  {expanded ? <ChevronDown size={12} className="shrink-0" /> : <ChevronRight size={12} className="shrink-0" />}
                  <span className="truncate font-mono text-[12px] text-[var(--cf-text)]">{skill.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]">{skill.source}</span>
                  {already && (
                    <span className="shrink-0 rounded-full border border-[var(--cf-border)] px-1.5 text-[10.5px] text-[var(--cf-text-muted)]">
                      {t("settings.skillInstalled")}
                    </span>
                  )}
                  <span className="shrink-0 tabular-nums text-[11px] text-[var(--cf-text-muted)]" title={t("settings.skillInstalls", { n: skill.installs.toLocaleString() })}>
                    {compact.format(skill.installs)}
                  </span>
                </button>
                {expanded && (
                  <div className="space-y-2 px-7 pb-2.5 text-[12px]">
                    {!detail ? (
                      <div className="space-y-1.5">
                        <Skeleton className="h-3 w-full" />
                        <Skeleton className="h-3 w-4/5" />
                      </div>
                    ) : "error" in detail ? (
                      <p className="text-[11.5px] text-[var(--cf-text-muted)]">{detail.error}</p>
                    ) : (
                      <>
                        <p className="leading-relaxed text-[var(--cf-text)]">{detail.description}</p>
                        {detail.preview && <Preview text={detail.preview} label={t("settings.skillPreview")} />}
                        <div className="flex flex-wrap items-center gap-3 text-[11.5px]">
                          <a href={detail.pageUrl} target="_blank" rel="noreferrer" className="text-[var(--cf-accent)] hover:underline">
                            {t("settings.skillViewOnRegistry")}
                          </a>
                          {detail.fileUrl && (
                            <a href={detail.fileUrl} target="_blank" rel="noreferrer" className="text-[var(--cf-accent)] hover:underline">
                              {t("settings.skillViewFile")}
                            </a>
                          )}
                        </div>
                      </>
                    )}
                    <button
                      type="button"
                      disabled={installing || already}
                      onClick={() => void onInstall(skill.source, skill.skillId)}
                      className={buttonClass({ variant: "primary", size: "sm" })}
                    >
                      {installing ? <Loader2 size={12} className="animate-spin" /> : <PackagePlus size={12} />}
                      {already ? t("settings.skillInstalled") : installing ? t("settings.installingSkill") : t("settings.installSkill")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The start of the skill's instructions, folded until asked for. */
function Preview({ text, label }: { text: string; label: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setShown((v) => !v)} className="flex items-center gap-1 text-[11.5px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
        {shown ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {label}
      </button>
      {shown && (
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--cf-hover)] p-2 font-mono text-[11px] leading-relaxed text-[var(--cf-text-muted)] select-text">
          {text}
        </pre>
      )}
    </div>
  );
}
