import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileText,
  FolderOpen,
  MessageSquareText,
  MousePointerClick,
  Play,
  Plus,
  Search,
  SquareTerminal,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { open as pickPath } from "@tauri-apps/plugin-dialog";
import { Button, iconButtonClass } from "../common/Button";
import { Select, type SelectItems, type SelectOption } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { AiGlyph } from "../common/AiGlyph";
import { chipClass, fieldClass } from "../common/recipes";
import {
  codiActionCatalog,
  codiInstalledApps,
  codiRoutines,
  codiRunRoutine,
  codiSetRoutines,
  type CodiActionSpec,
  type CodiRoutine,
  type CodiRoutineStep,
} from "../../lib/tauri/codiCommands";
import type { ParamSchema } from "../../lib/codi/registry";
import type { TranslationKey } from "../../lib/i18n/translations";
import { confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { useLanguageStore, useT } from "../../state/languageStore";

/**
 * «Rutinas»: the sentences Codi runs without thinking (`codi::routines`) — «Codi, el tiempo» searches
 * the weather in San Miguel and reads it. Each routine is its sentences (one a line, `{lugar}` taking
 * the words said there), its blanks' defaults and its steps, saved as they are edited.
 *
 * Every step says what it does and who does it (the user, 2026-10-22: «que diga para qué es cada
 * paso y quién lo ejecuta y cómo»): Codi alone, the same way every time, or a model — only the
 * answer, and the summary Codi adds at the end when something was read and nothing answered it.
 * What a step needs is picked rather than typed: an installed app, one of Codi's actions with its
 * own fields, a folder.
 */

type Kind = CodiRoutineStep["kind"];

const KINDS: { kind: Kind; icon: LucideIcon; label: TranslationKey; what: TranslationKey; field: TranslationKey; ai?: true }[] = [
  { kind: "search", icon: Search, label: "codi.routines.kind.search", what: "codi.routines.what.search", field: "codi.routines.field.search" },
  { kind: "read", icon: FileText, label: "codi.routines.kind.read", what: "codi.routines.what.read", field: "codi.routines.field.read" },
  { kind: "readApp", icon: AppWindow, label: "codi.routines.kind.readApp", what: "codi.routines.what.readApp", field: "codi.routines.field.readApp" },
  { kind: "open", icon: ExternalLink, label: "codi.routines.kind.open", what: "codi.routines.what.open", field: "codi.routines.field.open" },
  { kind: "say", icon: MessageSquareText, label: "codi.routines.kind.say", what: "codi.routines.what.say", field: "codi.routines.field.say" },
  { kind: "command", icon: SquareTerminal, label: "codi.routines.kind.command", what: "codi.routines.what.command", field: "codi.routines.field.command" },
  { kind: "action", icon: MousePointerClick, label: "codi.routines.kind.action", what: "codi.routines.what.action", field: "codi.routines.field.action" },
  { kind: "answer", icon: MessageSquareText, label: "codi.routines.kind.answer", what: "codi.routines.what.answer", field: "codi.routines.field.answer", ai: true },
];

/** The steps whose text an answer reads (`Step::reads` in `routines.rs`). */
const READS: readonly Kind[] = ["search", "read", "readApp", "command"];

/** The one text a step is mostly made of, and how it is written back. */
function mainText(step: CodiRoutineStep): string {
  switch (step.kind) {
    case "search":
      return step.query;
    case "read":
      return step.url;
    case "readApp":
      return step.app;
    case "open":
      return step.target;
    case "say":
      return step.text;
    case "command":
      return step.command;
    case "action":
      return step.action;
    case "answer":
      return step.instruction;
  }
}

function withMain(step: CodiRoutineStep, value: string): CodiRoutineStep {
  switch (step.kind) {
    case "search":
      return { ...step, query: value };
    case "read":
      return { ...step, url: value };
    case "readApp":
      return { ...step, app: value };
    case "open":
      return { ...step, target: value };
    case "say":
      return { ...step, text: value };
    case "command":
      return { ...step, command: value };
    case "action":
      return { ...step, action: value };
    case "answer":
      return { ...step, instruction: value };
  }
}

function emptyStep(kind: Kind, carry = ""): CodiRoutineStep {
  // An action id is no text to carry into another kind, nor another kind's text an action id.
  const text = kind === "action" ? "" : carry;
  return withMain(
    kind === "search"
      ? { kind, query: "", pages: 2 }
      : kind === "command"
        ? { kind, command: "", cwd: "" }
        : kind === "action"
          ? { kind, action: "", params: {} }
          : ({ kind, [{ read: "url", readApp: "app", open: "target", say: "text", answer: "instruction" }[kind]]: "" } as CodiRoutineStep),
    text,
  );
}

/** The `{slots}` a routine's sentences name, in order. */
export function slotsOf(phrases: string[]): string[] {
  const found: string[] = [];
  for (const phrase of phrases) {
    for (const match of phrase.matchAll(/\{\s*([^{}]+?)\s*\}/g)) {
      if (!found.includes(match[1])) found.push(match[1]);
    }
  }
  return found;
}

/**
 * Whether Codi adds a summary of its own at the end: something was read after the last answer
 * (`unread` in `routines.rs`). Shown as a step of its own, so the model it uses is never a surprise.
 */
export function summarisedAtTheEnd(steps: CodiRoutineStep[]): boolean {
  let unread = false;
  for (const step of steps) {
    if (!mainText(step).trim()) continue;
    if (step.kind === "answer") unread = false;
    else if (READS.includes(step.kind)) unread = true;
  }
  return unread;
}

const newId = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

export function CodiRoutines() {
  const t = useT();
  const [routines, setRoutines] = useState<CodiRoutine[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tried, setTried] = useState<Record<string, { running: boolean; said?: string; error?: string }>>({});
  const [apps, setApps] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<CodiActionSpec[] | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void codiRoutines()
      .then(setRoutines)
      .catch((error) => pushErrorToast(String(error)));
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // What the pickers offer, asked for once a routine is open: listing the installed apps reads the
  // disk (or asks PowerShell), which a closed list never needs.
  const wantsLists = open !== null;
  useEffect(() => {
    if (!wantsLists) return;
    if (apps.length === 0) void codiInstalledApps().then(setApps).catch(() => setApps([]));
    if (catalog === null) void codiActionCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, [wantsLists, apps.length, catalog]);

  const change = (next: CodiRoutine[]) => {
    setRoutines(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    // Saved once typing stops, and only when complete enough to start: a routine half written is
    // kept on screen, not refused mid-word.
    saveTimer.current = setTimeout(() => {
      const ready = next.filter((r) => r.name.trim() && r.phrases.some((p) => p.trim()) && r.steps.length > 0);
      void codiSetRoutines(ready).catch((error) => pushErrorToast(String(error)));
    }, 600);
  };
  const update = (id: string, patch: (routine: CodiRoutine) => CodiRoutine) => routines && change(routines.map((r) => (r.id === id ? patch(r) : r)));

  const add = () => {
    if (!routines) return;
    const routine: CodiRoutine = { id: newId(), name: "", phrases: [], defaults: {}, steps: [emptyStep("search")], enabled: true };
    setRoutines([...routines, routine]);
    setOpen(routine.id);
  };

  const remove = async (routine: CodiRoutine) => {
    if (!routines) return;
    if (!(await confirmAction(t("codi.routines.deleteConfirm", { name: routine.name || t("codi.routines.untitled") }), true, t("common.delete")))) return;
    change(routines.filter((r) => r.id !== routine.id));
  };

  const tryIt = async (routine: CodiRoutine) => {
    setTried((s) => ({ ...s, [routine.id]: { running: true } }));
    try {
      const said = await codiRunRoutine(routine.id);
      setTried((s) => ({ ...s, [routine.id]: { running: false, said } }));
    } catch (error) {
      setTried((s) => ({ ...s, [routine.id]: { running: false, error: String(error) } }));
    }
  };

  if (!routines) return null;

  const addOptions: SelectOption[] = KINDS.map((k) => ({ value: k.kind, label: t(k.label), icon: k.ai ? undefined : k.icon, leading: k.ai ? <AiGlyph size={13} still /> : undefined }));

  return (
    <div className="flex flex-col gap-2">
      <HowItRuns />
      {routines.map((routine) => {
        const expanded = open === routine.id;
        const slots = slotsOf(routine.phrases);
        const outcome = tried[routine.id];
        const setSteps = (steps: CodiRoutineStep[]) => update(routine.id, (r) => ({ ...r, steps }));
        return (
          <div key={routine.id} className="rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)]">
            <div className="flex items-center gap-2 px-2.5 py-1.5">
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                aria-expanded={expanded}
                aria-label={expanded ? t("codi.routines.collapse") : t("codi.routines.expand")}
                onClick={() => setOpen(expanded ? null : routine.id)}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <input
                type="checkbox"
                checked={routine.enabled}
                onChange={(event) => update(routine.id, (r) => ({ ...r, enabled: event.target.checked }))}
                aria-label={t("codi.routines.enabled")}
                className="accent-[var(--cf-accent)]"
              />
              <input
                value={routine.name}
                onChange={(event) => update(routine.id, (r) => ({ ...r, name: event.target.value }))}
                placeholder={t("codi.routines.namePlaceholder")}
                aria-label={t("codi.routines.name")}
                className={fieldClass({ size: "sm", className: "w-[180px] font-medium" })}
              />
              <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]">
                {routine.phrases[0] ? `«Codi, ${routine.phrases[0]}»` : ""}
              </span>
              <Tooltip label={t("codi.routines.try")}>
                <button
                  type="button"
                  className={iconButtonClass({ size: "sm" })}
                  aria-label={t("codi.routines.try")}
                  disabled={outcome?.running || routine.steps.length === 0}
                  onClick={() => void tryIt(routine)}
                >
                  <Play size={13} />
                </button>
              </Tooltip>
              <Tooltip label={t("common.delete")}>
                <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("common.delete")} onClick={() => void remove(routine)}>
                  <Trash2 size={13} />
                </button>
              </Tooltip>
            </div>
            {outcome && (outcome.running || outcome.said || outcome.error) && (
              <p className={`px-3 pb-2 text-[11.5px] leading-snug ${outcome.error ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>
                {outcome.running ? t("codi.routines.running") : (outcome.error ?? outcome.said)}
              </p>
            )}
            {expanded && (
              <div className="flex flex-col gap-3 border-t border-[var(--cf-border)] px-3 py-2.5">
                <label className="flex flex-col gap-1">
                  <span className="text-[11.5px] font-medium text-[var(--cf-text)]">{t("codi.routines.phrases")}</span>
                  <textarea
                    value={routine.phrases.join("\n")}
                    onChange={(event) => update(routine.id, (r) => ({ ...r, phrases: event.target.value.split("\n") }))}
                    onBlur={() => update(routine.id, (r) => ({ ...r, phrases: r.phrases.map((p) => p.trim()).filter(Boolean) }))}
                    rows={Math.min(6, Math.max(2, routine.phrases.length))}
                    placeholder={t("codi.routines.phrasesPlaceholder")}
                    className="min-h-[52px] resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
                  />
                  <span className="text-[11px] text-[var(--cf-text-muted)]">{t("codi.routines.phrasesHint")}</span>
                </label>
                {slots.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {slots.map((slot) => (
                        <label key={slot} className="flex items-center gap-1.5 text-[11.5px] text-[var(--cf-text-muted)]">
                          <code className="text-[var(--cf-text)]">{`{${slot}}`}</code>
                          <input
                            value={routine.defaults[slot] ?? ""}
                            onChange={(event) => update(routine.id, (r) => ({ ...r, defaults: { ...r.defaults, [slot]: event.target.value } }))}
                            placeholder={t("codi.routines.defaultPlaceholder")}
                            aria-label={t("codi.routines.defaultFor", { slot })}
                            className={fieldClass({ size: "sm", className: "w-[170px]" })}
                          />
                        </label>
                      ))}
                    </div>
                    <span className="text-[11px] text-[var(--cf-text-muted)]">{t("codi.routines.slotsHint", { slot: `{${slots[0]}}` })}</span>
                  </div>
                )}
                <div className="flex flex-col gap-1.5">
                  <span className="text-[11.5px] font-medium text-[var(--cf-text)]">{t("codi.routines.steps")}</span>
                  {routine.steps.map((step, index) => (
                    <StepCard
                      key={index}
                      index={index}
                      step={step}
                      apps={apps}
                      catalog={catalog}
                      first={index === 0}
                      last={index === routine.steps.length - 1}
                      onChange={(next) => setSteps(routine.steps.map((s, i) => (i === index ? next : s)))}
                      onRemove={() => setSteps(routine.steps.filter((_, i) => i !== index))}
                      onMove={(by) => {
                        const steps = [...routine.steps];
                        const [moved] = steps.splice(index, 1);
                        steps.splice(index + by, 0, moved);
                        setSteps(steps);
                      }}
                    />
                  ))}
                  {summarisedAtTheEnd(routine.steps) && (
                    <div className="flex items-start gap-2 rounded-md border border-dashed border-[var(--cf-border)] px-2.5 py-2">
                      <span className="mt-[1px] w-4 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">+</span>
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[12px] font-medium text-[var(--cf-text)]">{t("codi.routines.summaryStep")}</span>
                          <WhoRuns ai />
                        </div>
                        <span className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("codi.routines.summaryWhat")}</span>
                      </div>
                    </div>
                  )}
                  <div className="w-[220px]">
                    <Select
                      size="sm"
                      value=""
                      placeholder={t("codi.routines.addStep")}
                      onChange={(kind) => setSteps([...routine.steps, emptyStep(kind as Kind)])}
                      options={addOptions}
                      ariaLabel={t("codi.routines.addStep")}
                    />
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div>
        <Button size="sm" onClick={add}>
          <Plus size={13} />
          {t("codi.routines.add")}
        </Button>
      </div>
    </div>
  );
}

/** Why some steps use a model and the rest do not — the question the list raises (2026-10-22). */
function HowItRuns() {
  const t = useT();
  return (
    <div className="mb-1 grid gap-2 sm:grid-cols-2">
      <div className="rounded-md border border-[var(--cf-border)] px-3 py-2">
        <WhoRuns />
        <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("codi.routines.noAiWhy")}</p>
      </div>
      <div className="rounded-md border border-[var(--cf-border)] px-3 py-2">
        <WhoRuns ai />
        <p className="mt-1.5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t("codi.routines.aiWhy")}</p>
      </div>
    </div>
  );
}

function WhoRuns({ ai = false }: { ai?: boolean }) {
  const t = useT();
  return ai ? (
    <span className={chipClass("accent")}>
      <AiGlyph size={11} still />
      {t("codi.routines.byModel")}
    </span>
  ) : (
    <span className={chipClass("neutral")}>{t("codi.routines.byCodi")}</span>
  );
}

function StepCard({
  index,
  step,
  apps,
  catalog,
  first,
  last,
  onChange,
  onRemove,
  onMove,
}: {
  index: number;
  step: CodiRoutineStep;
  apps: string[];
  catalog: CodiActionSpec[] | null;
  first: boolean;
  last: boolean;
  onChange: (step: CodiRoutineStep) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const t = useT();
  const meta = KINDS.find((k) => k.kind === step.kind)!;
  const kindOptions: SelectOption[] = KINDS.map((k) => ({ value: k.kind, label: t(k.label), icon: k.ai ? undefined : k.icon, leading: k.ai ? <AiGlyph size={13} still /> : undefined }));
  const blank = !mainText(step).trim();
  const main = (className = "min-w-[200px] flex-1") => (
    <input
      value={mainText(step)}
      onChange={(event) => onChange(withMain(step, event.target.value))}
      placeholder={t(meta.field)}
      aria-label={t(meta.field)}
      className={fieldClass({ size: "sm", className })}
    />
  );

  let fields: ReactNode;
  switch (step.kind) {
    case "search":
      fields = (
        <>
          {main()}
          <div className="w-[130px]">
            <Select
              size="sm"
              value={String(step.pages ?? 2)}
              onChange={(pages) => onChange({ ...step, pages: Number(pages) })}
              options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: t("codi.routines.pages", { n }) }))}
              ariaLabel={t("codi.routines.pagesLabel")}
            />
          </div>
        </>
      );
      break;
    case "readApp":
    case "open":
      fields = (
        <>
          <Suggest
            value={mainText(step)}
            onChange={(value) => onChange(withMain(step, value))}
            suggestions={apps}
            placeholder={t(meta.field)}
            ariaLabel={t(meta.field)}
          />
          {step.kind === "open" && (
            <Tooltip label={t("codi.routines.pickFile")}>
              <button
                type="button"
                className={iconButtonClass({ size: "sm" })}
                aria-label={t("codi.routines.pickFile")}
                onClick={() =>
                  void pickPath({ directory: false, multiple: false }).then((picked) => typeof picked === "string" && onChange(withMain(step, picked)))
                }
              >
                <FolderOpen size={13} />
              </button>
            </Tooltip>
          )}
        </>
      );
      break;
    case "command":
      fields = (
        <>
          {main("min-w-[200px] flex-1 font-mono")}
          <FolderField value={step.cwd ?? ""} onChange={(cwd) => onChange({ ...step, cwd })} />
        </>
      );
      break;
    case "action":
      fields = <ActionFields step={step} catalog={catalog} onChange={onChange} />;
      break;
    case "answer":
      fields = (
        <textarea
          value={step.instruction}
          onChange={(event) => onChange({ ...step, instruction: event.target.value })}
          placeholder={t(meta.field)}
          aria-label={t(meta.field)}
          rows={2}
          className="min-h-[44px] min-w-[200px] flex-1 resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
        />
      );
      break;
    default:
      fields = main();
  }

  return (
    <div className="flex items-start gap-2 rounded-md border border-[var(--cf-border)] px-2.5 py-2">
      <span className="mt-[5px] w-4 text-right text-[11px] tabular-nums text-[var(--cf-text-faint)]">{index + 1}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-[190px]">
            <Select size="sm" value={step.kind} onChange={(kind) => onChange(emptyStep(kind as Kind, mainText(step)))} options={kindOptions} ariaLabel={t("codi.routines.stepKind")} />
          </div>
          <WhoRuns ai={meta.ai} />
          {blank && <span className={chipClass("warn")}>{t("codi.routines.incomplete")}</span>}
          <span className="flex-1" />
          <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("codi.routines.moveUp")} disabled={first} onClick={() => onMove(-1)}>
            <ArrowUp size={13} />
          </button>
          <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("codi.routines.moveDown")} disabled={last} onClick={() => onMove(1)}>
            <ArrowDown size={13} />
          </button>
          <button type="button" className={iconButtonClass({ size: "sm" })} aria-label={t("codi.routines.removeStep")} onClick={onRemove}>
            <X size={13} />
          </button>
        </div>
        <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{t(meta.what)}</p>
        <div className="flex flex-wrap items-start gap-1.5">{fields}</div>
      </div>
    </div>
  );
}

/** A text field that offers what it can be — the installed apps — and still takes anything typed
 *  (an address, a path, a `{slot}`). */
function Suggest({
  value,
  onChange,
  suggestions,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  placeholder: string;
  ariaLabel: string;
}) {
  const [shown, setShown] = useState(false);
  const [active, setActive] = useState(0);
  const matches = useMemo(() => {
    const wanted = fold(value.trim());
    const all = wanted ? suggestions.filter((s) => fold(s).includes(wanted) && s !== value) : suggestions;
    return all.slice(0, 8);
  }, [suggestions, value]);
  const pick = (name: string) => {
    onChange(name);
    setShown(false);
  };
  return (
    <div className="relative min-w-[200px] flex-1">
      <input
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          setShown(true);
          setActive(0);
        }}
        onFocus={() => setShown(true)}
        // Late enough for a click on a suggestion to land first.
        onBlur={() => setTimeout(() => setShown(false), 120)}
        onKeyDown={(event) => {
          if (!shown || matches.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setActive((i) => (i + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
          } else if (event.key === "Enter") {
            event.preventDefault();
            pick(matches[Math.min(active, matches.length - 1)]);
          } else if (event.key === "Escape") {
            setShown(false);
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-autocomplete="list"
        className={fieldClass({ size: "sm", className: "w-full" })}
      />
      {shown && matches.length > 0 && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-30 mt-1 max-h-[220px] overflow-y-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-raised)] p-[5px] shadow-[var(--cf-shadow)]"
        >
          {matches.map((name, i) => (
            <li key={name}>
              <button
                type="button"
                role="option"
                aria-selected={i === active}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(name)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] text-[var(--cf-text)] ${i === active ? "bg-[var(--cf-hover)]" : ""}`}
              >
                <AppWindow size={12} className="shrink-0 text-[var(--cf-text-muted)]" />
                <span className="truncate">{name}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Where a command runs: typed, or picked from the system's folder dialog; empty is the home folder. */
function FolderField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useT();
  return (
    <div className="flex min-w-[200px] flex-1 items-center gap-1">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("codi.routines.field.cwd")}
        aria-label={t("codi.routines.field.cwdLabel")}
        className={fieldClass({ size: "sm", className: "min-w-0 flex-1" })}
      />
      <Tooltip label={t("codi.routines.pickFolder")}>
        <button
          type="button"
          className={iconButtonClass({ size: "sm" })}
          aria-label={t("codi.routines.pickFolder")}
          onClick={() => void pickPath({ directory: true, multiple: false }).then((picked) => typeof picked === "string" && onChange(picked))}
        >
          <FolderOpen size={13} />
        </button>
      </Tooltip>
    </div>
  );
}

/** One of Codi's actions, picked from what it can do now, and a field for each thing it takes. */
function ActionFields({
  step,
  catalog,
  onChange,
}: {
  step: Extract<CodiRoutineStep, { kind: "action" }>;
  catalog: CodiActionSpec[] | null;
  onChange: (step: CodiRoutineStep) => void;
}) {
  const t = useT();
  const language = useLanguageStore((s) => s.language) === "es" ? "es" : "en";
  // A routine never starts a routine (`routines.rs` refuses it): not offered.
  const usable = useMemo(() => (catalog ?? []).filter((a) => !a.id.startsWith("routine.")), [catalog]);
  const title = (a: CodiActionSpec) => a.title[language] || a.title.en || a.id;
  const options: SelectItems = useMemo(() => {
    const outside = usable.filter((a) => a.where === "native");
    const inside = usable.filter((a) => a.where !== "native");
    const sorted = (list: CodiActionSpec[]) => [...list].sort((a, b) => title(a).localeCompare(title(b))).map((a) => ({ value: a.id, label: title(a) }));
    return [
      { label: t("codi.routines.actionsOutside"), options: sorted(outside) },
      { label: t("codi.routines.actionsInside"), options: sorted(inside) },
    ].filter((group) => group.options.length > 0);
    // `title` reads `language`, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usable, language, t]);
  const spec = usable.find((a) => a.id === step.action);
  const params = step.params ?? {};
  const setParam = (key: string, value: unknown) => {
    const next = { ...params };
    if (value === "" || value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...step, params: next });
  };
  const schema = (spec?.params ?? {}) as ParamSchema;
  const required = new Set(schema.required ?? []);
  const properties = Object.entries(schema.properties ?? {}).filter(([key]) => key !== "confirmed");

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="min-w-[220px] max-w-[420px]">
        <Select
          size="sm"
          value={step.action}
          loading={catalog === null}
          placeholder={t("codi.routines.field.action")}
          // A new action's fields are its own; the last one's would only be refused.
          onChange={(action) => onChange({ ...step, action, params: {} })}
          options={step.action && !spec ? [{ value: step.action, label: step.action }, ...options] : options}
          ariaLabel={t("codi.routines.field.action")}
        />
      </div>
      {properties.length > 0 && (
        <div className="flex flex-col gap-1">
          {properties.map(([key, prop]) => {
            const names = spec?.vocabulary?.[key];
            const label = (
              <span className="w-[120px] shrink-0 truncate text-[11.5px] text-[var(--cf-text-muted)]" title={prop.description}>
                {key}
                {required.has(key) ? " *" : ""}
              </span>
            );
            const current = params[key];
            let input: ReactNode;
            if (prop.enum) {
              input = (
                <div className="min-w-[180px] max-w-[300px] flex-1">
                  <Select
                    size="sm"
                    value={current === undefined ? "" : String(current)}
                    placeholder={required.has(key) ? t("codi.routines.choose") : t("codi.routines.optional")}
                    onChange={(value) => setParam(key, value)}
                    options={prop.enum.map((value) => ({ value: String(value), label: names?.[String(value)]?.[language]?.[0] ?? String(value) }))}
                    ariaLabel={key}
                  />
                </div>
              );
            } else if (prop.type === "boolean") {
              input = <input type="checkbox" checked={current === true} onChange={(event) => setParam(key, event.target.checked || undefined)} aria-label={key} className="accent-[var(--cf-accent)]" />;
            } else {
              const numeric = prop.type === "number" || prop.type === "integer";
              input = (
                <input
                  value={current === undefined ? "" : String(current)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    // A `{slot}` stays text; Codi fills it in before the action runs.
                    setParam(key, numeric && raw.trim() !== "" && !raw.includes("{") && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
                  }}
                  placeholder={prop.description ?? (required.has(key) ? "" : t("codi.routines.optional"))}
                  aria-label={key}
                  className={fieldClass({ size: "sm", className: "min-w-[180px] flex-1" })}
                />
              );
            }
            return (
              <label key={key} className="flex flex-wrap items-center gap-2">
                {label}
                {input}
              </label>
            );
          })}
        </div>
      )}
      {spec && spec.risk === "destructive" && <span className="text-[11px] text-[var(--cf-warning)]">{t("codi.routines.actionConfirms")}</span>}
    </div>
  );
}
