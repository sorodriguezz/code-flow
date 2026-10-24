/** «JWT»: decode and verify a token, and build an HMAC-signed one. */
import { useMemo } from "react";
import { CheckCircle2, CircleAlert, XCircle } from "lucide-react";
import { Select } from "../common/Select";
import { chipClass } from "../common/recipes";
import { useLanguageStore, useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import { claimTimes, decodeJwt, HMAC_ALGS, needsSecret, signHmacJwt, tokenStatus, verifyJwt, type HmacAlg } from "../../lib/toolbox/jwt";
import { relativeTime, toLocalIso } from "../../lib/toolbox/time";
import { attempt, FactTable, Labeled, OptionsRow, PaneHead, paneClass, TextPane, useAsyncResult } from "./kit";
import { CheckLabel } from "./EncodeTools";

/** A token signed with the made-up secret below, so "Ejemplo" shows a signature that checks out. */
const SAMPLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkV4YW1wbGUgVXNlciIsImlhdCI6MTUxNjIzOTAyMn0.Zh4pKkZUuXapehqIXNCw9sfhHkndE8mbRVx3CkAhh68";
const SAMPLE_SECRET = "secreto-de-ejemplo";

export function JwtTool() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const [token, setToken] = useToolField("jwt", "token", "");
  const [key, setKey] = useToolField("jwt", "key", "");
  const [b64Secret, setB64Secret] = useToolField("jwt", "b64Secret", false);
  const decoded = useMemo(() => (token.trim() ? attempt(() => decodeJwt(token)) : { value: null, error: null }), [token]);
  const alg = decoded.value?.header.alg;
  const verify = useAsyncResult(() => (decoded.value && key.trim() ? verifyJwt(token, key, b64Secret) : null), [token, key, b64Secret, decoded.value]);
  const times = decoded.value ? claimTimes(decoded.value.payload) : [];
  const status = decoded.value ? tokenStatus(decoded.value.payload) : null;
  const claimLabel: Record<string, string> = {
    exp: t("toolbox.jwt.exp"),
    iat: t("toolbox.jwt.iat"),
    nbf: t("toolbox.jwt.nbf"),
    auth_time: t("toolbox.jwt.authTime"),
  };
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col gap-3">
        <TextPane
          label={t("toolbox.jwt.token")}
          value={token}
          onChange={setToken}
          placeholder="eyJhbGciOi…"
          error={decoded.error}
          extra={
            !token ? (
              <button type="button" className="px-1.5 text-[11px] text-[var(--cf-accent)] hover:underline" onClick={() => {
                  setToken(SAMPLE);
                  setKey(SAMPLE_SECRET);
                }}>
                {t("toolbox.sample")}
              </button>
            ) : null
          }
        />
        <div className={`${paneClass} shrink-0`}>
          <PaneHead label={needsSecret(alg) || !alg ? t("toolbox.jwt.secret") : t("toolbox.jwt.publicKey")}>
            {needsSecret(alg) ? <CheckLabel checked={b64Secret} onChange={setB64Secret} label={t("toolbox.jwt.secretB64")} /> : null}
          </PaneHead>
          <textarea
            className="h-24 w-full resize-none bg-transparent px-3 py-2 font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)]"
            value={key}
            spellCheck={false}
            placeholder={needsSecret(alg) || !alg ? t("toolbox.jwt.secretPlaceholder") : "-----BEGIN PUBLIC KEY----- / CERTIFICATE / JWK"}
            onChange={(e) => setKey(e.target.value)}
          />
          {key.trim() && decoded.value ? (
            <div className="flex items-center gap-2 border-t border-[var(--cf-border)] px-3 py-1.5 text-[12px]">
              {verify.error ? (
                <span className="text-[var(--cf-danger)]">{verify.error}</span>
              ) : verify.value === true ? (
                <span className="inline-flex items-center gap-1.5 text-[var(--cf-success)]">
                  <CheckCircle2 size={14} /> {t("toolbox.jwt.signatureOk", { alg: String(alg) })}
                </span>
              ) : verify.value === false ? (
                <span className="inline-flex items-center gap-1.5 text-[var(--cf-danger)]">
                  <XCircle size={14} /> {t("toolbox.jwt.signatureBad")}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        {times.length ? (
          <FactTable
            className="shrink-0"
            rows={times.map((c) => [claimLabel[c.claim], `${toLocalIso(c.date)} · ${relativeTime(c.date, language)}`])}
          />
        ) : null}
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        {status ? (
          <OptionsRow>
            <span className={chipClass("neutral")}>alg: {String(alg ?? "?")}</span>
            {decoded.value?.header.kid ? <span className={chipClass("neutral")}>kid: {String(decoded.value.header.kid)}</span> : null}
            <span className={chipClass(status === "valid" ? "ok" : status === "expired" ? "bad" : "warn")}>
              {status === "valid" ? <CheckCircle2 size={12} /> : <CircleAlert size={12} />}
              {t(status === "valid" ? "toolbox.jwt.active" : status === "expired" ? "toolbox.jwt.expired" : "toolbox.jwt.notYet")}
            </span>
          </OptionsRow>
        ) : null}
        <TextPane className="max-h-[35%]" label={t("toolbox.jwt.header")} value={decoded.value ? JSON.stringify(decoded.value.header, null, 2) : ""} />
        <TextPane
          label={t("toolbox.jwt.payload")}
          value={decoded.value ? (typeof decoded.value.payload === "string" ? decoded.value.payload : JSON.stringify(decoded.value.payload, null, 2)) : ""}
        />
      </div>
    </div>
  );
}

export function JwtSignTool() {
  const t = useT();
  const now = Math.floor(Date.now() / 1000);
  const [payload, setPayload] = useToolField("jwt-sign", "payload", JSON.stringify({ sub: "user-123", name: "Example User", role: "admin", iat: now, exp: now + 3600 }, null, 2));
  const [header, setHeader] = useToolField("jwt-sign", "header", "{}");
  const [secret, setSecret] = useToolField("jwt-sign", "secret", "");
  const [alg, setAlg] = useToolField<HmacAlg>("jwt-sign", "alg", "HS256");
  const [b64, setB64] = useToolField("jwt-sign", "b64", false);
  const result = useAsyncResult(async () => {
    if (!secret) return "";
    let p: unknown;
    let h: Record<string, unknown>;
    try {
      p = JSON.parse(payload);
    } catch {
      throw new Error(t("toolbox.jwt.payloadNotJson"));
    }
    try {
      h = header.trim() ? JSON.parse(header) : {};
    } catch {
      throw new Error(t("toolbox.jwt.headerNotJson"));
    }
    return signHmacJwt(p, secret, alg, h, b64);
  }, [payload, header, secret, alg, b64, t]);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.jwt.algorithm")}>
          <Select size="compact" value={alg} onChange={(v) => setAlg(v as HmacAlg)} options={HMAC_ALGS.map((a) => ({ value: a, label: a }))} />
        </Labeled>
        <Labeled label={t("toolbox.jwt.secret")}>
          <input
            className="h-[26px] w-64 min-w-0 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2 font-mono text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]"
            value={secret}
            spellCheck={false}
            onChange={(e) => setSecret(e.target.value)}
          />
        </Labeled>
        <CheckLabel checked={b64} onChange={setB64} label={t("toolbox.jwt.secretB64")} />
      </OptionsRow>
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="flex min-h-0 flex-col gap-3">
          <TextPane label={t("toolbox.jwt.payload")} value={payload} onChange={setPayload} />
          <TextPane className="max-h-36" label={t("toolbox.jwt.extraHeader")} value={header} onChange={setHeader} />
        </div>
        <TextPane label={t("toolbox.jwt.token")} value={result.value ?? ""} error={result.error} placeholder={t("toolbox.jwt.needSecret")} />
      </div>
    </>
  );
}
