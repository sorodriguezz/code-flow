/**
 * The tools added in 2.9.6 (user ask, 2026-11-23): Base32 and Base58, HTML/CSS/JS formatting, a
 * structural JSON diff, JSON Schema validation, `.env` ↔ JSON, bcrypt, TOTP codes, the date inside
 * an ObjectId or a Snowflake, and reading a QR code from an image. One chunk, loaded the first time
 * any of them is opened.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, FileUp, ImageUp, Loader2, Minus, Plus, RefreshCw, XCircle } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import { TwoWayTool, type Direction } from "./TwoWay";
import { ErrorLine, FactTable, Labeled, OptionsRow, PaneHead, paneClass, smallInput, Split, TextPane, useAsyncResult } from "./kit";
import { base32Decode, base32Encode, base58Decode, base58Encode, bytesForDisplay } from "../../lib/toolbox/baseN";
import { beautify, minify, type WebLanguage } from "../../lib/toolbox/webFormat";
import { parseEnv, toEnv } from "../../lib/toolbox/env";
import { parseOtpInput, totp, type TotpAlgorithm } from "../../lib/toolbox/totp";
import { decodeId, SNOWFLAKE_EPOCHS } from "../../lib/toolbox/idDecode";
import { bytesToBase64, utf8 } from "../../lib/toolbox/encoding";
import { writeClipboardText } from "../../lib/clipboard";
import {
  toolboxBcryptHash,
  toolboxBcryptVerify,
  toolboxJsonDiff,
  toolboxJsonSchemaValidate,
  toolboxQrRead,
} from "../../lib/tauri/commands";

// ── Base32 / Base58 ──────────────────────────────────────────────────────────────────────────

const base32Run = (input: string, direction: Direction) =>
  direction === "encode" ? base32Encode(utf8(input)) : bytesForDisplay(base32Decode(input)).text;
export function Base32Tool() {
  return <TwoWayTool tool="base32" run={base32Run} sample="Hola, mundo" />;
}

const base58Run = (input: string, direction: Direction) =>
  direction === "encode" ? base58Encode(utf8(input)) : bytesForDisplay(base58Decode(input)).text;
export function Base58Tool() {
  return <TwoWayTool tool="base58" run={base58Run} sample="Hola, mundo" />;
}

// ── HTML / CSS / JS ──────────────────────────────────────────────────────────────────────────

export function WebFormatTool() {
  const t = useT();
  const [input, setInput] = useToolField("web-format", "input", "");
  const [language, setLanguage] = useToolField<WebLanguage>("web-format", "language", "html");
  const [mode, setMode] = useToolField<"beautify" | "minify">("web-format", "mode", "beautify");
  const [indent, setIndent] = useToolField("web-format", "indent", "2");
  const result = useAsyncResult(
    () => (input.trim() ? (mode === "beautify" ? beautify(input, language, Number(indent)) : minify(input, language)) : ""),
    [input, language, mode, indent],
    150,
  );
  const saved = result.value && input ? Math.round((1 - result.value.length / input.length) * 100) : null;
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-web-lang"
          size="sm"
          value={language}
          onChange={setLanguage}
          options={[
            { value: "html", label: "HTML" },
            { value: "css", label: "CSS" },
            { value: "js", label: "JavaScript" },
          ]}
        />
        <Segmented
          layoutId="toolbox-web-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "beautify", label: t("toolbox.web.beautify") },
            { value: "minify", label: t("toolbox.web.minify") },
          ]}
        />
        {mode === "beautify" ? (
          <Labeled label={t("toolbox.indent")}>
            <Select
              size="compact"
              value={indent}
              onChange={setIndent}
              options={[
                { value: "2", label: "2" },
                { value: "4", label: "4" },
              ]}
            />
          </Labeled>
        ) : saved !== null ? (
          <span className="text-[12px] text-[var(--cf-text-muted)]">{t("toolbox.web.saved", { n: String(saved) })}</span>
        ) : null}
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} wrap={false} />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} error={result.error} wrap={false} />
      </Split>
    </>
  );
}

// ── JSON diff ────────────────────────────────────────────────────────────────────────────────

const show = (value: unknown) => (value === undefined ? "" : JSON.stringify(value));

export function JsonDiffTool() {
  const t = useT();
  const [left, setLeft] = useToolField("json-diff", "left", "");
  const [right, setRight] = useToolField("json-diff", "right", "");
  const result = useAsyncResult(() => (left.trim() && right.trim() ? toolboxJsonDiff(left, right) : null), [left, right], 200);
  const TONE = { added: "var(--cf-success)", removed: "var(--cf-danger)", changed: "var(--cf-warning)" } as const;
  return (
    <>
      <Split>
        <TextPane label={t("toolbox.jsonDiff.left")} value={left} onChange={setLeft} />
        <TextPane label={t("toolbox.jsonDiff.right")} value={right} onChange={setRight} />
      </Split>
      <div className={`${paneClass} max-h-[45%] min-h-[8rem]`}>
        <PaneHead label={result.value ? t("toolbox.jsonDiff.count", { n: String(result.value.length) }) : t("toolbox.jsonDiff.title")} />
        <div className="min-h-0 flex-1 overflow-auto">
          {result.value?.length === 0 ? (
            <p className="flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] text-[var(--cf-success)]">
              <CheckCircle2 size={13} />
              {t("toolbox.jsonDiff.same")}
            </p>
          ) : (
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {(result.value ?? []).map((change, i) => (
                  <tr key={i} className="border-b border-[var(--cf-border)] last:border-b-0">
                    <td className="w-[1%] whitespace-nowrap px-3 py-1 font-medium" style={{ color: TONE[change.op] }}>
                      {t(`toolbox.jsonDiff.${change.op}`)}
                    </td>
                    <td className="w-[1%] whitespace-nowrap px-2 py-1 font-mono text-[var(--cf-text)]">{change.path}</td>
                    <td className="break-all px-2 py-1 font-mono text-[var(--cf-text-muted)]">
                      {change.op === "changed" ? `${show(change.from)} → ${show(change.to)}` : show(change.op === "added" ? change.to : change.from)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <ErrorLine error={result.error} />
      </div>
    </>
  );
}

// ── JSON Schema ──────────────────────────────────────────────────────────────────────────────

const SCHEMA_SAMPLE = `{
  "type": "object",
  "required": ["id", "email"],
  "properties": {
    "id": { "type": "integer" },
    "email": { "type": "string", "format": "email" },
    "roles": { "type": "array", "items": { "enum": ["admin", "user"] } }
  }
}`;

export function JsonSchemaTool() {
  const t = useT();
  const [schema, setSchema] = useToolField("json-schema", "schema", "");
  const [document, setDocument] = useToolField("json-schema", "document", "");
  const result = useAsyncResult(() => (schema.trim() && document.trim() ? toolboxJsonSchemaValidate(schema, document) : null), [schema, document], 200);
  return (
    <>
      <OptionsRow>
        <span className="flex-1" />
        {!schema ? (
          <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => setSchema(SCHEMA_SAMPLE)}>
            {t("toolbox.sample")}
          </button>
        ) : null}
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.jsonSchema.schema")} value={schema} onChange={setSchema} />
        <TextPane label={t("toolbox.jsonSchema.document")} value={document} onChange={setDocument} />
      </Split>
      <div className={`${paneClass} max-h-[40%] min-h-[6rem]`}>
        <PaneHead label={t("toolbox.jsonSchema.result")} />
        <div className="min-h-0 flex-1 overflow-auto">
          {result.value === null ? null : result.value.length === 0 ? (
            <p className="flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] text-[var(--cf-success)]">
              <CheckCircle2 size={13} />
              {t("toolbox.jsonSchema.valid")}
            </p>
          ) : (
            result.value.map((error, i) => (
              <p key={i} className="flex items-start gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 text-[12px] last:border-b-0">
                <XCircle size={13} className="mt-[1px] shrink-0 text-[var(--cf-danger)]" />
                <span className="shrink-0 font-mono text-[var(--cf-text)]">{error.path || "/"}</span>
                <span className="min-w-0 break-words text-[var(--cf-text-muted)]">{error.message}</span>
              </p>
            ))
          )}
        </div>
        <ErrorLine error={result.error} />
      </div>
    </>
  );
}

// ── .env ↔ JSON ──────────────────────────────────────────────────────────────────────────────

export function EnvTool() {
  const t = useT();
  const [exportPrefix, setExportPrefix] = useToolField("env", "export", false);
  // Memoised: `TwoWayTool` recomputes whenever `run` changes, and a new one each render would loop.
  const run = useCallback(
    (input: string, direction: Direction) => (direction === "encode" ? JSON.stringify(parseEnv(input), null, 2) : toEnv(input, exportPrefix)),
    [exportPrefix],
  );
  return (
    <TwoWayTool
      tool="env"
      run={run}
      labels={["toolbox.env.toJson", "toolbox.env.toEnv"]}
      sample={'# Base de datos\nDB_HOST=localhost\nDB_PORT=5432\nexport API_KEY="abc 123"'}
      options={
        <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
          <input type="checkbox" checked={exportPrefix} onChange={(e) => setExportPrefix(e.target.checked)} />
          {t("toolbox.env.export")}
        </label>
      }
    />
  );
}

// ── bcrypt ───────────────────────────────────────────────────────────────────────────────────

export function BcryptTool() {
  const t = useT();
  const [mode, setMode] = useToolField<"hash" | "verify">("bcrypt", "mode", "hash");
  const [password, setPassword] = useToolField("bcrypt", "password", "");
  const [hash, setHash] = useToolField("bcrypt", "hash", "");
  const [cost, setCost] = useToolField("bcrypt", "cost", 10);
  // A hash pasted in (the clipboard detection, «Enviar a») is something to check against.
  useEffect(() => {
    if (/^\$2/.test(hash.trim()) && mode === "hash" && !password) setMode("verify");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [made, setMade] = useState<{ value: string | null; error: string | null; busy: boolean }>({ value: null, error: null, busy: false });
  const verified = useAsyncResult(
    () => (mode === "verify" && password && hash.trim() ? toolboxBcryptVerify(password, hash) : null),
    [mode, password, hash],
    250,
  );
  const generate = () => {
    setMade({ value: null, error: null, busy: true });
    void toolboxBcryptHash(password, cost).then(
      (value) => setMade({ value, error: null, busy: false }),
      (e: unknown) => setMade({ value: null, error: String(e), busy: false }),
    );
  };
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-bcrypt-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "hash", label: t("toolbox.bcrypt.hash") },
            { value: "verify", label: t("toolbox.bcrypt.verify") },
          ]}
        />
        {mode === "hash" ? (
          <Labeled label={t("toolbox.bcrypt.cost")}>
            <span className="inline-flex items-center gap-1">
              <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} disabled={cost <= 4} onClick={() => setCost(cost - 1)} aria-label="−">
                <Minus size={12} />
              </button>
              <span className="w-5 text-center font-mono text-[12px] tabular-nums text-[var(--cf-text)]">{cost}</span>
              <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} disabled={cost >= 15} onClick={() => setCost(cost + 1)} aria-label="+">
                <Plus size={12} />
              </button>
            </span>
          </Labeled>
        ) : null}
      </OptionsRow>
      <div className={`${paneClass} shrink-0`}>
        <PaneHead label={t("toolbox.bcrypt.password")} />
        <input
          className="h-9 bg-transparent px-3 font-mono text-[12.5px] text-[var(--cf-text)] outline-none"
          value={password}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && mode === "hash" && password) generate();
          }}
        />
      </div>
      {mode === "hash" ? (
        <>
          <OptionsRow>
            <button type="button" className={buttonClass({ variant: "primary", size: "sm" })} disabled={!password || made.busy} onClick={generate}>
              {made.busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {t("toolbox.bcrypt.generate")}
            </button>
            <span className="text-[11.5px] text-[var(--cf-text-faint)]">{t("toolbox.bcrypt.costHint")}</span>
          </OptionsRow>
          <TextPane label={t("toolbox.bcrypt.result")} value={made.value ?? ""} error={made.error} className="max-h-40" />
        </>
      ) : (
        <div className={`${paneClass} shrink-0`}>
          <PaneHead label={t("toolbox.bcrypt.hashLabel")}>
            {verified.value === true ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-[var(--cf-success)]"><CheckCircle2 size={13} />{t("toolbox.bcrypt.match")}</span>
            ) : verified.value === false ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-[var(--cf-danger)]"><XCircle size={13} />{t("toolbox.bcrypt.noMatch")}</span>
            ) : verified.busy && password && hash ? (
              <Loader2 size={12} className="animate-spin text-[var(--cf-text-muted)]" />
            ) : null}
          </PaneHead>
          <input
            className="h-9 bg-transparent px-3 font-mono text-[12.5px] text-[var(--cf-text)] outline-none"
            value={hash}
            spellCheck={false}
            placeholder="$2b$10$…"
            onChange={(e) => setHash(e.target.value)}
          />
          <ErrorLine error={verified.error} />
        </div>
      )}
    </>
  );
}

// ── TOTP ─────────────────────────────────────────────────────────────────────────────────────

export function TotpTool() {
  const t = useT();
  const [secret, setSecret] = useToolField("totp", "secret", "");
  const [digits, setDigits] = useToolField("totp", "digits", "6");
  const [period, setPeriod] = useToolField("totp", "period", "30");
  const [algorithm, setAlgorithm] = useToolField<TotpAlgorithm>("totp", "algorithm", "SHA-1");
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const config = (() => {
    try {
      return { value: secret.trim() ? parseOtpInput(secret, { digits: Number(digits), period: Number(period), algorithm }) : null, error: null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  const step = config.value ? Math.floor(now / 1000 / config.value.period) : 0;
  const result = useAsyncResult(() => (config.value ? totp(config.value, now) : null), [secret, digits, period, algorithm, step], 0);
  const remaining = config.value ? config.value.period - (Math.floor(now / 1000) % config.value.period) : 0;
  const fromLink = /^otpauth:/i.test(secret.trim());
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.totp.digits")}>
          <Select size="compact" value={digits} onChange={setDigits} options={["6", "7", "8"].map((v) => ({ value: v, label: v }))} />
        </Labeled>
        <Labeled label={t("toolbox.totp.period")}>
          <Select size="compact" value={period} onChange={setPeriod} options={["30", "60"].map((v) => ({ value: v, label: `${v} s` }))} />
        </Labeled>
        <Labeled label={t("toolbox.totp.algorithm")}>
          <Select size="compact" value={algorithm} onChange={(v) => setAlgorithm(v as TotpAlgorithm)} options={["SHA-1", "SHA-256", "SHA-512"].map((v) => ({ value: v, label: v }))} />
        </Labeled>
        {fromLink ? <span className="text-[11.5px] text-[var(--cf-text-faint)]">{t("toolbox.totp.fromLink")}</span> : null}
      </OptionsRow>
      <div className={`${paneClass} shrink-0`}>
        <PaneHead label={t("toolbox.totp.secret")} />
        <input
          className="h-9 bg-transparent px-3 font-mono text-[12.5px] text-[var(--cf-text)] outline-none"
          value={secret}
          spellCheck={false}
          autoComplete="off"
          placeholder="JBSWY3DPEHPK3PXP · otpauth://totp/…"
          onChange={(e) => setSecret(e.target.value)}
        />
        <ErrorLine error={config.error ?? result.error} />
      </div>
      {result.value && config.value ? (
        <div className={`${paneClass} shrink-0 items-center gap-2 py-6`}>
          {config.value.issuer || config.value.account ? (
            <p className="text-[12px] text-[var(--cf-text-muted)]">{[config.value.issuer, config.value.account].filter(Boolean).join(" · ")}</p>
          ) : null}
          <p className="select-text font-mono text-[34px] font-semibold tracking-[0.18em] text-[var(--cf-text)] tabular-nums">{result.value.code}</p>
          <div className="h-1 w-48 overflow-hidden rounded-full bg-[var(--cf-border)]">
            <div
              className="h-full rounded-full bg-[var(--cf-accent)] transition-[width] duration-1000 ease-linear"
              style={{ width: `${(remaining / config.value.period) * 100}%` }}
            />
          </div>
          <p className="text-[11.5px] text-[var(--cf-text-muted)]">
            {t("toolbox.totp.remaining", { n: String(remaining) })} · {t("toolbox.totp.next")} <span className="font-mono">{result.value.next}</span>
          </p>
          <button
            type="button"
            className={buttonClass({ variant: "ghost", size: "sm" })}
            onClick={() => void writeClipboardText(result.value?.code ?? "").catch(() => {})}
          >
            {t("toolbox.copy")}
          </button>
        </div>
      ) : null}
    </>
  );
}

// ── ObjectId / Snowflake / ULID ──────────────────────────────────────────────────────────────

export function IdDecodeTool() {
  const t = useT();
  const [input, setInput] = useToolField("id-decode", "input", "");
  const [epochId, setEpochId] = useToolField("id-decode", "epoch", "twitter");
  const epoch = SNOWFLAKE_EPOCHS.find((e) => e.id === epochId) ?? SNOWFLAKE_EPOCHS[0];
  const decoded = (() => {
    if (!input.trim()) return { value: null, error: null };
    try {
      return { value: decodeId(input, epoch), error: null };
    } catch (e) {
      return { value: null, error: e instanceof Error ? e.message : String(e) };
    }
  })();
  const value = decoded.value;
  const rows: [string, string | null][] = value
    ? [
        [t("toolbox.idDecode.kind"), value.kind === "objectId" ? "MongoDB ObjectId" : value.kind === "ulid" ? "ULID" : `Snowflake · ${epoch.label}`],
        [t("toolbox.idDecode.created"), value.date.toISOString()],
        [t("toolbox.idDecode.local"), value.date.toLocaleString()],
        ["Unix (ms)", String(value.date.getTime())],
        ...(value.kind === "objectId"
          ? ([
              [t("toolbox.idDecode.machine"), value.machine],
              [t("toolbox.idDecode.process"), value.process],
              [t("toolbox.idDecode.counter"), String(value.counter)],
            ] as [string, string][])
          : value.kind === "ulid"
            ? ([[t("toolbox.idDecode.random"), value.randomness]] as [string, string][])
            : value.fields.map(([name, n]) => [name, String(n)] as [string, string])),
      ]
    : [];
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.idDecode.epoch")}>
          <Select size="compact" value={epochId} onChange={setEpochId} options={SNOWFLAKE_EPOCHS.map((e) => ({ value: e.id, label: e.label }))} />
        </Labeled>
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">{t("toolbox.idDecode.epochHint")}</span>
      </OptionsRow>
      <div className={`${paneClass} shrink-0`}>
        <PaneHead label={t("toolbox.input")} />
        <input
          className={`${smallInput} h-9 rounded-none border-0 bg-transparent px-3 font-mono text-[12.5px]`}
          value={input}
          spellCheck={false}
          placeholder="507f1f77bcf86cd799439011 · 1541815603606036480 · 01ARZ3NDEKTSV4RRFFQ69G5FAV"
          onChange={(e) => setInput(e.target.value)}
        />
        <ErrorLine error={decoded.error} />
      </div>
      {rows.length ? <FactTable rows={rows} /> : null}
    </>
  );
}

// ── Read a QR code ───────────────────────────────────────────────────────────────────────────

export function QrReadTool() {
  const t = useT();
  const picker = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<{ name: string; preview: string; texts: string[] | null; error: string | null; busy: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  const read = (file: Blob, name: string) => {
    const preview = URL.createObjectURL(file);
    setState((previous) => {
      if (previous) URL.revokeObjectURL(previous.preview);
      return { name, preview, texts: null, error: null, busy: true };
    });
    void file
      .arrayBuffer()
      .then((buffer) => toolboxQrRead(bytesToBase64(new Uint8Array(buffer))))
      .then(
        (texts) => setState((s) => (s && s.preview === preview ? { ...s, texts, busy: false } : s)),
        (e: unknown) => setState((s) => (s && s.preview === preview ? { ...s, error: String(e), busy: false } : s)),
      );
  };
  useEffect(() => () => {
    if (state) URL.revokeObjectURL(state.preview);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A screenshot on the clipboard is the usual source: ⌘V anywhere in the tool reads it.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        read(file, t("toolbox.qrRead.pasted"));
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  return (
    <>
      <OptionsRow>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) read(file, file.name);
            e.target.value = "";
          }}
        />
        <button type="button" className={buttonClass({ size: "sm" })} onClick={() => picker.current?.click()}>
          <FileUp size={13} />
          {t("toolbox.pickFile")}
        </button>
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">{t("toolbox.qrRead.hint")}</span>
      </OptionsRow>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
            if (file) read(file, file.name);
          }}
          className={`${paneClass} min-h-[12rem] items-center justify-center p-3 ${dragging ? "border-[var(--cf-accent)]" : ""}`}
        >
          {state ? (
            <img src={state.preview} alt={state.name} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="flex flex-col items-center gap-2 text-[12px] text-[var(--cf-text-faint)]">
              <ImageUp size={22} />
              {t("toolbox.qrRead.drop")}
            </span>
          )}
        </div>
        <div className="flex min-h-0 flex-col gap-3">
          {state?.busy ? (
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              {t("toolbox.qrRead.reading")}
            </p>
          ) : state?.error ? (
            <ErrorLine error={state.error} />
          ) : state?.texts?.length === 0 ? (
            <p className="text-[12.5px] text-[var(--cf-text-muted)]">{t("toolbox.qrRead.none")}</p>
          ) : (
            state?.texts?.map((text, i) => <TextPane key={i} label={state.texts!.length > 1 ? `QR ${i + 1}` : t("toolbox.output")} value={text} />)
          )}
        </div>
      </div>
    </>
  );
}
