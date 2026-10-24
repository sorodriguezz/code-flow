/** «Texto»: case, counter, lines, escaping, lorem ipsum, slugs, the inspector and the regex tester. */
import { useEffect, useMemo, useRef, useState } from "react";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import {
  CASE_STYLES,
  convertCase,
  escapeText,
  ESCAPE_KINDS,
  inspectChars,
  lorem,
  processLines,
  revealInvisibles,
  slugify,
  textStats,
  unescapeText,
  type CaseStyle,
  type EscapeKind,
  type LineOptions,
} from "../../lib/toolbox/text";
import type { RegexResult } from "../../lib/toolbox/regex";
import type { RegexRequest } from "../../lib/toolbox/regexWorker";
import { attempt, CopyButton, ErrorLine, FactTable, Labeled, OptionsRow, PaneHead, paneClass, smallInput, Split, TextPane } from "./kit";
import { CheckLabel } from "./EncodeTools";
import { TwoWayTool, type Direction } from "./TwoWay";

const CASE_LABEL: Record<CaseStyle, string> = {
  camel: "camelCase",
  pascal: "PascalCase",
  snake: "snake_case",
  constant: "CONSTANT_CASE",
  kebab: "kebab-case",
  train: "Train-Case",
  dot: "dot.case",
  title: "Title Case",
  sentence: "Sentence case",
  lower: "lower case",
  upper: "UPPER CASE",
};

export function CaseTool() {
  const t = useT();
  const [input, setInput] = useToolField("case", "input", "");
  return (
    <>
      <TextPane className="max-h-48 shrink-0" label={t("toolbox.input")} value={input} onChange={setInput} placeholder="getUserById · user_name · HTTP server error" />
      <FactTable className="flex-1" rows={CASE_STYLES.map((s) => [CASE_LABEL[s], input ? convertCase(input, s) : ""])} />
    </>
  );
}

export function CountTool() {
  const t = useT();
  const [input, setInput] = useToolField("count", "input", "");
  const s = useMemo(() => textStats(input), [input]);
  const n = (v: number) => v.toLocaleString();
  return (
    <Split>
      <TextPane label={t("toolbox.input")} value={input} onChange={setInput} />
      <FactTable
        rows={[
          [t("toolbox.count.characters"), n(s.characters)],
          [t("toolbox.count.graphemes"), n(s.graphemes)],
          [t("toolbox.count.codePoints"), n(s.codePoints)],
          [t("toolbox.count.words"), n(s.words)],
          [t("toolbox.count.lines"), n(s.lines)],
          [t("toolbox.count.paragraphs"), n(s.paragraphs)],
          [t("toolbox.count.bytesUtf8"), n(s.bytesUtf8)],
          [t("toolbox.count.bytesUtf16"), n(s.bytesUtf16)],
          [t("toolbox.count.reading"), t("toolbox.count.minutes", { count: Math.max(s.words ? 1 : 0, Math.round(s.readingMinutes)) })],
        ]}
      />
    </Split>
  );
}

export function LinesTool() {
  const t = useT();
  const [input, setInput] = useToolField("lines", "input", "");
  const [o, setO] = useToolField<LineOptions>("lines", "options", { sort: "asc", dedupe: true, caseInsensitive: false, trim: true, removeEmpty: true });
  const [seed, setSeed] = useState(0);
  const output = useMemo(() => processLines(input, o), [input, o, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const before = input ? input.split(/\r?\n/).length : 0;
  const after = output ? output.split("\n").length : 0;
  const set = (patch: Partial<LineOptions>) => setO({ ...o, ...patch });
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.lines.order")}>
          <Select
            size="compact"
            value={o.sort}
            onChange={(v) => set({ sort: v as LineOptions["sort"] })}
            options={(["none", "asc", "desc", "natural", "length", "reverse", "shuffle"] as const).map((v) => ({ value: v, label: t(`toolbox.lines.sort.${v}`) }))}
          />
        </Labeled>
        {o.sort === "shuffle" ? (
          <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => setSeed(seed + 1)}>
            {t("toolbox.again")}
          </button>
        ) : null}
        <CheckLabel checked={o.dedupe} onChange={(v) => set({ dedupe: v })} label={t("toolbox.lines.dedupe")} />
        <CheckLabel checked={o.caseInsensitive} onChange={(v) => set({ caseInsensitive: v })} label={t("toolbox.lines.ignoreCase")} />
        <CheckLabel checked={o.trim} onChange={(v) => set({ trim: v })} label={t("toolbox.lines.trim")} />
        <CheckLabel checked={o.removeEmpty} onChange={(v) => set({ removeEmpty: v })} label={t("toolbox.lines.removeEmpty")} />
        {input ? <span className={chipClass("neutral")}>{t("toolbox.lines.count", { before, after })}</span> : null}
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} wrap={false} />
        <TextPane label={t("toolbox.output")} value={output} wrap={false} />
      </Split>
    </>
  );
}

const ESCAPE_LABEL: Record<EscapeKind, string> = {
  json: "JSON string",
  regex: "RegExp",
  sql: "SQL '…'",
  shell: "Shell '…'",
  csharp: "C# / Java \"…\"",
  xml: "XML",
};

export function EscapeTool() {
  const t = useT();
  const [kind, setKind] = useToolField<EscapeKind>("escape", "kind", "json");
  const run = useMemo(() => (input: string, d: Direction) => (d === "encode" ? escapeText(input, kind) : unescapeText(input, kind)), [kind]);
  return (
    <TwoWayTool
      tool="escape"
      run={run}
      labels={["toolbox.escape", "toolbox.unescape"]}
      sample={'Dijo "hola"\n\tC:\\ruta\\archivo — it\'s ok'}
      options={
        <Labeled label={t("toolbox.format")}>
          <Select size="compact" value={kind} onChange={(v) => setKind(v as EscapeKind)} options={ESCAPE_KINDS.map((k) => ({ value: k, label: ESCAPE_LABEL[k] }))} />
        </Labeled>
      }
    />
  );
}

export function LoremTool() {
  const t = useT();
  const [count, setCount] = useToolField("lorem", "count", 3);
  const [unit, setUnit] = useToolField<"words" | "sentences" | "paragraphs">("lorem", "unit", "paragraphs");
  const [classic, setClassic] = useToolField("lorem", "classic", true);
  const [seed, setSeed] = useState(0);
  const text = useMemo(() => lorem(Math.min(Math.max(1, count), 500), unit, classic), [count, unit, classic, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <OptionsRow>
        <input type="number" min={1} max={500} className={`${smallInput} w-20`} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        <Segmented
          layoutId="toolbox-lorem-unit"
          size="sm"
          value={unit}
          onChange={setUnit}
          options={[
            { value: "words", label: t("toolbox.lorem.words") },
            { value: "sentences", label: t("toolbox.lorem.sentences") },
            { value: "paragraphs", label: t("toolbox.lorem.paragraphs") },
          ]}
        />
        <CheckLabel checked={classic} onChange={setClassic} label={t("toolbox.lorem.classic")} />
        <button type="button" className={buttonClass({ size: "sm" })} onClick={() => setSeed(seed + 1)}>
          {t("toolbox.generate")}
        </button>
      </OptionsRow>
      <TextPane className="flex-1" label={t("toolbox.output")} value={text} />
    </>
  );
}

export function SlugTool() {
  const t = useT();
  const [input, setInput] = useToolField("slug", "input", "");
  const [sep, setSep] = useToolField("slug", "sep", "-");
  const [lower, setLower] = useToolField("slug", "lower", true);
  const output = input
    .split(/\r?\n/)
    .map((l) => slugify(l, sep, lower))
    .join("\n");
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.separator")}>
          <Select size="compact" value={sep} onChange={setSep} options={["-", "_", "."].map((v) => ({ value: v, label: v }))} />
        </Labeled>
        <CheckLabel checked={lower} onChange={setLower} label={t("toolbox.slug.lower")} />
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} placeholder="Árbol de decisión: ¿qué hacemos en 2026?" />
        <TextPane label={t("toolbox.output")} value={output} />
      </Split>
    </>
  );
}

export function InspectTool() {
  const t = useT();
  const [input, setInput] = useToolField("inspect", "input", "");
  const chars = useMemo(() => inspectChars(input), [input]);
  const suspicious = chars.filter((c) => c.suspicious).length;
  return (
    <>
      <OptionsRow>
        <span className={chipClass(suspicious ? "warn" : "neutral")}>{t("toolbox.inspect.suspicious", { count: suspicious })}</span>
        <span className={chipClass("neutral")}>{t("toolbox.inspect.chars", { count: chars.length })}</span>
      </OptionsRow>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-3">
          <TextPane label={t("toolbox.input")} value={input} onChange={setInput} />
          <TextPane label={t("toolbox.inspect.revealed")} value={revealInvisibles(input)} />
        </div>
        <div className={paneClass}>
          <PaneHead label={t("toolbox.inspect.codePoints")} />
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-[12px]">
              <tbody>
                {chars.map((c, i) => (
                  <tr key={i} className={`border-b border-[var(--cf-border)] ${c.suspicious ? "bg-[color-mix(in_oklab,var(--cf-warning)_12%,transparent)]" : ""}`}>
                    <td className="w-10 px-3 py-1 text-center font-mono">{c.name ? "·" : c.char}</td>
                    <td className="px-2 py-1 font-mono text-[var(--cf-text-muted)]">{c.label}</td>
                    <td className="px-2 py-1 font-mono text-[var(--cf-text-faint)]">{c.utf8}</td>
                    <td className="px-2 py-1 text-[var(--cf-text)]">{c.name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------------------------

const FLAGS = ["g", "i", "m", "s", "u", "y"] as const;
const CHEATS: [string, string][] = [
  [".", "toolbox.regex.cheat.any"],
  ["\\d \\w \\s", "toolbox.regex.cheat.classes"],
  ["\\D \\W \\S", "toolbox.regex.cheat.negated"],
  ["[abc] [^abc] [a-z]", "toolbox.regex.cheat.set"],
  ["^ $ \\b", "toolbox.regex.cheat.anchors"],
  ["* + ? {2,5}", "toolbox.regex.cheat.quantifiers"],
  ["*? +?", "toolbox.regex.cheat.lazy"],
  ["(…) (?:…)", "toolbox.regex.cheat.groups"],
  ["(?<name>…) \\k<name>", "toolbox.regex.cheat.named"],
  ["a|b", "toolbox.regex.cheat.alternation"],
  ["(?=…) (?!…)", "toolbox.regex.cheat.lookahead"],
  ["(?<=…) (?<!…)", "toolbox.regex.cheat.lookbehind"],
  ["$1 $<name> $&", "toolbox.regex.cheat.replace"],
  ["\\p{L} (u)", "toolbox.regex.cheat.unicode"],
];

const REGEX_TIMEOUT_MS = 1500;

/** Runs a request in a worker, killing and replacing it when a pattern backtracks too long. */
function useRegexWorker(request: Omit<RegexRequest, "id"> | null) {
  const [state, setState] = useState<{ result: RegexResult | null; error: string | null }>({ result: null, error: null });
  const worker = useRef<Worker | null>(null);
  const seq = useRef(0);
  const t = useT();
  useEffect(() => () => worker.current?.terminate(), []);
  useEffect(() => {
    if (!request) {
      setState({ result: null, error: null });
      return;
    }
    const id = ++seq.current;
    const handle = setTimeout(() => {
      if (!worker.current) worker.current = new Worker(new URL("../../lib/toolbox/regexWorker.ts", import.meta.url), { type: "module" });
      const w = worker.current;
      const timeout = setTimeout(() => {
        if (id !== seq.current) return;
        w.terminate();
        worker.current = null;
        setState({ result: null, error: t("toolbox.regex.timeout") });
      }, REGEX_TIMEOUT_MS);
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: RegexResult; error?: string }>) => {
        if (e.data.id !== seq.current) return;
        clearTimeout(timeout);
        setState(e.data.ok ? { result: e.data.result!, error: null } : { result: null, error: e.data.error ?? "" });
      };
      w.postMessage({ id, ...request });
    }, 80);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.pattern, request?.flags, request?.text, request?.replacement]);
  return state;
}

export function RegexTool() {
  const t = useT();
  const [pattern, setPattern] = useToolField("regex", "pattern", "(?<user>[\\w.+-]+)@(?<domain>[\\w-]+(?:\\.[\\w-]+)+)");
  const [flags, setFlags] = useToolField("regex", "flags", "g");
  const [text, setText] = useToolField("regex", "text", "Escribe a ana@example.com o a soporte@example.org.\nNo es correo: arroba@");
  const [replacement, setReplacement] = useToolField("regex", "replacement", "");
  const [view, setView] = useToolField<"matches" | "replace" | "cheats">("regex", "view", "matches");
  const syntax = useMemo(() => (pattern ? attempt(() => new RegExp(pattern, flags)) : { value: null, error: null }), [pattern, flags]);
  const { result, error } = useRegexWorker(pattern && !syntax.error ? { pattern, flags, text, replacement: view === "replace" ? replacement : null } : null);

  // The text with each match marked, built as segments rather than HTML.
  const segments = useMemo(() => {
    if (!result) return [{ text, hit: -1 }];
    const out: { text: string; hit: number }[] = [];
    let pos = 0;
    result.matches.forEach((m, i) => {
      if (m.index > pos) out.push({ text: text.slice(pos, m.index), hit: -1 });
      out.push({ text: text.slice(m.index, m.end) || "​", hit: i });
      pos = m.end;
    });
    if (pos < text.length) out.push({ text: text.slice(pos), hit: -1 });
    return out;
  }, [result, text]);

  return (
    <>
      <OptionsRow>
        <div className="flex min-w-0 flex-1 items-center gap-1 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 font-mono text-[13px] focus-within:border-[var(--cf-accent)]">
          <span className="text-[var(--cf-text-faint)]">/</span>
          <input className="h-[30px] min-w-0 flex-1 bg-transparent text-[var(--cf-text)] outline-none" value={pattern} spellCheck={false} onChange={(e) => setPattern(e.target.value)} aria-label={t("toolbox.regex.pattern")} />
          <span className="text-[var(--cf-text-faint)]">/{flags}</span>
        </div>
        <div className="flex items-center gap-0.5">
          {FLAGS.map((f) => (
            <button
              key={f}
              type="button"
              aria-pressed={flags.includes(f)}
              title={t(`toolbox.regex.flag.${f}`)}
              className={`h-[26px] w-[26px] rounded-md font-mono text-[12px] ${flags.includes(f) ? "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:bg-[var(--cf-hover)]"}`}
              onClick={() => setFlags(flags.includes(f) ? flags.replace(f, "") : FLAGS.filter((x) => x === f || flags.includes(x)).join(""))}
            >
              {f}
            </button>
          ))}
        </div>
        {result ? <span className={chipClass(result.matches.length ? "ok" : "neutral")}>{t("toolbox.matches", { count: result.matches.length + (result.truncated ? "+" : "") })}</span> : null}
      </OptionsRow>
      <ErrorLine error={syntax.error ?? error} />
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-3">
          <TextPane label={t("toolbox.regex.text")} value={text} onChange={setText} />
          <div className={`${paneClass} max-h-[45%]`}>
            <PaneHead label={t("toolbox.regex.highlight")} />
            <pre className="min-h-0 flex-1 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-[1.55] text-[var(--cf-text)]">
              {segments.map((s, i) =>
                s.hit < 0 ? (
                  <span key={i}>{s.text}</span>
                ) : (
                  <mark key={i} className={`rounded-[3px] text-[var(--cf-text)] ${s.hit % 2 ? "bg-[color-mix(in_oklab,var(--cf-blue)_30%,transparent)]" : "bg-[color-mix(in_oklab,var(--cf-accent)_30%,transparent)]"}`}>
                    {s.text}
                  </mark>
                ),
              )}
            </pre>
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          <Segmented
            layoutId="toolbox-regex-view"
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "matches", label: t("toolbox.regex.matchesTab") },
              { value: "replace", label: t("toolbox.regex.replaceTab") },
              { value: "cheats", label: t("toolbox.regex.cheatsTab") },
            ]}
          />
          {view === "matches" ? (
            <div className={`${paneClass} flex-1`}>
              <div className="min-h-0 flex-1 overflow-auto">
                {result?.matches.map((m, i) => (
                  <div key={i} className="border-b border-[var(--cf-border)] px-3 py-2 text-[12px]">
                    <div className="flex items-center gap-2">
                      <span className="text-[var(--cf-text-faint)]">#{i + 1}</span>
                      <span className="min-w-0 flex-1 break-all font-mono text-[var(--cf-text)]">{m.value || "∅"}</span>
                      <span className="font-mono text-[11px] text-[var(--cf-text-faint)]">
                        {m.index}–{m.end}
                      </span>
                      <CopyButton text={m.value} />
                    </div>
                    {m.groups.map((g) => (
                      <div key={g.name} className="mt-1 flex gap-2 pl-6 font-mono text-[11.5px]">
                        <span className="text-[var(--cf-accent)]">{g.name}</span>
                        <span className="break-all text-[var(--cf-text-muted)]">{g.value === undefined ? "undefined" : g.value}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          ) : view === "replace" ? (
            <>
              <input className={`${smallInput} h-[30px] font-mono`} placeholder="$<user> en $<domain>" value={replacement} spellCheck={false} onChange={(e) => setReplacement(e.target.value)} />
              <TextPane className="flex-1" label={t("toolbox.output")} value={result?.replaced ?? ""} />
            </>
          ) : (
            <FactTable className="flex-1" rows={CHEATS.map(([token, key]) => [<code key={token} className="font-mono text-[var(--cf-text)]">{token}</code>, t(key as never)])} />
          )}
        </div>
      </div>
    </>
  );
}
