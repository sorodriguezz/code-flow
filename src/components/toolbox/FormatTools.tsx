/**
 * «Formatear y convertir»: JSON, JSON ↔ YAML ↔ TOML ↔ XML, XML, CSV, JSONPath, SQL, JSON → types,
 * Markdown, query strings and cURL → code.
 *
 * The heavy engines load on first use, not with the toolbox: quicktype (types), sql-formatter and
 * the API client's code generator are each hundreds of kilobytes that most sessions never need.
 */
import { useCallback, useMemo } from "react";
import { CheckCircle2 } from "lucide-react";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { chipClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import { formatJson, minifyJson, parseJson } from "../../lib/toolbox/json";
import { parseToml, stringifyToml } from "../../lib/toolbox/toml";
import { formatXml, jsonToXml, minifyXml, xmlToJson } from "../../lib/toolbox/xml";
import { csvToJson, detectDelimiter, jsonToCsv, jsonToQuery, queryToJson } from "../../lib/toolbox/csv";
import { queryJsonPath } from "../../lib/api/jsonPath";
import { renderMarkdown } from "../../lib/markdown";
import { attempt, Labeled, OptionsRow, PaneHead, paneClass, smallInput, Split, TextPane, useAsyncResult } from "./kit";
import { CheckLabel } from "./EncodeTools";
import { TwoWayTool, type Direction } from "./TwoWay";

const INDENTS = [
  { value: "2", label: "2" },
  { value: "4", label: "4" },
  { value: "tab", label: "Tab" },
];
const indentOf = (v: string): number | "\t" => (v === "tab" ? "\t" : Number(v));

export function JsonTool() {
  const t = useT();
  const [input, setInput] = useToolField("json", "input", "");
  const [mode, setMode] = useToolField<"format" | "minify">("json", "mode", "format");
  const [indent, setIndent] = useToolField("json", "indent", "2");
  const [sort, setSort] = useToolField("json", "sort", false);
  const result = useMemo(
    () => (input.trim() ? attempt(() => (mode === "minify" ? minifyJson(input) : formatJson(input, indentOf(indent), sort))) : { value: "", error: null }),
    [input, mode, indent, sort],
  );
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-json-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "format", label: t("toolbox.json.format") },
            { value: "minify", label: t("toolbox.json.minify") },
          ]}
        />
        {mode === "format" ? (
          <Labeled label={t("toolbox.indent")}>
            <Select size="compact" value={indent} onChange={setIndent} options={INDENTS} />
          </Labeled>
        ) : null}
        <CheckLabel checked={sort} onChange={setSort} label={t("toolbox.json.sortKeys")} />
        {input.trim() && !result.error ? (
          <span className={chipClass("ok")}>
            <CheckCircle2 size={12} />
            {t("toolbox.json.valid")}
          </span>
        ) : null}
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} placeholder='{"hola": "mundo"}' error={result.error} />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} wrap={false} />
      </Split>
    </>
  );
}

type DataFormat = "json" | "yaml" | "toml" | "xml";

function readData(text: string, from: DataFormat): unknown {
  switch (from) {
    case "json":
      return parseJson(text);
    case "yaml":
      return parseYaml(text);
    case "toml":
      return parseToml(text);
    case "xml":
      return xmlToJson(text);
  }
}

function writeData(value: unknown, to: DataFormat): string {
  switch (to) {
    case "json":
      return JSON.stringify(value, null, 2);
    case "yaml":
      return stringifyYaml(value);
    case "toml":
      return stringifyToml(value);
    case "xml":
      return jsonToXml(value);
  }
}

const DATA_FORMATS = [
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "toml", label: "TOML" },
  { value: "xml", label: "XML" },
];

export function ConvertTool() {
  const t = useT();
  const [input, setInput] = useToolField("convert", "input", "");
  const [from, setFrom] = useToolField<DataFormat>("convert", "from", "json");
  const [to, setTo] = useToolField<DataFormat>("convert", "to", "yaml");
  const result = useMemo(() => (input.trim() ? attempt(() => writeData(readData(input, from), to)) : { value: "", error: null }), [input, from, to]);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.from")}>
          <Select size="compact" value={from} onChange={(v) => setFrom(v as DataFormat)} options={DATA_FORMATS} />
        </Labeled>
        <Labeled label={t("toolbox.to")}>
          <Select size="compact" value={to} onChange={(v) => setTo(v as DataFormat)} options={DATA_FORMATS} />
        </Labeled>
        <button
          type="button"
          className="text-[12px] text-[var(--cf-accent)] hover:underline disabled:opacity-40"
          disabled={!result.value}
          onClick={() => {
            setInput(result.value ?? "");
            setFrom(to);
            setTo(from);
          }}
        >
          {t("toolbox.swap")}
        </button>
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} error={result.error} wrap={false} />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} wrap={false} />
      </Split>
    </>
  );
}

export function XmlTool() {
  const t = useT();
  const [input, setInput] = useToolField("xml", "input", "");
  const [mode, setMode] = useToolField<"format" | "minify">("xml", "mode", "format");
  const [indent, setIndent] = useToolField("xml", "indent", "2");
  const result = useMemo(
    () =>
      input.trim()
        ? attempt(() => (mode === "minify" ? minifyXml(input) : formatXml(input, indent === "tab" ? "\t" : " ".repeat(Number(indent)))))
        : { value: "", error: null },
    [input, mode, indent],
  );
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-xml-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "format", label: t("toolbox.json.format") },
            { value: "minify", label: t("toolbox.json.minify") },
          ]}
        />
        {mode === "format" ? (
          <Labeled label={t("toolbox.indent")}>
            <Select size="compact" value={indent} onChange={setIndent} options={INDENTS} />
          </Labeled>
        ) : null}
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} placeholder="<root><item id='1'/></root>" error={result.error} wrap={false} />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} wrap={false} />
      </Split>
    </>
  );
}

export function CsvTool() {
  const t = useT();
  const [delimiter, setDelimiter] = useToolField("csv", "delimiter", "auto");
  const [header, setHeader] = useToolField("csv", "header", true);
  const [infer, setInfer] = useToolField("csv", "infer", true);
  const run = useCallback(
    (input: string, d: Direction) => {
      if (d === "encode") {
        const delim = delimiter === "auto" ? detectDelimiter(input) : delimiter === "tab" ? "\t" : delimiter;
        return JSON.stringify(csvToJson(input, delim, header, infer), null, 2);
      }
      const delim = delimiter === "auto" ? "," : delimiter === "tab" ? "\t" : delimiter;
      return jsonToCsv(parseJson(input), delim);
    },
    [delimiter, header, infer],
  );
  return (
    <TwoWayTool
      tool="csv"
      run={run}
      labels={["toolbox.csv.toJson", "toolbox.csv.toCsv"]}
      sample={"id;nombre;activo\n1;Ana;true\n2;\"Pérez; Juan\";false"}
      options={
        <>
          <Labeled label={t("toolbox.separator")}>
            <Select
              size="compact"
              value={delimiter}
              onChange={setDelimiter}
              options={[
                { value: "auto", label: t("toolbox.csv.auto") },
                { value: ",", label: "," },
                { value: ";", label: ";" },
                { value: "tab", label: "Tab" },
                { value: "|", label: "|" },
              ]}
            />
          </Labeled>
          <CheckLabel checked={header} onChange={setHeader} label={t("toolbox.csv.header")} />
          <CheckLabel checked={infer} onChange={setInfer} label={t("toolbox.csv.infer")} />
        </>
      }
    />
  );
}

export function JsonPathTool() {
  const t = useT();
  const [input, setInput] = useToolField("jsonpath", "input", "");
  const [path, setPath] = useToolField("jsonpath", "path", "$..id");
  const result = useMemo(() => {
    if (!input.trim()) return { value: "", error: null };
    return attempt(() => {
      const hits = queryJsonPath(parseJson(input), path || "$");
      return JSON.stringify(hits, null, 2);
    });
  }, [input, path]);
  const count = result.value ? (JSON.parse(result.value) as unknown[]).length : 0;
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.jsonpath.path")}>
          <input className={`${smallInput} w-80 font-mono`} value={path} spellCheck={false} onChange={(e) => setPath(e.target.value)} />
        </Labeled>
        {result.value ? <span className={chipClass("neutral")}>{t("toolbox.matches", { count })}</span> : null}
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">$.a.b · $..id · $.items[*] · $.items[0:2] · $.items[?(@.price &lt; 10)] · .data[].id</span>
      </OptionsRow>
      <Split>
        <TextPane label="JSON" value={input} onChange={setInput} error={result.error} />
        <TextPane label={t("toolbox.results")} value={result.value ?? ""} />
      </Split>
    </>
  );
}

const SQL_DIALECTS = ["sql", "postgresql", "mysql", "mariadb", "sqlite", "transactsql", "plsql", "bigquery", "snowflake", "redshift", "spark", "trino", "duckdb", "clickhouse"];

export function SqlTool() {
  const t = useT();
  const [input, setInput] = useToolField("sql", "input", "");
  const [dialect, setDialect] = useToolField("sql", "dialect", "postgresql");
  const [keywordCase, setKeywordCase] = useToolField<"preserve" | "upper" | "lower">("sql", "case", "upper");
  const [indent, setIndent] = useToolField("sql", "indent", "2");
  const result = useAsyncResult(async () => {
    if (!input.trim()) return "";
    const { format } = await import("sql-formatter");
    return format(input, {
      language: dialect as "sql",
      keywordCase,
      tabWidth: indent === "tab" ? 2 : Number(indent),
      useTabs: indent === "tab",
      linesBetweenQueries: 1,
    });
  }, [input, dialect, keywordCase, indent]);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.sql.dialect")}>
          <Select size="compact" value={dialect} onChange={setDialect} options={SQL_DIALECTS.map((d) => ({ value: d, label: d }))} />
        </Labeled>
        <Labeled label={t("toolbox.sql.keywords")}>
          <Select
            size="compact"
            value={keywordCase}
            onChange={(v) => setKeywordCase(v as "preserve" | "upper" | "lower")}
            options={[
              { value: "upper", label: "SELECT" },
              { value: "lower", label: "select" },
              { value: "preserve", label: t("toolbox.sql.preserve") },
            ]}
          />
        </Labeled>
        <Labeled label={t("toolbox.indent")}>
          <Select size="compact" value={indent} onChange={setIndent} options={INDENTS} />
        </Labeled>
      </OptionsRow>
      <Split>
        <TextPane label="SQL" value={input} onChange={setInput} placeholder="select id, name from users where active = true order by name" />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} error={result.error} wrap={false} />
      </Split>
    </>
  );
}

const CODE_LANGUAGES = [
  ["typescript", "TypeScript"],
  ["javascript", "JavaScript (JSDoc)"],
  ["csharp", "C#"],
  ["rust", "Rust"],
  ["go", "Go"],
  ["python", "Python"],
  ["java", "Java"],
  ["kotlin", "Kotlin"],
  ["swift", "Swift"],
  ["dart", "Dart"],
] as const;

/** JSON → types, through the same quicktype setup as the editor's «Pegar JSON como código». */
export function JsonCodeTool() {
  const t = useT();
  const [input, setInput] = useToolField("json-code", "input", "");
  const [language, setLanguage] = useToolField("json-code", "language", "typescript");
  const [name, setName] = useToolField("json-code", "name", "Root");
  const result = useAsyncResult(async () => {
    if (!input.trim()) return "";
    parseJson(input);
    const [{ renderJsonAsCode }, { targetFor, isTypeName }] = await Promise.all([import("../../lib/pasteJson/generate"), import("../../lib/pasteJson/targets")]);
    const target = targetFor(language);
    if (!target) throw new Error(language);
    const typeName = isTypeName(name) ? name : "Root";
    return renderJsonAsCode({ json: input, name: typeName, target, indentation: "    ", fileName: `${typeName}.${language === "csharp" ? "cs" : language === "kotlin" ? "kt" : "txt"}` });
  }, [input, language, name], 250);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.code.language")}>
          <Select size="compact" value={language} onChange={setLanguage} options={CODE_LANGUAGES.map(([value, label]) => ({ value, label }))} />
        </Labeled>
        <Labeled label={t("toolbox.code.typeName")}>
          <input className={`${smallInput} w-40 font-mono`} value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </Labeled>
      </OptionsRow>
      <Split>
        <TextPane label="JSON" value={input} onChange={setInput} placeholder='{"id": 1, "name": "Ana", "tags": ["a"]}' />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} error={result.error} wrap={false} />
      </Split>
    </>
  );
}

export function MarkdownTool() {
  const t = useT();
  const [input, setInput] = useToolField("markdown", "input", "# Título\n\nTexto con **negrita**, `código` y un [enlace](https://example.com).\n\n- uno\n- dos\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  const [view, setView] = useToolField<"preview" | "html">("markdown", "view", "preview");
  const html = useMemo(() => renderMarkdown(input), [input]);
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-md-view"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "preview", label: t("toolbox.preview") },
            { value: "html", label: "HTML" },
          ]}
        />
      </OptionsRow>
      <Split>
        <TextPane label="Markdown" value={input} onChange={setInput} />
        {view === "html" ? (
          <TextPane label="HTML" value={html} wrap={false} />
        ) : (
          <div className={paneClass}>
            <PaneHead label={t("toolbox.preview")} />
            {/* Sanitised by `renderMarkdown` (DOMPurify), like every Markdown view in the app. */}
            <div className="cf-markdown-preview min-h-0 flex-1 select-text overflow-auto px-4 py-3 text-[13px]" dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        )}
      </Split>
    </>
  );
}

export function QueryTool() {
  const run = useCallback((input: string, d: Direction) => (d === "encode" ? JSON.stringify(queryToJson(input), null, 2) : jsonToQuery(parseJson(input))), []);
  return <TwoWayTool tool="query" run={run} labels={["toolbox.query.toJson", "toolbox.query.toQuery"]} sample="https://example.com/?q=café&page=2&tag=a&tag=b&filter[status]=open" />;
}

export function CurlTool() {
  const t = useT();
  const [input, setInput] = useToolField("curl", "input", "");
  const [target, setTarget] = useToolField("curl", "target", "javascript-fetch");
  const targets = useAsyncResult(async () => (await import("../../lib/api/codegen")).SNIPPET_TARGETS, [], 0);
  const result = useAsyncResult(async () => {
    if (!input.trim()) return "";
    const [{ parseCurl }, { resolveRequest }, codegen, { defaultApiSettings }] = await Promise.all([
      import("../../lib/api/importers"),
      import("../../lib/api/send"),
      import("../../lib/api/codegen"),
      import("../../types/api"),
    ]);
    const spec = parseCurl(input);
    if (!spec) throw new Error(t("toolbox.curl.notCurl"));
    const resolved = await resolveRequest(spec, { local: {}, data: {}, environment: [], collection: [], global: [] }, [spec.auth], defaultApiSettings());
    const code = codegen.generateSnippet(target, resolved, codegen.defaultSnippetOptions());
    if (!code) throw new Error(t("toolbox.curl.unsupported"));
    return code;
  }, [input, target, t], 150);
  const groups = useMemo(() => {
    const byGroup = new Map<string, { value: string; label: string }[]>();
    for (const tg of targets.value ?? []) {
      if (!byGroup.has(tg.group)) byGroup.set(tg.group, []);
      byGroup.get(tg.group)!.push({ value: tg.id, label: tg.label });
    }
    return [...byGroup].map(([label, options]) => ({ label, options }));
  }, [targets.value]);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.code.language")}>
          <Select size="compact" value={target} onChange={setTarget} options={groups} loading={!targets.value} className="w-60" />
        </Labeled>
      </OptionsRow>
      <Split>
        <TextPane
          label="cURL"
          value={input}
          onChange={setInput}
          placeholder={"curl -X POST https://api.example.com/items \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"name\":\"demo\"}'"}
        />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} error={result.error} wrap={false} />
      </Split>
    </>
  );
}
