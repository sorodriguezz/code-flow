/** «Generadores»: ids, passwords, hashes, HMAC, QR codes, fake data and RUTs. */
import { useMemo, useRef, useState } from "react";
import { CheckCircle2, FileUp, RefreshCw, XCircle } from "lucide-react";
import qrcode from "qrcode-generator";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import {
  entropyBits,
  generatePassphrase,
  generatePassword,
  inspectUuid,
  nanoid,
  passwordAlphabet,
  pick,
  RANDOM_ALPHABETS,
  ulid,
  ulidTime,
  uuidV4,
  uuidV7,
  WORDS,
  type PasswordOptions,
} from "../../lib/toolbox/ids";
import { digest, formatDigest, hmac, HASH_ALGORITHMS, type HashAlgorithm, type ShaAlgorithm } from "../../lib/toolbox/hash";
import { base64ToBytes, hexToBytes, utf8 } from "../../lib/toolbox/encoding";
import { FAKE_FIELDS, fakeRecords, formatRut, randomRut, validateRut, type FakeField } from "../../lib/toolbox/fake";
import { jsonToCsv } from "../../lib/toolbox/csv";
import { toLocalIso } from "../../lib/toolbox/time";
import { CopyButton, FactTable, Labeled, OptionsRow, PaneHead, paneClass, smallInput, Split, TextPane, useAsyncResult } from "./kit";
import { CheckLabel } from "./EncodeTools";

type IdKind = "v4" | "v7" | "ulid" | "nanoid";

export function UuidTool() {
  const t = useT();
  const [kind, setKind] = useToolField<IdKind>("uuid", "kind", "v4");
  const [count, setCount] = useToolField("uuid", "count", 5);
  const [upper, setUpper] = useToolField("uuid", "upper", false);
  const [hyphens, setHyphens] = useToolField("uuid", "hyphens", true);
  const [inspect, setInspect] = useToolField("uuid", "inspect", "");
  const [seed, setSeed] = useState(0);
  const ids = useMemo(() => {
    const make = () => {
      const id = kind === "v4" ? uuidV4() : kind === "v7" ? uuidV7() : kind === "ulid" ? ulid() : nanoid();
      const shaped = kind === "v4" || kind === "v7" ? (hyphens ? id : id.replace(/-/g, "")) : id;
      return upper && kind !== "nanoid" ? shaped.toUpperCase() : shaped;
    };
    return Array.from({ length: Math.min(Math.max(1, count), 1000) }, make).join("\n");
  }, [kind, count, upper, hyphens, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = inspect.trim() ? inspectUuid(inspect) : null;
  const ulidDate = inspect.trim() && !info ? ulidTime(inspect) : null;
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-uuid-kind"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: "v4", label: "UUID v4" },
            { value: "v7", label: "UUID v7" },
            { value: "ulid", label: "ULID" },
            { value: "nanoid", label: "nanoid" },
          ]}
        />
        <Labeled label={t("toolbox.quantity")}>
          <input type="number" min={1} max={1000} className={`${smallInput} w-20`} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        </Labeled>
        {kind !== "nanoid" ? <CheckLabel checked={upper} onChange={setUpper} label={t("toolbox.uuid.upper")} /> : null}
        {kind === "v4" || kind === "v7" ? <CheckLabel checked={hyphens} onChange={setHyphens} label={t("toolbox.uuid.hyphens")} /> : null}
        <button type="button" className={buttonClass({ size: "sm" })} onClick={() => setSeed(seed + 1)}>
          <RefreshCw size={13} />
          {t("toolbox.generate")}
        </button>
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.output")} value={ids} />
        <div className="flex min-h-0 flex-col gap-3">
          <div className={`${paneClass} shrink-0`}>
            <PaneHead label={t("toolbox.uuid.inspect")} />
            <input className="h-9 bg-transparent px-3 font-mono text-[12.5px] text-[var(--cf-text)] outline-none" value={inspect} spellCheck={false} placeholder="018f…-7…" onChange={(e) => setInspect(e.target.value)} />
          </div>
          {info ? (
            <FactTable
              rows={[
                [t("toolbox.uuid.version"), String(info.version)],
                [t("toolbox.uuid.variant"), info.variant],
                [t("toolbox.uuid.created"), info.date ? toLocalIso(info.date) : null],
              ]}
            />
          ) : ulidDate ? (
            <FactTable rows={[[t("toolbox.uuid.created"), toLocalIso(ulidDate)]]} />
          ) : inspect.trim() ? (
            <span className="text-[12px] text-[var(--cf-danger)]">{t("toolbox.uuid.notId")}</span>
          ) : null}
        </div>
      </Split>
    </>
  );
}

type SecretKind = "password" | "passphrase" | "random";

export function PasswordTool() {
  const t = useT();
  const [kind, setKind] = useToolField<SecretKind>("password", "kind", "password");
  const [o, setO] = useToolField<PasswordOptions>("password", "options", { length: 20, lower: true, upper: true, digits: true, symbols: true, avoidAmbiguous: false });
  const [words, setWords] = useToolField("password", "words", 6);
  const [sep, setSep] = useToolField("password", "sep", "-");
  const [cap, setCap] = useToolField("password", "cap", true);
  const [withNumber, setWithNumber] = useToolField("password", "num", false);
  const [alphabet, setAlphabet] = useToolField<keyof typeof RANDOM_ALPHABETS>("password", "alphabet", "alnum");
  const [length, setLength] = useToolField("password", "rlength", 32);
  const [count, setCount] = useToolField("password", "count", 5);
  const [seed, setSeed] = useState(0);
  const list = useMemo(() => {
    const n = Math.min(Math.max(1, count), 200);
    return Array.from({ length: n }, () =>
      kind === "password" ? generatePassword(o) : kind === "passphrase" ? generatePassphrase(words, sep, cap, withNumber) : pick(RANDOM_ALPHABETS[alphabet], Math.min(Math.max(1, length), 4096)),
    );
  }, [kind, o, words, sep, cap, withNumber, alphabet, length, count, seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const bits =
    kind === "password"
      ? entropyBits(passwordAlphabet(o).join("").length, o.length)
      : kind === "passphrase"
        ? entropyBits(WORDS.length, words) + (withNumber ? Math.log2(100) : 0)
        : entropyBits(RANDOM_ALPHABETS[alphabet].length, length);
  const strength = bits >= 100 ? "ok" : bits >= 60 ? "info" : bits >= 40 ? "warn" : "bad";
  const set = (patch: Partial<PasswordOptions>) => setO({ ...o, ...patch });
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-pw-kind"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: "password", label: t("toolbox.password.password") },
            { value: "passphrase", label: t("toolbox.password.passphrase") },
            { value: "random", label: t("toolbox.password.random") },
          ]}
        />
        <Labeled label={t("toolbox.quantity")}>
          <input type="number" min={1} max={200} className={`${smallInput} w-16`} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        </Labeled>
        <button type="button" className={buttonClass({ size: "sm" })} onClick={() => setSeed(seed + 1)}>
          <RefreshCw size={13} />
          {t("toolbox.generate")}
        </button>
        <span className={chipClass(strength)}>{t("toolbox.password.bits", { bits: Math.round(bits) })}</span>
      </OptionsRow>
      <OptionsRow>
        {kind === "password" ? (
          <>
            <Labeled label={t("toolbox.password.length")}>
              <input type="range" min={4} max={128} value={o.length} onChange={(e) => set({ length: Number(e.target.value) })} />
              <span className="w-7 font-mono text-[12px] text-[var(--cf-text)]">{o.length}</span>
            </Labeled>
            <CheckLabel checked={o.lower} onChange={(v) => set({ lower: v })} label="a–z" />
            <CheckLabel checked={o.upper} onChange={(v) => set({ upper: v })} label="A–Z" />
            <CheckLabel checked={o.digits} onChange={(v) => set({ digits: v })} label="0–9" />
            <CheckLabel checked={o.symbols} onChange={(v) => set({ symbols: v })} label="!@#" />
            <CheckLabel checked={o.avoidAmbiguous} onChange={(v) => set({ avoidAmbiguous: v })} label={t("toolbox.password.ambiguous")} />
          </>
        ) : kind === "passphrase" ? (
          <>
            <Labeled label={t("toolbox.password.words")}>
              <input type="number" min={3} max={20} className={`${smallInput} w-16`} value={words} onChange={(e) => setWords(Math.min(20, Math.max(3, Number(e.target.value) || 6)))} />
            </Labeled>
            <Labeled label={t("toolbox.separator")}>
              <input className={`${smallInput} w-12 text-center font-mono`} value={sep} maxLength={3} onChange={(e) => setSep(e.target.value)} />
            </Labeled>
            <CheckLabel checked={cap} onChange={setCap} label={t("toolbox.password.capitalize")} />
            <CheckLabel checked={withNumber} onChange={setWithNumber} label={t("toolbox.password.number")} />
          </>
        ) : (
          <>
            <Labeled label={t("toolbox.password.alphabet")}>
              <Select
                size="compact"
                value={alphabet}
                onChange={(v) => setAlphabet(v as keyof typeof RANDOM_ALPHABETS)}
                options={[
                  { value: "alnum", label: "A–Z a–z 0–9" },
                  { value: "hex", label: "hex" },
                  { value: "base64url", label: "base64url" },
                  { value: "digits", label: "0–9" },
                  { value: "letters", label: "A–Z a–z" },
                ]}
              />
            </Labeled>
            <Labeled label={t("toolbox.password.length")}>
              <input type="number" min={1} max={4096} className={`${smallInput} w-20`} value={length} onChange={(e) => setLength(Number(e.target.value) || 1)} />
            </Labeled>
          </>
        )}
      </OptionsRow>
      <TextPane className="flex-1" label={t("toolbox.output")} value={list.join("\n")} />
    </>
  );
}

const FORMATS = [
  { value: "hex", label: "hex" },
  { value: "HEX", label: "HEX" },
  { value: "base64", label: "Base64" },
];

export function HashTool() {
  const t = useT();
  const [mode, setMode] = useToolField<"text" | "file">("hash", "mode", "text");
  const [input, setInput] = useToolField("hash", "input", "");
  const [format, setFormat] = useToolField<"hex" | "HEX" | "base64">("hash", "format", "hex");
  const [compare, setCompare] = useToolField("hash", "compare", "");
  const [file, setFile] = useState<{ name: string; size: number; bytes: Uint8Array } | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const bytes = mode === "text" ? utf8(input) : file?.bytes ?? null;
  const result = useAsyncResult(async () => {
    if (!bytes || (mode === "text" && !input)) return null;
    const out: [HashAlgorithm, string][] = [];
    for (const alg of HASH_ALGORITHMS) out.push([alg, formatDigest(await digest(alg, bytes), format)]);
    return out;
  }, [input, file, mode, format], mode === "text" ? 80 : 0);
  const needle = compare.trim().toLowerCase();
  const matched = needle ? result.value?.find(([, v]) => v.toLowerCase() === needle)?.[0] : undefined;
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-hash-mode"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "text", label: t("toolbox.base64.text") },
            { value: "file", label: t("toolbox.base64.file") },
          ]}
        />
        <Labeled label={t("toolbox.format")}>
          <Select size="compact" value={format} onChange={(v) => setFormat(v as "hex")} options={FORMATS} />
        </Labeled>
        {mode === "file" ? (
          <>
            <input ref={picker} type="file" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.arrayBuffer().then((b) => setFile({ name: f.name, size: f.size, bytes: new Uint8Array(b) }));
            }} />
            <button type="button" className={buttonClass({ size: "sm" })} onClick={() => picker.current?.click()}>
              <FileUp size={13} />
              {t("toolbox.pickFile")}
            </button>
            {file ? <span className="text-[12px] text-[var(--cf-text-muted)]">{file.name} · {file.size.toLocaleString()} B</span> : null}
          </>
        ) : null}
      </OptionsRow>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
        {mode === "text" ? <TextPane label={t("toolbox.input")} value={input} onChange={setInput} /> : <div className={`${paneClass} items-center justify-center text-[12px] text-[var(--cf-text-faint)]`}>{file ? file.name : t("toolbox.hash.fileHint")}</div>}
        <div className="flex min-h-0 flex-col gap-3">
          <FactTable rows={(result.value ?? []).map(([alg, v]) => [alg, v])} />
          <div className={`${paneClass} shrink-0`}>
            <PaneHead label={t("toolbox.hash.compare")}>
              {needle ? (
                matched ? (
                  <span className="inline-flex items-center gap-1 text-[12px] text-[var(--cf-success)]"><CheckCircle2 size={13} />{matched}</span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[12px] text-[var(--cf-danger)]"><XCircle size={13} />{t("toolbox.hash.noMatch")}</span>
                )
              ) : null}
            </PaneHead>
            <input className="h-9 bg-transparent px-3 font-mono text-[12.5px] text-[var(--cf-text)] outline-none" value={compare} spellCheck={false} onChange={(e) => setCompare(e.target.value)} />
          </div>
        </div>
      </div>
    </>
  );
}

export function HmacTool() {
  const t = useT();
  const [input, setInput] = useToolField("hmac", "input", "");
  const [key, setKey] = useToolField("hmac", "key", "");
  const [keyFormat, setKeyFormat] = useToolField<"text" | "hex" | "base64">("hmac", "keyFormat", "text");
  const [format, setFormat] = useToolField<"hex" | "HEX" | "base64">("hmac", "format", "hex");
  const result = useAsyncResult(async () => {
    if (!key) return null;
    const k = keyFormat === "hex" ? hexToBytes(key) : keyFormat === "base64" ? base64ToBytes(key) : utf8(key);
    const out: [string, string][] = [];
    for (const alg of ["SHA-1", "SHA-256", "SHA-384", "SHA-512"] as ShaAlgorithm[]) out.push([`HMAC-${alg}`, formatDigest(await hmac(alg, k, utf8(input)), format)]);
    return out;
  }, [input, key, keyFormat, format]);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.hmac.key")}>
          <input className={`${smallInput} w-72 font-mono`} value={key} spellCheck={false} onChange={(e) => setKey(e.target.value)} />
        </Labeled>
        <Select size="compact" value={keyFormat} onChange={(v) => setKeyFormat(v as "text")} options={[{ value: "text", label: "UTF-8" }, { value: "hex", label: "hex" }, { value: "base64", label: "Base64" }]} />
        <Labeled label={t("toolbox.format")}>
          <Select size="compact" value={format} onChange={(v) => setFormat(v as "hex")} options={FORMATS} />
        </Labeled>
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.hmac.message")} value={input} onChange={setInput} error={result.error} />
        {result.value ? <FactTable rows={result.value} /> : <div className={`${paneClass} items-center justify-center text-[12px] text-[var(--cf-text-faint)]`}>{t("toolbox.hmac.needKey")}</div>}
      </Split>
    </>
  );
}

export function QrTool() {
  const t = useT();
  const [input, setInput] = useToolField("qr", "input", "https://example.com");
  const [ecc, setEcc] = useToolField<"L" | "M" | "Q" | "H">("qr", "ecc", "M");
  const svg = useMemo(() => {
    if (!input) return { value: "", error: null as string | null };
    try {
      const qr = qrcode(0, ecc);
      qr.addData(input, "Byte");
      qr.make();
      const n = qr.getModuleCount();
      const q = 4;
      let path = "";
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + q} ${r + q}h1v1h-1z`;
      return { value: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + q * 2} ${n + q * 2}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`, error: null };
    } catch {
      return { value: "", error: t("toolbox.qr.tooLong") };
    }
  }, [input, ecc, t]);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.qr.ecc")}>
          <Select size="compact" value={ecc} onChange={(v) => setEcc(v as "M")} options={[{ value: "L", label: "L · 7%" }, { value: "M", label: "M · 15%" }, { value: "Q", label: "Q · 25%" }, { value: "H", label: "H · 30%" }]} />
        </Labeled>
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.qr.content")} value={input} onChange={setInput} error={svg.error} placeholder="WIFI:T:WPA;S:MiRed;P:clave;;" />
        <div className={paneClass}>
          <PaneHead label="QR">
            <CopyButton text={svg.value} label={t("toolbox.qr.copySvg")} />
          </PaneHead>
          <div className="flex min-h-0 flex-1 items-center justify-center p-4">
            {svg.value ? <img alt="" className="aspect-square max-h-full max-w-full [image-rendering:pixelated]" src={`data:image/svg+xml;utf8,${encodeURIComponent(svg.value)}`} /> : null}
          </div>
        </div>
      </Split>
    </>
  );
}

export function FakeTool() {
  const t = useT();
  const [fields, setFields] = useToolField<FakeField[]>("fake", "fields", ["name", "email", "rut", "phone", "commune"]);
  const [count, setCount] = useToolField("fake", "count", 10);
  const [format, setFormat] = useToolField<"json" | "csv" | "sql">("fake", "format", "json");
  const [seedText, setSeedText] = useToolField("fake", "seed", "");
  const [again, setAgain] = useState(0);
  const output = useMemo(() => {
    const seed = seedText.trim() ? Number(seedText) || [...seedText].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) : undefined;
    const rows = fakeRecords(fields, Math.min(Math.max(1, count), 5000), seed);
    if (format === "json") return JSON.stringify(rows, null, 2);
    if (format === "csv") return jsonToCsv(rows);
    const cols = fields.join(", ");
    const lit = (v: unknown) => (typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : `'${String(v).replace(/'/g, "''")}'`);
    return rows.map((r) => `INSERT INTO people (${cols}) VALUES (${fields.map((f) => lit(r[f])).join(", ")});`).join("\n");
  }, [fields, count, format, seedText, again]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.quantity")}>
          <input type="number" min={1} max={5000} className={`${smallInput} w-20`} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
        </Labeled>
        <Segmented layoutId="toolbox-fake-format" size="sm" value={format} onChange={setFormat} options={[{ value: "json", label: "JSON" }, { value: "csv", label: "CSV" }, { value: "sql", label: "SQL" }]} />
        <Labeled label={t("toolbox.fake.seed")}>
          <input className={`${smallInput} w-24 font-mono`} value={seedText} placeholder="—" onChange={(e) => setSeedText(e.target.value)} />
        </Labeled>
        <button type="button" className={buttonClass({ size: "sm" })} onClick={() => setAgain(again + 1)} disabled={!!seedText.trim()}>
          <RefreshCw size={13} />
          {t("toolbox.generate")}
        </button>
      </OptionsRow>
      <OptionsRow>
        {FAKE_FIELDS.map((f) => (
          <CheckLabel
            key={f}
            checked={fields.includes(f)}
            onChange={(on) => setFields(on ? FAKE_FIELDS.filter((x) => x === f || fields.includes(x)) : fields.filter((x) => x !== f))}
            label={t(`toolbox.fake.field.${f}`)}
          />
        ))}
      </OptionsRow>
      <TextPane className="flex-1" label={t("toolbox.output")} value={output} wrap={false} />
    </>
  );
}

export function RutTool() {
  const t = useT();
  const [input, setInput] = useToolField("rut", "input", "");
  const [dots, setDots] = useToolField("rut", "dots", true);
  const [count, setCount] = useToolField("rut", "count", 10);
  const [again, setAgain] = useState(0);
  const lines = input.split(/\r?\n/).filter((l) => l.trim());
  const generated = useMemo(() => Array.from({ length: Math.min(Math.max(1, count), 1000) }, () => randomRut(Math.random, 5_000_000, 25_000_000, dots)).join("\n"), [count, dots, again]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col gap-3">
        <TextPane className="max-h-56" label={t("toolbox.rut.validate")} value={input} onChange={setInput} placeholder={"12.345.678-5\n76086428-5\n11111111"} />
        <div className={`${paneClass} flex-1`}>
          <div className="min-h-0 flex-1 overflow-auto">
            {lines.map((line, i) => {
              const r = validateRut(line);
              const body = line.replace(/[^\dkK]/g, "");
              const onlyBody = !r.formatted && /^\d{1,9}$/.test(body);
              return (
                <div key={i} className="flex items-center gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 text-[12.5px]">
                  <span className="min-w-0 flex-1 truncate font-mono">{line.trim()}</span>
                  {r.valid ? (
                    <span className={chipClass("ok")}><CheckCircle2 size={12} />{r.formatted}</span>
                  ) : onlyBody ? (
                    <span className={chipClass("info")}>{t("toolbox.rut.dvIs", { dv: formatRut(body) })}</span>
                  ) : r.formatted ? (
                    <span className={chipClass("bad")}><XCircle size={12} />{t("toolbox.rut.expected", { dv: r.expected })}</span>
                  ) : (
                    <span className={chipClass("bad")}>{t("toolbox.rut.malformed")}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <OptionsRow>
          <Labeled label={t("toolbox.quantity")}>
            <input type="number" min={1} max={1000} className={`${smallInput} w-20`} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
          </Labeled>
          <CheckLabel checked={dots} onChange={setDots} label={t("toolbox.rut.dots")} />
          <button type="button" className={buttonClass({ size: "sm" })} onClick={() => setAgain(again + 1)}>
            <RefreshCw size={13} />
            {t("toolbox.generate")}
          </button>
        </OptionsRow>
        <TextPane className="flex-1" label={t("toolbox.rut.generated")} value={generated} />
      </div>
    </div>
  );
}
