import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import Editor from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { Check, ChevronDown, Code2, Copy, PanelRightClose, PanelRightOpen, Settings2 } from "lucide-react";
import { CARD } from "./panelChrome";
import { useApiStore } from "../../state/apiStore";
import { useLayoutStore } from "../../state/layoutStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import { resolveRequest } from "../../lib/api/send";
import { SNIPPET_TARGETS, defaultSnippetOptions, generateSnippet } from "../../lib/api/codegen";
import { ResizeHandle } from "../common/ResizeHandle";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import type { SnippetOptions, SnippetTarget } from "../../types/api";

const TARGET_KEY = "api_snippet_target";
const OPTIONS_KEY = "api_snippet_options";
const COLLAPSED_KEY = "api_snippet_collapsed";
const DEFAULT_TARGET = "shell-curl";

const MIN_WIDTH = 300;
const MAX_WIDTH = 720;

/** The draft changes on every keystroke; re-resolving (and re-signing a JWT) that often is waste. */
const REGENERATE_DEBOUNCE_MS = 250;

const INDENT_VALUES: Record<string, SnippetOptions["indentWith"]> = {
  "2": "  ",
  "4": "    ",
  tab: "\t",
};

export function CodeSnippetPanel({ tabId }: { tabId: string }) {
  const t = useT();
  const width = useLayoutStore((s) => s.sizes.apiSnippetWidth);
  const setSize = useLayoutStore((s) => s.setSize);
  const commitSize = useLayoutStore((s) => s.commitSize);
  const monacoTheme = useThemeStore((s) => s.monacoTheme);

  // Every input the send path reads, so the snippet moves whenever what Send would do moves.
  const tab = useApiStore((s) => s.openTabs.find((candidate) => candidate.id === tabId) ?? null);
  const settings = useApiStore((s) => s.settings);
  const cookies = useApiStore((s) => s.cookies);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const collections = useApiStore((s) => s.collections);

  // Collapsed until asked for. The snippet is a "now show me how to do this in code" step, not
  // something you watch while composing a request — and it costs the builder ~420px of width to
  // sit open. The choice is remembered, like the target and the options below it.
  const [collapsed, setCollapsed] = useState(true);
  const [targetId, setTargetId] = useState(DEFAULT_TARGET);
  const [options, setOptions] = useState<SnippetOptions>(defaultSnippetOptions);
  /** `null` until the first generation lands — otherwise the panel claims "unsupported" for the
   * length of the debounce every time it mounts. A regeneration keeps the previous code on screen. */
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toggleCollapsed = (next: boolean) => {
    setCollapsed(next);
    void setSetting(COLLAPSED_KEY, next ? "1" : "0").catch(() => {});
  };

  const target = useMemo(
    () => SNIPPET_TARGETS.find((candidate) => candidate.id === targetId) ?? SNIPPET_TARGETS[0],
    [targetId],
  );

  useEffect(() => {
    let cancelled = false;
    void Promise.all([getSetting(TARGET_KEY), getSetting(OPTIONS_KEY), getSetting(COLLAPSED_KEY)])
      .then(([storedTarget, storedOptions, storedCollapsed]) => {
        if (cancelled) return;
        // Only an explicit "0" reopens it: an absent key is a fresh install, which starts closed.
        if (storedCollapsed === "0") setCollapsed(false);
        if (storedTarget && SNIPPET_TARGETS.some((candidate) => candidate.id === storedTarget)) {
          setTargetId(storedTarget);
        }
        // Merged over the defaults so a blob written before a new option existed still loads.
        if (storedOptions) {
          try {
            setOptions({ ...defaultSnippetOptions(), ...(JSON.parse(storedOptions) as Partial<SnippetOptions>) });
          } catch {
            // A corrupt blob is not worth a toast; the defaults are already in place.
          }
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const draft = tab?.draft ?? null;
  const collectionId = tab?.collectionId ?? null;

  useEffect(() => {
    if (collapsed || !draft) {
      setCode(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const store = useApiStore.getState();
      // Deliberately the same call the send path makes: a snippet built from the raw spec would
      // show `{{baseUrl}}` and no auth header, i.e. a request that was never going to be sent.
      void resolveRequest(draft, store.variableContext(collectionId), store.authChainForTab(tabId), settings, cookies)
        .then((resolved) => {
          if (cancelled) return;
          setCode(generateSnippet(targetId, resolved, options));
          setError(null);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setCode(null);
          setError(String(e));
        });
    }, REGENERATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    collapsed,
    draft,
    collectionId,
    tabId,
    targetId,
    options,
    settings,
    cookies,
    environments,
    activeEnvironmentId,
    collections,
  ]);

  const chooseTarget = (id: string) => {
    setTargetId(id);
    void setSetting(TARGET_KEY, id).catch(() => {});
  };

  const patchOptions = (patch: Partial<SnippetOptions>) => {
    const next = { ...options, ...patch };
    setOptions(next);
    void setSetting(OPTIONS_KEY, JSON.stringify(next)).catch(() => {});
  };

  const copy = () => {
    if (!code) return;
    void navigator.clipboard.writeText(code);
    setCopied(true);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  if (collapsed) {
    return (
      <div className={`flex h-full w-9 shrink-0 flex-col items-center gap-2 py-2 ${CARD}`}>
        <button
          type="button"
          title={t("api.snippet.expand")}
          aria-label={t("api.snippet.expand")}
          onClick={() => toggleCollapsed(false)}
          className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
        >
          <PanelRightOpen size={15} />
        </button>
        <Code2 size={14} className="text-[var(--cf-text-muted)]" />
        <span className="mt-1 whitespace-nowrap text-[11px] text-[var(--cf-text-muted)] [writing-mode:vertical-rl]">
          {t("api.snippet.title")}
        </span>
      </div>
    );
  }

  return (
    <>
      <ResizeHandle
        axis="x"
        value={width}
        min={MIN_WIDTH}
        max={MAX_WIDTH}
        onChange={(value) => setSize("apiSnippetWidth", value)}
        onCommit={(value) => commitSize("apiSnippetWidth", value)}
        invert
      />
      <div
        style={{ width }}
        className={`flex h-full min-h-0 shrink-0 flex-col overflow-hidden ${CARD}`}
      >
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--cf-border)] px-2 py-1.5">
          <Code2 size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="flex-1 truncate text-[12px] font-medium text-[var(--cf-text)]">
            {t("api.snippet.title")}
          </span>
          <OptionsPopover options={options} onChange={patchOptions} />
          <button
            type="button"
            title={t("api.snippet.collapse")}
            aria-label={t("api.snippet.collapse")}
            onClick={() => toggleCollapsed(true)}
            className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
          >
            <PanelRightClose size={15} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-1.5 px-2 py-1.5">
          <TargetPicker value={target.id} onChange={chooseTarget} />
          <button
            type="button"
            title={t("api.snippet.copy")}
            aria-label={t("api.snippet.copy")}
            disabled={!code}
            onClick={copy}
            className={`shrink-0 rounded p-1.5 disabled:cursor-not-allowed disabled:opacity-40 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
              copied ? "text-[var(--cf-success)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            }`}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          {copied && <span className="shrink-0 text-[11px] text-[var(--cf-success)]">{t("api.snippet.copied")}</span>}
        </div>

        <div className="min-h-0 flex-1">
          {error !== null ? (
            <p className="p-3 text-[12px] text-[var(--cf-danger)]">{t("api.snippet.failed", { error })}</p>
          ) : code === null ? null : code === "" ? (
            <p className="p-3 text-[12px] text-[var(--cf-text-muted)]">{t("api.snippet.unsupported")}</p>
          ) : (
            <Editor
              height="100%"
              path={`inmemory://api-snippet/${tabId}`}
              language={target.language}
              value={code}
              theme={monacoTheme}
              options={{
            ...OVERFLOW_SAFE_OPTIONS,
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "off",
                automaticLayout: true,
                scrollBeyondLastLine: false,
                renderLineHighlight: "none",
                wordWrap: "on",
                contextmenu: false,
                scrollbar: { alwaysConsumeMouseWheel: false },
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}

function OptionsPopover({
  options,
  onChange,
}: {
  options: SnippetOptions;
  onChange: (patch: Partial<SnippetOptions>) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const indentId = options.indentWith === "\t" ? "tab" : options.indentWith === "    " ? "4" : "2";

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        title={t("api.snippet.settings")}
        aria-label={t("api.snippet.settings")}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={`rounded p-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
          open ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        }`}
      >
        <Settings2 size={15} />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-56 space-y-2.5 rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-2.5 shadow-[var(--cf-shadow)]">
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]">
            <Checkbox checked={options.multiline} onChange={(multiline) => onChange({ multiline })} />
            {t("api.snippet.multiline")}
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]">
            <Checkbox
              checked={options.includeBoilerplate}
              onChange={(includeBoilerplate) => onChange({ includeBoilerplate })}
            />
            {t("api.snippet.boilerplate")}
          </label>
          <div className="space-y-1">
            <span className="text-[11px] text-[var(--cf-text-muted)]">{t("api.snippet.indent")}</span>
            <Select
              size="sm"
              value={indentId}
              ariaLabel={t("api.snippet.indent")}
              onChange={(id) => onChange({ indentWith: INDENT_VALUES[id] ?? "  " })}
              options={[
                { value: "2", label: t("api.snippet.indent2") },
                { value: "4", label: t("api.snippet.indent4") },
                { value: "tab", label: t("api.snippet.indentTab") },
              ]}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The language picker. Not the shared `Select`: this list is ~35 entries across ~20 groups, which
 * is exactly the size where scrolling stops working and typing has to. The trigger, the menu and
 * the checked row are styled to match `Select` so the two read as one control.
 */
function TargetPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  const matches = useMemo(() => filterTargets(query), [query]);
  const groups = useMemo(() => groupTargets(matches), [matches]);
  const selected = SNIPPET_TARGETS.find((candidate) => candidate.id === value);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({
      left: rect.left,
      top: rect.bottom + 4,
      width: rect.width,
      maxHeight: Math.max(160, window.innerHeight - rect.bottom - 16),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const onScroll = () => reposition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const node = e.target as Node;
      if (triggerRef.current?.contains(node) || menuRef.current?.contains(node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open || matches.length === 0) return;
    menuRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, matches.length]);

  const openMenu = () => {
    setQuery("");
    setActiveIndex(Math.max(0, SNIPPET_TARGETS.findIndex((candidate) => candidate.id === value)));
    setOpen(true);
  };

  const commit = (id: string) => {
    onChange(id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActiveIndex((index) => (matches.length === 0 ? 0 : (index + 1) % matches.length));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActiveIndex((index) => (matches.length === 0 ? 0 : (index - 1 + matches.length) % matches.length));
        break;
      case "Enter":
        e.preventDefault();
        if (matches[activeIndex]) commit(matches[activeIndex].id);
        break;
      case "Escape":
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
    }
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={`flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border bg-[var(--cf-surface)] px-2 py-1 text-left text-[12px] outline-none ${
          open ? "border-[var(--cf-accent)]" : "border-[var(--cf-border)] focus:border-[var(--cf-accent)]"
        }`}
      >
        <span className="truncate text-[var(--cf-text)]">{selected?.label ?? ""}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-[var(--cf-text-muted)] transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
            className="z-[9999] flex flex-col overflow-hidden rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] shadow-[var(--cf-shadow)]"
          >
            <input
              autoFocus
              value={query}
              placeholder={t("api.snippet.filter")}
              aria-label={t("api.snippet.filter")}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onKeyDown}
              className="shrink-0 border-b border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-muted)]"
            />
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {matches.length === 0 ? (
                <p className="px-2 py-3 text-center text-[12px] text-[var(--cf-text-muted)]">
                  {t("api.snippet.noResults")}
                </p>
              ) : (
                groups.map(([group, targets]) => (
                  <div key={group}>
                    <div className="px-2 pb-0.5 pt-2 text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
                      {group}
                    </div>
                    {targets.map((item) => {
                      // Keyboard navigation walks `matches`, so the row's index must come from
                      // `matches` too — grouping is a display concern and may reorder.
                      const flatIndex = matches.indexOf(item);
                      const isActive = flatIndex === activeIndex;
                      const isSelected = item.id === value;
                      return (
                        <div
                          key={item.id}
                          role="option"
                          aria-selected={isSelected}
                          data-index={flatIndex}
                          onMouseEnter={() => setActiveIndex(flatIndex)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => commit(item.id)}
                          className={`flex cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-[12px] ${
                            isSelected ? "font-medium text-[var(--cf-accent)]" : "text-[var(--cf-text)]"
                          } ${isActive ? "bg-[color-mix(in_oklab,var(--cf-accent)_16%,transparent)]" : ""}`}
                        >
                          <span className="truncate">{item.label}</span>
                          {isSelected && <Check size={13} className="shrink-0 text-[var(--cf-accent)]" />}
                        </div>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/** Every whitespace-separated term has to appear, so "node ax" finds "NodeJs - Axios". */
function filterTargets(query: string): SnippetTarget[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return SNIPPET_TARGETS;
  return SNIPPET_TARGETS.filter((target) => {
    const haystack = `${target.group} ${target.label}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Groups in the order `SNIPPET_TARGETS` lists them, which is the order the picker should show. */
function groupTargets(targets: SnippetTarget[]): [string, SnippetTarget[]][] {
  const groups = new Map<string, SnippetTarget[]>();
  for (const target of targets) {
    const existing = groups.get(target.group);
    if (existing) existing.push(target);
    else groups.set(target.group, [target]);
  }
  return [...groups.entries()];
}
