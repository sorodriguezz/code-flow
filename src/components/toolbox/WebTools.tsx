/** «Red y web»: URLs, subnets, HTTP statuses, MIME types, User-Agents, ports, chmod and colours. */
import { useMemo, useState } from "react";
import { CheckCircle2, Plus, X, XCircle } from "lucide-react";
import { iconButtonClass } from "../common/Button";
import { chipClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { useToolField } from "../../state/toolboxStore";
import {
  buildUrl,
  ipv4Subnet,
  ipv6Subnet,
  parseUrl,
  parseUserAgent,
  permissionsFromOctal,
  permissionsFromSymbolic,
  permissionsToOctal,
  permissionsToSymbolic,
  splitIpv4,
  type Permissions,
  type UrlParts,
} from "../../lib/toolbox/net";
import { HTTP_STATUSES, MIME_TYPES, PORTS, statusClass } from "../../lib/toolbox/reference";
import { contrastRatio, formatColor, parseColor, wcagGrades } from "../../lib/toolbox/color";
import { Checkbox } from "../common/Checkbox";
import { attempt, CopyButton, ErrorLine, FactTable, Labeled, OptionsRow, PaneHead, paneClass, smallInput, TextPane } from "./kit";

export function UrlParseTool() {
  const t = useT();
  const [input, setInput] = useToolField("url-parse", "input", "https://usuario:clave@api.example.com:8443/v1/items/42?expand=owner&tag=a&tag=b#detalle");
  const parsed = useMemo(() => (input.trim() ? attempt(() => parseUrl(input)) : { value: null, error: null }), [input]);
  const p = parsed.value;
  const update = (patch: Partial<UrlParts>) => {
    if (!p) return;
    const next = attempt(() => buildUrl({ ...p, ...patch }));
    if (next.value) setInput(next.value);
  };
  const field = (label: string, key: "protocol" | "username" | "password" | "hostname" | "port" | "pathname" | "hash") => (
    <label key={key} className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
      <span className="w-24 shrink-0">{label}</span>
      <input className={`${smallInput} flex-1 font-mono`} value={p?.[key] ?? ""} spellCheck={false} onChange={(e) => update({ [key]: e.target.value })} />
    </label>
  );
  return (
    <>
      <TextPane className="h-24 shrink-0" label="URL" value={input} onChange={setInput} error={parsed.error} />
      {p ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
          <div className="flex flex-col gap-2">
            {field(t("toolbox.urlparse.protocol"), "protocol")}
            {field(t("toolbox.urlparse.username"), "username")}
            {field(t("toolbox.urlparse.password"), "password")}
            {field(t("toolbox.urlparse.host"), "hostname")}
            {field(t("toolbox.urlparse.port"), "port")}
            {field(t("toolbox.urlparse.path"), "pathname")}
            {field(t("toolbox.urlparse.fragment"), "hash")}
            <FactTable rows={[[t("toolbox.urlparse.origin"), p.origin]]} />
          </div>
          <div className={paneClass}>
            <PaneHead label={t("toolbox.urlparse.query")}>
              <button type="button" className={iconButtonClass({ size: "xs" })} aria-label={t("toolbox.add")} onClick={() => update({ query: [...p.query, ["", ""]] })}>
                <Plus size={13} />
              </button>
            </PaneHead>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {p.query.map(([k, v], i) => (
                <div key={i} className="mb-1.5 flex items-center gap-1.5">
                  <input className={`${smallInput} w-40 font-mono`} value={k} onChange={(e) => update({ query: p.query.map((q, j) => (j === i ? [e.target.value, q[1]] : q)) })} />
                  <input className={`${smallInput} flex-1 font-mono`} value={v} onChange={(e) => update({ query: p.query.map((q, j) => (j === i ? [q[0], e.target.value] : q)) })} />
                  <button type="button" className={iconButtonClass({ size: "xs" })} aria-label={t("toolbox.remove")} onClick={() => update({ query: p.query.filter((_, j) => j !== i) })}>
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function CidrTool() {
  const t = useT();
  const [input, setInput] = useToolField("cidr", "input", "192.168.10.37/22");
  const [parts, setParts] = useToolField("cidr", "split", 4);
  const v6 = input.includes(":");
  const result = useMemo(() => attempt(() => (v6 ? ipv6Subnet(input) : ipv4Subnet(input))), [input, v6]);
  const split = useMemo(() => (!v6 && result.value ? attempt(() => splitIpv4(input, parts)) : null), [input, parts, v6, result.value]);
  const kindLabel = (k: string) => t(`toolbox.cidr.kind.${k}` as never);
  return (
    <>
      <OptionsRow>
        <input className={`${smallInput} h-[30px] w-80 font-mono text-[13px]`} value={input} spellCheck={false} onChange={(e) => setInput(e.target.value)} placeholder="10.0.0.0/8 · 2001:db8::/48" />
      </OptionsRow>
      <ErrorLine error={result.error} />
      {result.value ? (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
          {"netmask" in result.value ? (
            <FactTable
              rows={[
                [t("toolbox.cidr.address"), result.value.address],
                [t("toolbox.cidr.network"), `${result.value.network}/${result.value.prefix}`],
                [t("toolbox.cidr.netmask"), result.value.netmask],
                [t("toolbox.cidr.wildcard"), result.value.wildcard],
                [t("toolbox.cidr.broadcast"), result.value.broadcast],
                [t("toolbox.cidr.range"), `${result.value.firstHost} – ${result.value.lastHost}`],
                [t("toolbox.cidr.addresses"), result.value.size.toLocaleString()],
                [t("toolbox.cidr.hosts"), result.value.hosts.toLocaleString()],
                [t("toolbox.cidr.class"), result.value.ipClass],
                [t("toolbox.cidr.type"), kindLabel(result.value.kind)],
                [t("toolbox.cidr.binary"), result.value.binary],
              ]}
            />
          ) : (
            <FactTable
              rows={[
                [t("toolbox.cidr.address"), result.value.address],
                [t("toolbox.cidr.expanded"), result.value.expanded],
                [t("toolbox.cidr.network"), result.value.network],
                [t("toolbox.cidr.last"), result.value.last],
                [t("toolbox.cidr.addresses"), result.value.size],
                [t("toolbox.cidr.type"), kindLabel(result.value.kind)],
              ]}
            />
          )}
          {split ? (
            <div className="flex min-h-0 flex-col gap-2">
              <Labeled label={t("toolbox.cidr.split")}>
                <input type="number" min={1} max={1024} className={`${smallInput} w-20`} value={parts} onChange={(e) => setParts(Math.max(1, Number(e.target.value) || 1))} />
              </Labeled>
              <ErrorLine error={split.error} />
              {split.value ? <TextPane className="flex-1" label={t("toolbox.cidr.subnets")} value={split.value.join("\n")} /> : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function SearchTable({ tool, rows, placeholder }: { tool: string; rows: { key: string; cells: string[]; tone?: string }[]; placeholder: string }) {
  const [query, setQuery] = useToolField(tool, "query", "");
  const q = query.trim().toLowerCase();
  const hits = q ? rows.filter((r) => r.cells.some((c) => c.toLowerCase().includes(q))) : rows;
  return (
    <>
      <input className={`${smallInput} h-[30px] w-80 text-[13px]`} value={query} placeholder={placeholder} onChange={(e) => setQuery(e.target.value)} />
      <div className={`${paneClass} flex-1`}>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-[12.5px]">
            <tbody>
              {hits.map((r) => (
                <tr key={r.key} className="group border-b border-[var(--cf-border)]">
                  {r.cells.map((c, i) => (
                    <td key={i} className={`px-3 py-1.5 ${i === 0 ? `w-[1%] whitespace-nowrap font-mono ${r.tone ?? ""}` : i === r.cells.length - 1 ? "" : "w-[1%] whitespace-nowrap font-mono text-[var(--cf-text-muted)]"}`}>
                      {c}
                    </td>
                  ))}
                  <td className="w-[1%] px-1.5 opacity-0 group-hover:opacity-100">
                    <CopyButton text={r.cells.join(" ")} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

const STATUS_TONE = ["", "text-[var(--cf-blue)]", "text-[var(--cf-success)]", "text-[var(--cf-accent)]", "text-[var(--cf-warning)]", "text-[var(--cf-danger)]"];

export function HttpStatusTool() {
  const t = useT();
  const rows = HTTP_STATUSES.map(([code, phrase]) => ({ key: String(code), cells: [String(code), phrase, t(`toolbox.http.class${statusClass(code)}`)], tone: STATUS_TONE[statusClass(code)] }));
  return <SearchTable tool="http-status" rows={rows} placeholder={t("toolbox.searchTable")} />;
}

export function MimeTool() {
  const t = useT();
  const rows = MIME_TYPES.map(([ext, type]) => ({ key: ext, cells: [`.${ext}`, type] }));
  return <SearchTable tool="mime" rows={rows} placeholder={t("toolbox.searchTable")} />;
}

export function PortsTool() {
  const t = useT();
  const rows = PORTS.map(([port, proto, name]) => ({ key: `${port}-${proto}`, cells: [String(port), proto, name] }));
  return <SearchTable tool="ports" rows={rows} placeholder={t("toolbox.searchTable")} />;
}

export function UserAgentTool() {
  const t = useT();
  const [input, setInput] = useToolField("user-agent", "input", typeof navigator !== "undefined" ? navigator.userAgent : "");
  const info = parseUserAgent(input);
  return (
    <>
      <TextPane className="h-28 shrink-0" label="User-Agent" value={input} onChange={setInput} />
      <FactTable
        rows={[
          [t("toolbox.ua.browser"), [info.browser, info.browserVersion].filter(Boolean).join(" ") || "—"],
          [t("toolbox.ua.engine"), info.engine || "—"],
          [t("toolbox.ua.os"), [info.os, info.osVersion].filter(Boolean).join(" ") || "—"],
          [t("toolbox.ua.device"), t(`toolbox.ua.device.${info.device}`)],
        ]}
      />
    </>
  );
}

export function ChmodTool() {
  const t = useT();
  const [octal, setOctal] = useToolField("chmod", "octal", "755");
  const [error, setError] = useState<string | null>(null);
  const perms: Permissions = attempt(() => permissionsFromOctal(octal)).value ?? permissionsFromOctal("000");
  const write = (p: Permissions) => {
    setError(null);
    setOctal(permissionsToOctal(p));
  };
  const who = [t("toolbox.chmod.owner"), t("toolbox.chmod.group"), t("toolbox.chmod.others")];
  const what = [t("toolbox.chmod.read"), t("toolbox.chmod.write"), t("toolbox.chmod.execute")];
  const symbolic = permissionsToSymbolic(perms);
  return (
    <>
      <OptionsRow>
        <Labeled label={t("toolbox.chmod.octal")}>
          <input className={`${smallInput} h-[30px] w-24 font-mono text-[14px]`} value={octal} onChange={(e) => {
            setOctal(e.target.value);
            setError(attempt(() => permissionsFromOctal(e.target.value)).error);
          }} />
        </Labeled>
        <Labeled label={t("toolbox.chmod.symbolic")}>
          <input
            key={symbolic}
            className={`${smallInput} h-[30px] w-32 font-mono text-[14px]`}
            defaultValue={symbolic}
            onBlur={(e) => {
              const r = attempt(() => permissionsFromSymbolic(e.target.value));
              if (r.value) write(r.value);
              else setError(r.error);
            }}
          />
        </Labeled>
      </OptionsRow>
      <ErrorLine error={error} />
      <div className={`${paneClass} shrink-0`}>
        <table className="text-[12.5px]">
          <thead>
            <tr className="text-[var(--cf-text-faint)]">
              <th />
              {what.map((w) => (
                <th key={w} className="px-4 py-2 font-medium">{w}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {who.map((label, g) => (
              <tr key={label} className="border-t border-[var(--cf-border)]">
                <td className="px-3 py-2 text-[var(--cf-text-muted)]">{label}</td>
                {[0, 1, 2].map((b) => (
                  <td key={b} className="px-4 py-2 text-center">
                    <Checkbox checked={perms.bits[g][b]} onChange={(v) => write({ ...perms, bits: perms.bits.map((row, i) => (i === g ? row.map((x, j) => (j === b ? v : x)) : row)) })} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OptionsRow>
        {(["setuid", "setgid", "sticky"] as const).map((k) => (
          <label key={k} className="inline-flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <Checkbox checked={perms.special[k]} onChange={(v) => write({ ...perms, special: { ...perms.special, [k]: v } })} />
            {k}
          </label>
        ))}
      </OptionsRow>
      <FactTable rows={[["chmod", `chmod ${permissionsToOctal(perms)} ${t("toolbox.chmod.file")}`], ["ls -l", `-${symbolic}`]]} />
    </>
  );
}

export function ColorTool() {
  const t = useT();
  const [input, setInput] = useToolField("color", "input", "#3b82f6");
  const [bg, setBg] = useToolField("color", "bg", "#ffffff");
  const fg = useMemo(() => attempt(() => parseColor(input)), [input]);
  const back = useMemo(() => attempt(() => parseColor(bg)), [bg]);
  const formats = fg.value ? formatColor(fg.value) : null;
  const ratio = fg.value && back.value ? contrastRatio(fg.value, back.value) : null;
  const grades = ratio ? wcagGrades(ratio) : null;
  const Grade = ({ ok, label }: { ok: boolean; label: string }) => (
    <span className={chipClass(ok ? "ok" : "bad")}>{ok ? <CheckCircle2 size={12} /> : <XCircle size={12} />}{label}</span>
  );
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-2">
      <div className="flex min-h-0 flex-col gap-3">
        <OptionsRow>
          <input type="color" aria-label={t("toolbox.color.picker")} className="h-[30px] w-10 cursor-pointer rounded border border-[var(--cf-border)] bg-transparent" value={formats?.hex.slice(0, 7) ?? "#000000"} onChange={(e) => setInput(e.target.value)} />
          <input className={`${smallInput} h-[30px] w-64 font-mono text-[13px]`} value={input} spellCheck={false} onChange={(e) => setInput(e.target.value)} placeholder="#hex · rgb() · hsl() · oklch()" />
        </OptionsRow>
        <ErrorLine error={fg.error} />
        {formats ? (
          <>
            <div className="h-20 shrink-0 rounded-lg border border-[var(--cf-border)]" style={{ background: formats.rgb }} />
            <FactTable rows={[["HEX", formats.hex], ["RGB", formats.rgb], ["HSL", formats.hsl], ["OKLCH", formats.oklch], ["ARGB", formats.argbInt]]} />
          </>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-col gap-3">
        <OptionsRow>
          <Labeled label={t("toolbox.color.background")}>
            <input type="color" aria-label={t("toolbox.color.background")} className="h-[30px] w-10 cursor-pointer rounded border border-[var(--cf-border)] bg-transparent" value={back.value ? formatColor(back.value).hex.slice(0, 7) : "#ffffff"} onChange={(e) => setBg(e.target.value)} />
            <input className={`${smallInput} h-[30px] w-40 font-mono`} value={bg} onChange={(e) => setBg(e.target.value)} />
          </Labeled>
        </OptionsRow>
        <ErrorLine error={back.error} />
        {ratio && formats && back.value ? (
          <>
            <div className="rounded-lg border border-[var(--cf-border)] px-4 py-5" style={{ background: formatColor(back.value).rgb, color: formats.rgb }}>
              <div className="text-[22px] font-semibold">{t("toolbox.color.sampleLarge")}</div>
              <div className="text-[13px]">{t("toolbox.color.sampleNormal")}</div>
            </div>
            <div className="text-[26px] font-semibold tabular-nums text-[var(--cf-text)]">{ratio.toFixed(2)}:1</div>
            <OptionsRow>
              <Grade ok={grades!.aaNormal} label={t("toolbox.color.aaNormal")} />
              <Grade ok={grades!.aaLarge} label={t("toolbox.color.aaLarge")} />
              <Grade ok={grades!.aaaNormal} label={t("toolbox.color.aaaNormal")} />
              <Grade ok={grades!.aaaLarge} label={t("toolbox.color.aaaLarge")} />
            </OptionsRow>
          </>
        ) : null}
      </div>
    </div>
  );
}
