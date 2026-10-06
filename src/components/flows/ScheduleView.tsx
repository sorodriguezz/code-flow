import { useEffect, useMemo, useState } from "react";
import { AlarmClock, Copy, Globe, KeyRound, Plus, Radio, Webhook, Wrench } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Select } from "../common/Select";
import { iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { nodeIcon } from "../../lib/flows/nodeIcons";
import { autostartEnabled, setAutostart } from "../../lib/tauri/windows";
import { getSetting, setSetting } from "../../lib/tauri/commands";
import {
  flowsMcpInfo,
  flowsMcpRotate,
  flowsTunnelSet,
  flowsTunnelStatus,
  type FlowArmedView,
  type FlowMcpInfo,
  type FlowTriggerView,
  type FlowTunnelStatus,
} from "../../lib/tauri/flowsCommands";
import { mcpList, mcpSave } from "../../lib/tauri/mcpCommands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useFlowRunsStore } from "../../state/flowRunsStore";
import { useFlowsStore } from "../../state/flowsStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { formatWhen } from "./runFormat";
import { WaitCard } from "./WaitCard";

/**
 * Programación: everything that can start a flow of this workspace on its own — the schedules on a
 * ruler of the next 24 hours, the webhooks with their URLs, and what is being watched or polled — with
 * the switch that turns each flow on or off. And the one setting that decides whether any of it runs
 * after a restart: opening CodeFlow at login.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function relative(iso: string | null, language: string): string {
  if (!iso) return "";
  const diff = Date.parse(iso) - Date.now();
  if (diff <= 0) return formatWhen(iso, language);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const minutes = Math.round(diff / 60000);
  if (minutes < 60) return rtf.format(Math.max(minutes, 1), "minute");
  const hours = Math.round(diff / 3600000);
  if (hours < 48) return rtf.format(hours, "hour");
  return rtf.format(Math.round(diff / DAY_MS), "day");
}

function clock(iso: string, language: string): string {
  const date = new Date(iso);
  const sameDay = new Date().toDateString() === date.toDateString();
  return date.toLocaleString(language, sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function Ruler({ rows }: { rows: { flow: FlowArmedView; trigger: FlowTriggerView }[] }) {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const now = Date.now();
  const marks = Array.from({ length: 8 }, (_, i) => now + ((i + 1) * DAY_MS) / 8);
  const left = (at: number) => `${Math.min(Math.max((at - now) / DAY_MS, 0), 1) * 100}%`;
  return (
    <div className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] px-4 py-3">
      <div className="mb-2 grid grid-cols-[180px_minmax(0,1fr)] items-end gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t("flows.schedule.next24")}</span>
        <div className="relative h-4 text-[10.5px] text-[var(--cf-text-faint)]">
          <span className="absolute left-0 -translate-x-0 font-semibold text-[var(--cf-accent)]">{t("flows.schedule.now")}</span>
          {marks.map((at) => (
            <span key={at} className="absolute -translate-x-1/2 tabular-nums" style={{ left: left(at) }}>
              {new Date(at).toLocaleTimeString(language, { hour: "2-digit", minute: "2-digit" })}
            </span>
          ))}
        </div>
      </div>
      {rows.map(({ flow, trigger }) => (
        <div key={`${flow.flowId}:${trigger.nodeId}`} className="grid grid-cols-[180px_minmax(0,1fr)] items-center gap-3 py-[5px]">
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--cf-text)]" title={trigger.detail}>
            <AlarmClock size={12} className="shrink-0 text-[var(--cf-flow-trigger,var(--cf-accent))]" />
            <span className="truncate">{flow.flowName}</span>
          </span>
          <span className="relative h-[14px] rounded-[4px] bg-[var(--cf-hover)]">
            {trigger.upcoming.map((at) => (
              <span
                key={at}
                className={`absolute top-[2px] -translate-x-1/2 rounded-full bg-[var(--cf-accent)] ${trigger.upcoming.length > 30 ? "h-[10px] w-[2px]" : "h-[10px] w-[10px]"}`}
                style={{ left: left(Date.parse(at)) }}
                title={clock(at, language)}
              />
            ))}
          </span>
        </div>
      ))}
    </div>
  );
}

const OUTCOME_KEY: Record<string, TranslationKey> = {
  started: "flows.schedule.outcomeStarted",
  skipped: "flows.schedule.outcomeSkipped",
  queued: "flows.schedule.outcomeQueued",
  missed: "flows.schedule.outcomeMissed",
};

/** The name the flows' MCP server is registered under, in CodeFlow and in the commands shown. */
const MCP_NAME = "codeflow-flujos";

/**
 * Flows as tools for AI agents (`flows::mcp`): where the server is, the token it wants, the ready
 * lines for Claude Code and Codex, and one click to add it to CodeFlow's own MCP list — after which
 * the Chat and an Agente CLI node can switch it on like any other server. The tools themselves are
 * the active flows whose trigger is «Herramienta de IA», listed under it.
 */
function McpSection() {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const triggers = useFlowRunsStore((s) => s.triggers);
  const [info, setInfo] = useState<FlowMcpInfo | null>(null);
  // Re-read when the armed flows change: a tool appears when its flow is switched on.
  useEffect(() => {
    let alive = true;
    void flowsMcpInfo()
      .then((next) => alive && setInfo(next))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [triggers]);
  if (!info) return null;
  const copy = (text: string) => void navigator.clipboard?.writeText(text).then(() => pushSuccessToast(t("flows.schedule.copied")));
  const claude = `claude mcp add --transport http ${MCP_NAME} ${info.url} --header "Authorization: Bearer ${info.token}"`;
  // Codex reads the token from an environment variable rather than from its config file.
  const codex = `# export CODEFLOW_FLUJOS_TOKEN=${info.token}\n[mcp_servers.${MCP_NAME.replace(/-/g, "_")}]\nurl = "${info.url}"\nbearer_token_env_var = "CODEFLOW_FLUJOS_TOKEN"`;
  const addToCodeFlow = async () => {
    if (!workspaceId) return;
    try {
      const existing = (await mcpList(workspaceId)).find((server) => server.name === MCP_NAME);
      await mcpSave({
        id: existing?.id ?? null,
        workspaceId,
        scope: "global",
        name: MCP_NAME,
        transport: "http",
        command: "",
        args: [],
        env: {},
        url: info.url,
        headers: { Authorization: `Bearer ${info.token}` },
        enabled: true,
        defaultOn: false,
        excluded: [],
      });
      pushSuccessToast(t("flows.mcp.added"));
    } catch (error) {
      pushErrorToast(String(error));
    }
  };
  return (
    <section className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
      <h3 className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold">
        <Wrench size={14} />
        <span className="min-w-0 flex-1 truncate">{t("flows.mcp.title")}</span>
        <button type="button" className={iconButtonClass({ size: "xs" })} title={t("flows.mcp.copyClaude")} aria-label={t("flows.mcp.copyClaude")} onClick={() => copy(claude)}>
          <Copy size={12} />
        </button>
        <button type="button" className={iconButtonClass({ size: "xs" })} title={t("flows.mcp.copyCodex")} aria-label={t("flows.mcp.copyCodex")} onClick={() => copy(codex)}>
          <KeyRound size={12} />
        </button>
        <button type="button" className={iconButtonClass({ size: "xs" })} title={t("flows.mcp.addToCodeFlow")} aria-label={t("flows.mcp.addToCodeFlow")} onClick={() => void addToCodeFlow()}>
          <Plus size={12} />
        </button>
      </h3>
      <div className="flex min-w-0 items-center gap-2" title={t("flows.mcp.hint")}>
        <code className="min-w-0 flex-1 truncate text-[12px]">{info.url}</code>
        <button
          type="button"
          className="text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          title={t("flows.mcp.rotateHint")}
          onClick={() =>
            void flowsMcpRotate()
              .then(() => flowsMcpInfo())
              .then(setInfo)
              .then(() => pushSuccessToast(t("flows.mcp.rotated")))
              .catch((error) => pushErrorToast(String(error)))
          }
        >
          {t("flows.mcp.rotate")}
        </button>
      </div>
      {info.tools.map((tool) => (
        <div key={tool.name} className="flex min-w-0 items-baseline gap-2 border-t border-[var(--cf-border)] py-1.5 first-of-type:border-t-0">
          <code className="shrink-0 text-[12px] font-semibold">{tool.name}</code>
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]" title={tool.description}>
            {tool.flowName} · {tool.description}
          </span>
        </div>
      ))}
    </section>
  );
}

/**
 * Whether the webhooks are reachable from the internet, and through what — `cloudflared`'s quick
 * tunnel or Tailscale Funnel (`flows::tunnel`). A compact select in the section's header rather than a
 * panel: it is one decision, and its consequence (a webhook without a credential is refused through
 * it) is the tooltip.
 */
function TunnelControl() {
  const t = useT();
  const [status, setStatus] = useState<FlowTunnelStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void flowsTunnelStatus()
      .then((next) => alive && setStatus(next))
      .catch(() => {});
    const unlisten = listen<FlowTunnelStatus>("flows:tunnel", (event) => setStatus(event.payload));
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, []);
  if (!status) return null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[11px] font-normal text-[var(--cf-text-muted)]" title={t("flows.tunnel.hint")}>
      <Globe size={12} />
      {status.starting ? t("flows.tunnel.starting") : status.error ? <span className="max-w-[180px] truncate text-[var(--cf-danger)]" title={status.error}>{status.error}</span> : null}
      <div className="w-[150px]">
        <Select
          size="sm"
          ariaLabel={t("flows.tunnel.title")}
          value={status.kind}
          onChange={(kind) =>
            void flowsTunnelSet(kind as FlowTunnelStatus["kind"])
              .then(setStatus)
              .catch((error) => pushErrorToast(String(error)))
          }
          options={[
            { value: "off", label: t("flows.tunnel.off") },
            { value: "cloudflared", label: t("flows.tunnel.cloudflared") },
            { value: "tailscale", label: t("flows.tunnel.tailscale") },
          ]}
        />
      </div>
    </span>
  );
}

export function ScheduleView() {
  const t = useT();
  const language = useLanguageStore((s) => s.language);
  const armed = useFlowRunsStore((s) => s.triggers);
  const waits = useFlowRunsStore((s) => s.waits);
  const flows = useFlowsStore((s) => s.flows);
  const [launchAtLogin, setLaunchAtLogin] = useState<boolean | null>(null);
  const [background, setBackground] = useState(false);
  const [, setTick] = useState(0);

  useEffect(() => {
    void useFlowRunsStore.getState().loadTriggers();
    void autostartEnabled()
      .then(setLaunchAtLogin)
      .catch(() => setLaunchAtLogin(null));
    void getSetting("flows_background_at_login")
      .then((value) => setBackground(value === "1"))
      .catch(() => {});
    const timer = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const byFlow = useMemo(() => new Map(armed.map((flow) => [flow.flowId, flow])), [armed]);
  const schedules = armed.flatMap((flow) => flow.triggers.filter((tr) => tr.typeId === "trigger.schedule").map((trigger) => ({ flow, trigger })));
  const hooks = armed.flatMap((flow) => flow.triggers.filter((tr) => tr.typeId === "trigger.webhook").map((trigger) => ({ flow, trigger })));
  const listeners = armed.flatMap((flow) =>
    flow.triggers
      .filter((tr) => !["trigger.schedule", "trigger.webhook"].includes(tr.typeId))
      .map((trigger) => ({ flow, trigger })),
  );
  // Every flow of the workspace that could start on its own, active or not: the table is where one
  // is switched on.
  const automatic = flows.filter((flow) => flow.triggers.some((type) => type !== "trigger.manual"));

  const toggle = (id: string, active: boolean) => void useFlowsStore.getState().setActive(id, active);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--cf-sunken)]" data-tour="flows-schedule">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 px-6 py-5">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[16px] font-semibold">{t("flows.schedule.title")}</h2>
          <span className="text-[12px] text-[var(--cf-text-muted)]">
            {t("flows.schedule.counts", { schedules: schedules.length, hooks: hooks.length, listeners: listeners.length })}
          </span>
          <span className="flex-1" />
          <span className="text-[11.5px] text-[var(--cf-text-faint)]">
            {new Date().toLocaleString(language, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} ·{" "}
            {Intl.DateTimeFormat().resolvedOptions().timeZone}
          </span>
        </div>

        {waits.length > 0 && (
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-muted)]">{t("flows.wait.section")}</h3>
            {[...waits]
              .sort((a, b) => Number(b.kind === "approval") - Number(a.kind === "approval"))
              .map((wait) => (
                <WaitCard key={wait.id} wait={wait} />
              ))}
          </section>
        )}

        {schedules.length > 0 && <Ruler rows={schedules} />}

        <div className="overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)]">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
                <th className="px-4 py-2 font-semibold">{t("flows.schedule.flow")}</th>
                <th className="px-3 py-2 font-semibold">{t("flows.schedule.when")}</th>
                <th className="px-3 py-2 font-semibold">{t("flows.schedule.nextRun")}</th>
                <th className="px-3 py-2 font-semibold">{t("flows.schedule.lastRun")}</th>
                <th className="w-[80px] px-3 py-2 font-semibold">{t("flows.active.on")}</th>
              </tr>
            </thead>
            <tbody>
              {automatic.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-4 text-[12px] text-[var(--cf-text-muted)]">
                    {t("flows.schedule.none")}
                  </td>
                </tr>
              )}
              {automatic.map((flow) => {
                const view = byFlow.get(flow.id);
                const triggers = view?.triggers ?? [];
                const next = triggers.map((tr) => tr.next).filter((n): n is string => !!n).sort()[0] ?? null;
                const last = triggers
                  .filter((tr) => tr.lastFired)
                  .sort((a, b) => (b.lastFired ?? "").localeCompare(a.lastFired ?? ""))[0];
                const problem = triggers.find((tr) => tr.problem)?.problem;
                return (
                  <tr key={flow.id} className="border-t border-[var(--cf-border)] align-top">
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1.5 text-left font-medium hover:underline"
                        onClick={() => {
                          void useFlowsStore.getState().openFlow(flow.id);
                          useFlowRunsStore.getState().setPane("editor");
                        }}
                      >
                        <span className="truncate">{flow.name}</span>
                        {flow.scope === "global" && <Globe size={11} className="shrink-0 text-[var(--cf-text-faint)]" />}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      {view ? (
                        triggers.map((tr) => {
                          const Icon = nodeIcon(tr.typeId === "trigger.schedule" ? "alarm-clock" : tr.typeId === "trigger.webhook" ? "webhook" : "radio-tower");
                          return (
                            <div key={tr.nodeId} className="flex min-w-0 items-center gap-1.5 text-[var(--cf-text)]">
                              <Icon size={12} className="shrink-0 text-[var(--cf-text-faint)]" />
                              <span className="truncate" title={tr.nodeName}>
                                {triggerDetail(tr, t)}
                              </span>
                            </div>
                          );
                        })
                      ) : (
                        <span className="text-[var(--cf-text-faint)]">
                          {flow.triggers
                            .filter((type) => type !== "trigger.manual")
                            .map((type) => t(`flows.node.${type}` as TranslationKey))
                            .join(", ")}
                        </span>
                      )}
                      {problem && <div className="mt-0.5 text-[11.5px] text-[var(--cf-danger)]">{problem}</div>}
                    </td>
                    <td className="px-3 py-2">
                      {view ? (
                        next ? (
                          <>
                            <b className="font-semibold">{clock(next, language)}</b>
                            <div className="text-[11.5px] text-[var(--cf-text-muted)]">{relative(next, language)}</div>
                          </>
                        ) : (
                          <span className="text-[var(--cf-text-muted)]">{t("flows.schedule.onEvent")}</span>
                        )
                      ) : (
                        <span className="text-[var(--cf-text-faint)]">{t("flows.active.off")}</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {last?.lastFired ? (
                        <>
                          <span>{formatWhen(last.lastFired, language)}</span>
                          {last.lastOutcome && OUTCOME_KEY[last.lastOutcome] && (
                            <div className="text-[11.5px] text-[var(--cf-text-muted)]">{t(OUTCOME_KEY[last.lastOutcome])}</div>
                          )}
                        </>
                      ) : (
                        <span className="text-[var(--cf-text-faint)]">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={flow.active}
                        aria-label={t("flows.schedule.toggle", { name: flow.name })}
                        onClick={() => toggle(flow.id, !flow.active)}
                        className="relative mt-[2px] h-[16px] w-[28px] rounded-full transition-colors"
                        style={{ background: flow.active ? "var(--cf-success)" : "var(--cf-border-strong)" }}
                      >
                        <span
                          className="absolute left-0 top-[2px] h-3 w-3 rounded-full bg-[var(--cf-surface)] shadow-sm transition-transform"
                          style={{ transform: `translateX(${flow.active ? 14 : 2}px)` }}
                        />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {(hooks.length > 0 || listeners.length > 0) && (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {hooks.length > 0 && (
              <section className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
                <h3 className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold">
                  <Webhook size={14} />
                  <span className="min-w-0 flex-1 truncate">{t("flows.schedule.webhooks")}</span>
                  <TunnelControl />
                </h3>
                {hooks.map(({ flow, trigger }) => (
                  <div key={`${flow.flowId}:${trigger.nodeId}`} className="flex flex-col gap-0.5 border-t border-[var(--cf-border)] py-2 first-of-type:border-t-0">
                    <div className="flex min-w-0 items-center gap-2">
                      <code className="min-w-0 flex-1 truncate text-[12px]" title={trigger.url ?? ""}>
                        {trigger.detail}
                      </code>
                      <button
                        type="button"
                        className={iconButtonClass({ size: "xs" })}
                        title={t("flows.schedule.copyUrl")}
                        aria-label={t("flows.schedule.copyUrl")}
                        onClick={() => {
                          if (!trigger.url) return;
                          void navigator.clipboard?.writeText(trigger.url).then(() => pushSuccessToast(t("flows.schedule.copied")));
                        }}
                      >
                        <Copy size={12} />
                      </button>
                    </div>
                    {trigger.publicUrl && (
                      <div className="flex min-w-0 items-center gap-2">
                        <Globe size={11} className="shrink-0 text-[var(--cf-text-muted)]" />
                        <code className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-muted)]" title={trigger.publicUrl}>
                          {trigger.publicUrl}
                        </code>
                        <button
                          type="button"
                          className={iconButtonClass({ size: "xs" })}
                          title={t("flows.tunnel.copyPublic")}
                          aria-label={t("flows.tunnel.copyPublic")}
                          onClick={() => void navigator.clipboard?.writeText(trigger.publicUrl ?? "").then(() => pushSuccessToast(t("flows.schedule.copied")))}
                        >
                          <Copy size={12} />
                        </button>
                      </div>
                    )}
                    <span className="text-[11.5px] text-[var(--cf-text-muted)]">
                      {flow.flowName}
                      {trigger.lastFired ? ` · ${formatWhen(trigger.lastFired, language)}` : ""}
                    </span>
                  </div>
                ))}
              </section>
            )}
            {listeners.length > 0 && (
              <section className="rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)] p-3">
                <h3 className="mb-2 flex items-center gap-2 text-[12.5px] font-semibold">
                  <Radio size={14} />
                  {t("flows.schedule.listeners")}
                </h3>
                {listeners.map(({ flow, trigger }) => (
                  <div key={`${flow.flowId}:${trigger.nodeId}`} className="flex flex-col gap-0.5 border-t border-[var(--cf-border)] py-2 first-of-type:border-t-0">
                    <span className="flex min-w-0 items-center gap-2 text-[12.5px]">
                      <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${trigger.problem ? "bg-[var(--cf-warning)]" : "bg-[var(--cf-success)]"}`} />
                      <b className="min-w-0 truncate font-semibold">{flow.flowName}</b>
                      <span className="text-[11.5px] text-[var(--cf-text-muted)]">{t(`flows.node.${trigger.typeId}` as TranslationKey)}</span>
                    </span>
                    <span className="truncate pl-[15px] text-[11.5px] text-[var(--cf-text-muted)]">{trigger.problem ?? triggerDetail(trigger, t)}</span>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}

        <McpSection />

        <label className="flex items-center gap-2 text-[12.5px] text-[var(--cf-text)]">
          <Checkbox
            checked={launchAtLogin === true}
            disabled={launchAtLogin === null}
            onChange={(on) =>
              void setAutostart(on)
                .then(setLaunchAtLogin)
                .catch((error: unknown) => pushErrorToast(t("settings.launchAtLoginFailed", { reason: String(error) })))
            }
          />
          {t("settings.launchAtLogin")}
          <span className="text-[var(--cf-text-faint)]">· {t("flows.schedule.whileOpen")}</span>
        </label>
        {launchAtLogin && (
          <label className="-mt-2 ml-6 flex items-center gap-2 text-[12.5px] text-[var(--cf-text)]" title={t("flows.schedule.backgroundHint")}>
            <Checkbox
              checked={background}
              onChange={(on) => {
                setBackground(on);
                void setSetting("flows_background_at_login", on ? "1" : "0").catch((error: unknown) => pushErrorToast(String(error)));
              }}
            />
            {t("flows.schedule.background")}
          </label>
        )}
      </div>
    </div>
  );
}

/** A trigger's detail, translated where it is a code. */
function triggerDetail(trigger: FlowTriggerView, t: ReturnType<typeof useT>): string {
  if (trigger.typeId === "trigger.app") return t(`flows.opt.${trigger.detail}` as TranslationKey);
  if (trigger.typeId === "trigger.error") return t(trigger.detail === "selected" ? "flows.schedule.errorSome" : "flows.schedule.errorAll");
  if (trigger.typeId === "trigger.subflow") return t("flows.schedule.subflow");
  if (trigger.typeId === "trigger.repo" || trigger.typeId === "trigger.pr" || trigger.typeId === "trigger.pipeline") {
    const [project, event] = trigger.detail.split(" · ");
    return event ? `${project} · ${t(`flows.opt.${event}` as TranslationKey)}` : trigger.detail;
  }
  return trigger.detail;
}
