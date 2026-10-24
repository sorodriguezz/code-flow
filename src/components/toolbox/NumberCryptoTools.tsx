/** «Números» and «Certificados y cifrado»: bases, byte sizes, X.509, key pairs and AES-GCM. */
import { useMemo, useState } from "react";
import { KeyRound } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { buttonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import { byteTable, formatBigInt, parseBigInt, parseByteSize, twosComplement } from "../../lib/toolbox/numbers";
import { fingerprint, formatName, parseCertificates } from "../../lib/toolbox/x509";
import { decryptText, encryptText, generateKeyPair, KEY_PAIR_KINDS, PBKDF2_ITERATIONS, type GeneratedKeyPair, type KeyPairKind } from "../../lib/toolbox/cryptoTools";
import { relativeTime, toLocalIso } from "../../lib/toolbox/time";
import { attempt, ErrorLine, FactTable, Labeled, OptionsRow, paneClass, smallInput, Split, TextPane, useAsyncResult } from "./kit";
import { CheckLabel } from "./EncodeTools";

const BASES = [
  { value: "10", label: "10" },
  { value: "16", label: "16" },
  { value: "2", label: "2" },
  { value: "8", label: "8" },
  { value: "36", label: "36" },
];

export function BaseTool() {
  const t = useT();
  const [input, setInput] = useToolField("base", "input", "255");
  const [base, setBase] = useToolField("base", "from", "10");
  const [group, setGroup] = useToolField("base", "group", true);
  const parsed = useMemo(() => (input.trim() ? attempt(() => parseBigInt(input, Number(base))) : { value: null, error: null }), [input, base]);
  const n = parsed.value;
  return (
    <>
      <OptionsRow>
        <input className={`${smallInput} h-[30px] w-80 font-mono text-[13px]`} value={input} spellCheck={false} onChange={(e) => setInput(e.target.value)} />
        <Labeled label={t("toolbox.base.from")}>
          <Select size="compact" value={base} onChange={setBase} options={BASES} />
        </Labeled>
        <CheckLabel checked={group} onChange={setGroup} label={t("toolbox.base.group")} />
      </OptionsRow>
      <ErrorLine error={parsed.error} />
      {n !== null ? (
        <FactTable
          rows={[
            [t("toolbox.base.decimal"), formatBigInt(n, 10, group ? 3 : 0)],
            [t("toolbox.base.hex"), formatBigInt(n, 16, group ? 4 : 0).toUpperCase()],
            [t("toolbox.base.octal"), formatBigInt(n, 8, group ? 3 : 0)],
            [t("toolbox.base.binary"), formatBigInt(n, 2, group ? 4 : 0)],
            ["Base 36", formatBigInt(n, 36)],
            [t("toolbox.base.bits"), String((n < 0n ? -n : n).toString(2).length)],
            ...[8, 16, 32, 64].map((bits): [string, string | null] => [t("toolbox.base.twos", { bits }), twosComplement(n, bits)]),
          ]}
        />
      ) : null}
    </>
  );
}

export function BytesTool() {
  const t = useT();
  const [input, setInput] = useToolField("bytes", "input", "1.5 GiB");
  const parsed = useMemo(() => attempt(() => parseByteSize(input)), [input]);
  const fmt = (v: number) => (v >= 1e15 || (v > 0 && v < 1e-6) ? v.toExponential(4) : Number(v.toPrecision(10)).toLocaleString(undefined, { maximumFractionDigits: 6 }));
  return (
    <>
      <OptionsRow>
        <input className={`${smallInput} h-[30px] w-64 font-mono text-[13px]`} value={input} spellCheck={false} onChange={(e) => setInput(e.target.value)} />
        <span className="text-[11.5px] text-[var(--cf-text-faint)]">1.5 GiB · 200MB · 8 Mbit · 1048576</span>
      </OptionsRow>
      <ErrorLine error={parsed.error} />
      {parsed.value !== null ? (
        <Split>
          <FactTable rows={[[t("toolbox.bytes.bits"), fmt(parsed.value * 8)], ...byteTable(parsed.value, "si").map(({ unit, value }): [string, string] => [unit, fmt(value)])]} />
          <FactTable rows={byteTable(parsed.value, "iec").map(({ unit, value }): [string, string] => [unit, fmt(value)])} />
        </Split>
      ) : null}
    </>
  );
}

export function CertTool() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [input, setInput] = useToolField("cert", "input", "");
  const certs = useMemo(() => (input.trim() ? attempt(() => parseCertificates(input)) : { value: [], error: null }), [input]);
  const prints = useAsyncResult(async () => Promise.all((certs.value ?? []).map(async (c) => [await fingerprint(c.der, "SHA-256"), await fingerprint(c.der, "SHA-1")] as const)), [certs.value]);
  const now = Date.now();
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
      <TextPane label={t("toolbox.cert.input")} value={input} onChange={setInput} error={certs.error} placeholder="-----BEGIN CERTIFICATE-----" />
      <div className="flex min-h-0 flex-col gap-3 overflow-auto">
        {(certs.value ?? []).map((c, i) => {
          const expired = c.notAfter.getTime() < now;
          const early = c.notBefore.getTime() > now;
          return (
            <div key={i} className="flex flex-col gap-2">
              <OptionsRow>
                {(certs.value?.length ?? 0) > 1 ? <span className={chipClass("neutral")}>#{i + 1}</span> : null}
                <span className={chipClass(expired ? "bad" : early ? "warn" : "ok")}>{t(expired ? "toolbox.cert.expired" : early ? "toolbox.cert.notYet" : "toolbox.cert.valid")}</span>
                {c.isCa ? <span className={chipClass("info")}>CA</span> : null}
                {c.selfSigned ? <span className={chipClass("neutral")}>{t("toolbox.cert.selfSigned")}</span> : null}
              </OptionsRow>
              <FactTable
                className="shrink-0"
                rows={[
                  [t("toolbox.cert.subject"), formatName(c.subject)],
                  [t("toolbox.cert.issuer"), formatName(c.issuer)],
                  [t("toolbox.cert.notBefore"), toLocalIso(c.notBefore)],
                  [t("toolbox.cert.notAfter"), `${toLocalIso(c.notAfter)} · ${relativeTime(c.notAfter, language)}`],
                  [t("toolbox.cert.sans"), c.subjectAltNames.length ? c.subjectAltNames.join(", ") : null],
                  [t("toolbox.cert.publicKey"), `${c.publicKey.algorithm} ${c.publicKey.detail}`.trim()],
                  [t("toolbox.cert.signature"), c.signatureAlgorithm],
                  [t("toolbox.cert.serial"), c.serial],
                  [t("toolbox.cert.version"), `v${c.version}`],
                  [t("toolbox.cert.keyUsage"), c.keyUsage.length ? c.keyUsage.join(", ") : null],
                  [t("toolbox.cert.extKeyUsage"), c.extendedKeyUsage.length ? c.extendedKeyUsage.join(", ") : null],
                  ["SHA-256", prints.value?.[i]?.[0]],
                  ["SHA-1", prints.value?.[i]?.[1]],
                ]}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function KeyPairTool() {
  const t = useT();
  const [kind, setKind] = useToolField<KeyPairKind>("keypair", "kind", "P-256");
  const [format, setFormat] = useToolField<"pem" | "jwk">("keypair", "format", "pem");
  const [pair, setPair] = useState<GeneratedKeyPair | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      setPair(await generateKeyPair(kind));
    } catch (err) {
      setError(kind === "Ed25519" ? t("toolbox.keypair.noEd25519") : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.keypair.type")}>
          <Select size="compact" value={kind} onChange={(v) => setKind(v as KeyPairKind)} options={KEY_PAIR_KINDS.map((k) => ({ value: k, label: k }))} />
        </Labeled>
        <Segmented layoutId="toolbox-kp-format" size="sm" value={format} onChange={setFormat} options={[{ value: "pem", label: "PEM" }, { value: "jwk", label: "JWK" }]} />
        <button type="button" className={buttonClass({ variant: "primary", size: "sm" })} disabled={busy} onClick={() => void generate()}>
          <KeyRound size={13} />
          {busy ? t("toolbox.keypair.generating") : t("toolbox.generate")}
        </button>
      </OptionsRow>
      <ErrorLine error={error} />
      <Split>
        <TextPane label={t("toolbox.keypair.public")} value={pair ? (format === "pem" ? pair.publicPem : JSON.stringify(pair.publicJwk, null, 2)) : ""} />
        <TextPane label={t("toolbox.keypair.private")} value={pair ? (format === "pem" ? pair.privatePem : JSON.stringify(pair.privateJwk, null, 2)) : ""} />
      </Split>
      <p className="shrink-0 text-[11.5px] text-[var(--cf-text-faint)]">{t("toolbox.keypair.note")}</p>
    </>
  );
}

export function AesTool() {
  const t = useT();
  const [mode, setMode] = useToolField<"encrypt" | "decrypt">("aes", "mode", "encrypt");
  const [input, setInput] = useToolField("aes", "input", "");
  const [pass, setPass] = useToolField("aes", "pass", "");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // On a button rather than live: 600 000 PBKDF2 rounds per keystroke would make typing stutter.
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setOutput(mode === "encrypt" ? await encryptText(input, pass) : await decryptText(input.trim(), pass));
    } catch (err) {
      setOutput("");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId="toolbox-aes-mode"
          size="sm"
          value={mode}
          onChange={(v) => {
            setMode(v);
            setOutput("");
          }}
          options={[{ value: "encrypt", label: t("toolbox.aes.encrypt") }, { value: "decrypt", label: t("toolbox.aes.decrypt") }]}
        />
        <Labeled label={t("toolbox.aes.passphrase")}>
          <input type="password" autoComplete="off" className={`${smallInput} w-64`} value={pass} onChange={(e) => setPass(e.target.value)} />
        </Labeled>
        <button type="button" className={buttonClass({ variant: "primary", size: "sm" })} disabled={busy || !pass || !input} onClick={() => void run()}>
          {busy ? t("toolbox.aes.working") : t(mode === "encrypt" ? "toolbox.aes.encrypt" : "toolbox.aes.decrypt")}
        </button>
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} />
        <TextPane label={t("toolbox.output")} value={output} error={error} />
      </Split>
      <p className={`${paneClass} shrink-0 px-3 py-2 text-[11.5px] text-[var(--cf-text-faint)]`}>{t("toolbox.aes.format", { iterations: PBKDF2_ITERATIONS.toLocaleString() })}</p>
    </>
  );
}
