/** «Codificar»: Base64, URL, HTML, Unicode, hex, binary, Punycode, quoted-printable and gzip. */
import { useCallback, useRef, useState } from "react";
import { FileUp } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import {
  binaryToText,
  bytesToBase64,
  compressToBase64,
  decodeBase64,
  decodeHtmlEntities,
  decodeQuotedPrintable,
  decodeUrl,
  decompressFromBase64,
  domainToAscii,
  domainToUnicode,
  encodeBase64,
  encodeHtmlEntities,
  encodeQuotedPrintable,
  encodeUrl,
  escapeUnicode,
  hexToText,
  parseDataUri,
  textToBinary,
  textToHex,
  unescapeUnicode,
  type CompressionKind,
} from "../../lib/toolbox/encoding";
import { mimeForExtension } from "../../lib/toolbox/reference";
import { CopyButton, Labeled, OptionsRow, PaneHead, paneClass, TextPane } from "./kit";
import { TwoWayTool, type Direction } from "./TwoWay";

function CheckLabel({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
      <Checkbox checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

export { CheckLabel };

export function Base64Tool() {
  const t = useT();
  const [mode, setMode] = useToolField<"text" | "file">("base64", "mode", "text");
  const [urlSafe, setUrlSafe] = useToolField("base64", "urlSafe", false);
  const run = useCallback((input: string, d: Direction) => (d === "encode" ? encodeBase64(input, urlSafe) : decodeBase64(input)), [urlSafe]);
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-base64-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "text", label: t("toolbox.base64.text") },
            { value: "file", label: t("toolbox.base64.file") },
          ]}
        />
      </OptionsRow>
      {mode === "text" ? (
        <TwoWayTool
          tool="base64"
          run={run}
          sample="CodeFlow — herramientas locales ✓"
          options={<CheckLabel checked={urlSafe} onChange={setUrlSafe} label={t("toolbox.base64.urlSafe")} />}
        />
      ) : (
        <Base64File />
      )}
    </>
  );
}

/**
 * A file to Base64 and a data URI, with the image previewed — and the other way, a data URI pasted
 * in previews as the image it is.
 */
function Base64File() {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ name: string; size: number; mime: string; base64: string } | null>(null);
  const [pasted, setPasted] = useToolField("base64", "dataUri", "");
  const [error, setError] = useState<string | null>(null);
  const data = parseDataUri(pasted);
  const pick = async (f: File) => {
    setError(null);
    try {
      const bytes = new Uint8Array(await f.arrayBuffer());
      const mime = f.type || mimeForExtension(f.name) || "application/octet-stream";
      setFile({ name: f.name, size: f.size, mime, base64: bytesToBase64(bytes) });
    } catch (err) {
      setError(String(err));
    }
  };
  const dataUri = file ? `data:${file.mime};base64,${file.base64}` : "";
  const previewSrc = file?.mime.startsWith("image/") ? dataUri : data?.mime.startsWith("image/") ? pasted.trim() : null;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col gap-3">
        <OptionsRow>
          <input ref={input} type="file" className="hidden" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
          <button type="button" className={buttonClass({ size: "sm" })} onClick={() => input.current?.click()}>
            <FileUp size={13} />
            {t("toolbox.pickFile")}
          </button>
          {file ? (
            <span className="truncate text-[12px] text-[var(--cf-text-muted)]">
              {file.name} · {file.mime} · {file.size.toLocaleString()} B
            </span>
          ) : null}
        </OptionsRow>
        <TextPane label="Base64" value={file?.base64 ?? ""} error={error} />
        <TextPane label="Data URI" value={dataUri} className="max-h-40" />
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <TextPane label={t("toolbox.base64.pasteDataUri")} value={pasted} onChange={setPasted} placeholder="data:image/png;base64,…" className="max-h-48" />
        <div className={`${paneClass} flex-1`}>
          <PaneHead label={t("toolbox.preview")}>{data ? <CopyButton text={data.base64} /> : null}</PaneHead>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--cf-hover)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] p-3">
            {previewSrc ? <img src={previewSrc} alt="" className="max-h-full max-w-full object-contain" /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export function UrlTool() {
  const t = useT();
  const [component, setComponent] = useToolField("url", "component", true);
  const [plus, setPlus] = useToolField("url", "plus", true);
  const run = useCallback(
    (input: string, d: Direction) => (d === "encode" ? encodeUrl(input, component ? "component" : "full") : decodeUrl(input, plus)),
    [component, plus],
  );
  return (
    <TwoWayTool
      tool="url"
      run={run}
      sample="https://example.com/buscar?q=año nuevo&tag=c#"
      options={
        <>
          <CheckLabel checked={component} onChange={setComponent} label={t("toolbox.url.component")} />
          <CheckLabel checked={plus} onChange={setPlus} label={t("toolbox.url.plus")} />
        </>
      }
    />
  );
}

export function HtmlTool() {
  const t = useT();
  const [nonAscii, setNonAscii] = useToolField("html", "nonAscii", false);
  const run = useCallback((input: string, d: Direction) => (d === "encode" ? encodeHtmlEntities(input, nonAscii) : decodeHtmlEntities(input)), [nonAscii]);
  return (
    <TwoWayTool
      tool="html"
      run={run}
      sample={'<a href="/x?a=1&b=2">Ñandú «café»</a>'}
      options={<CheckLabel checked={nonAscii} onChange={setNonAscii} label={t("toolbox.html.nonAscii")} />}
    />
  );
}

export function UnicodeTool() {
  const t = useT();
  const [braces, setBraces] = useToolField("unicode", "braces", false);
  const [all, setAll] = useToolField("unicode", "all", false);
  const run = useCallback(
    (input: string, d: Direction) => (d === "encode" ? escapeUnicode(input, braces ? "braces" : "u4", all) : unescapeUnicode(input)),
    [braces, all],
  );
  return (
    <TwoWayTool
      tool="unicode"
      run={run}
      labels={["toolbox.escape", "toolbox.unescape"]}
      sample="Año 2026 — ¡listo! 🚀"
      options={
        <>
          <CheckLabel checked={braces} onChange={setBraces} label={t("toolbox.unicode.braces")} />
          <CheckLabel checked={all} onChange={setAll} label={t("toolbox.unicode.all")} />
        </>
      }
    />
  );
}

export function HexTool() {
  const t = useT();
  const [sep, setSep] = useToolField("hex", "sep", " ");
  const run = useCallback((input: string, d: Direction) => (d === "encode" ? textToHex(input, sep) : hexToText(input)), [sep]);
  return (
    <TwoWayTool
      tool="hex"
      run={run}
      sample="CodeFlow ñ"
      options={
        <Labeled label={t("toolbox.separator")}>
          <Select
            size="compact"
            value={sep === "" ? "none" : sep === ":" ? "colon" : "space"}
            onChange={(v) => setSep(v === "none" ? "" : v === "colon" ? ":" : " ")}
            options={[
              { value: "space", label: t("toolbox.sep.space") },
              { value: "colon", label: ":" },
              { value: "none", label: t("toolbox.sep.none") },
            ]}
          />
        </Labeled>
      }
    />
  );
}

export function BinaryTool() {
  const run = useCallback((input: string, d: Direction) => (d === "encode" ? textToBinary(input) : binaryToText(input)), []);
  return <TwoWayTool tool="binary" run={run} sample="Hola" />;
}

export function PunycodeTool() {
  const run = useCallback((input: string, d: Direction) => input.split(/\r?\n/).map((l) => (d === "encode" ? domainToAscii(l.trim()) : domainToUnicode(l.trim()))).join("\n"), []);
  return <TwoWayTool tool="punycode" run={run} labels={["toolbox.punycode.toAscii", "toolbox.punycode.toUnicode"]} sample="ñandú.cl" />;
}

export function QuotedPrintableTool() {
  const run = useCallback((input: string, d: Direction) => (d === "encode" ? encodeQuotedPrintable(input) : decodeQuotedPrintable(input)), []);
  return <TwoWayTool tool="qp" run={run} sample="Información confidencial: año 2026 = ✓" />;
}

export function GzipTool() {
  const t = useT();
  const [kind, setKind] = useToolField<CompressionKind>("gzip", "kind", "gzip");
  const run = useCallback((input: string, d: Direction) => (d === "encode" ? compressToBase64(input, kind) : decompressFromBase64(input, kind)), [kind]);
  return (
    <TwoWayTool
      tool="gzip"
      run={run}
      labels={["toolbox.gzip.compress", "toolbox.gzip.decompress"]}
      sample={'{"hello":"world","items":[1,2,3,4,5,6,7,8,9,10]}'}
      options={
        <Labeled label={t("toolbox.format")}>
          <Select
            size="compact"
            value={kind}
            onChange={(v) => setKind(v as CompressionKind)}
            options={[
              { value: "gzip", label: "gzip" },
              { value: "deflate", label: "deflate (zlib)" },
              { value: "deflate-raw", label: "deflate raw" },
            ]}
          />
        </Labeled>
      }
    />
  );
}
