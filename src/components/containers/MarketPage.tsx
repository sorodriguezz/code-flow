import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpFromLine, Check, Copy, Database, ExternalLink, KeyRound, Loader2, Play, Square, Trash2, X } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { fieldClass } from "../common/recipes";
import { RowAction, StateDot, stateTone, useInterval } from "./containerBits";
import { runtimeLabel } from "./containerActions";
import { Dialog, EmptyLine, Field, FormSection, LoadingLine, PageHead, Panel } from "./ui";
import {
  canOpen,
  duplicatePorts,
  groupByCategory,
  integrationCounts,
  MARKET_CANCELLED,
  marketJobsSignature,
  needsSecret,
  parsePort,
  portOverrides,
  runningCount,
  runningMarketStacks,
  stackTone,
  suggestStackName,
  validStackName,
} from "./marketModel";
import { onMarketChanged, refreshModules, startMarketUp } from "./marketJobs";
import {
  containersMarketCatalog,
  containersMarketPrepare,
  containersMarketRemove,
  containersMarketStacks,
  containersMarketStart,
  containersMarketStop,
  containersMarketSuggestPorts,
} from "../../lib/tauri/containersMarketCommands";
import { keyvaultStatus } from "../../lib/tauri/keyvaultCommands";
import { openExternalUrl } from "../../lib/tauri/commands";
import { useContainersJobsStore } from "../../state/containersJobsStore";
import { useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { RuntimeInfo } from "../../types/containers";
import type { MarketCreated, MarketService, PlannedService, RemoveOptions, StackView } from "../../types/containersMarket";

/**
 * Contenedores › Catálogo de servicios — development services (databases, brokers, Keycloak, Mailpit,
 * MinIO, observability…) provisioned as one Compose stack on this engine and wired into CodeFlow: a
 * database becomes a connection in Base de datos, Keycloak an environment and an OAuth2 preset in the
 * API client, every generated password a Llavero entry, every console a button. Removing a stack can
 * undo each of those (see `src-tauri/src/containers/marketplace.rs`). Bringing a stack up is a job of the
 * jobs panel, its output live (see `marketJobs`).
 */

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function MarketPage({ runtime }: { runtime: RuntimeInfo }) {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf(runtime.id));
  const refreshList = useContainersStore((s) => s.refreshList);
  const [catalog, setCatalog] = useState<MarketService[] | null>(null);
  const [stacks, setStacks] = useState<StackView[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [provisioning, setProvisioning] = useState(false);
  const [removing, setRemoving] = useState<StackView | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const ctr = runtime.id === "ctr";

  useEffect(() => {
    containersMarketCatalog()
      .then(setCatalog)
      .catch((e) => {
        setCatalog([]);
        pushErrorToast(errorText(e));
      });
  }, []);
  const loadStacks = useCallback(() => {
    containersMarketStacks()
      .then(setStacks)
      .catch(() => setStacks((current) => current ?? []));
  }, []);
  // Read again whenever an `up` job starts, ends or is closed — and when the backend has settled one.
  const jobsSignature = useContainersJobsStore((s) => marketJobsSignature(s.jobs));
  const upping = useContainersJobsStore((s) => runningMarketStacks(s.jobs).join(","));
  useEffect(loadStacks, [loadStacks, jobsSignature]);
  useEffect(() => {
    const unlisten = onMarketChanged(loadStacks);
    return () => void unlisten.then((stop) => stop()).catch(() => {});
  }, [loadStacks]);
  useInterval(loadStacks, 5000, runtime.running);
  const uppingIds = useMemo(() => new Set(upping ? upping.split(",") : []), [upping]);

  const here = useMemo(() => (stacks ?? []).filter((s) => s.runtime === runtime.id), [stacks, runtime.id]);
  const groups = useMemo(() => groupByCategory(catalog ?? []), [catalog]);
  const chosen = useMemo(() => (catalog ?? []).filter((s) => picked.has(s.id)), [catalog, picked]);

  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** One lifecycle action on a stack, with its row's spinner. */
  const run = async (stack: StackView, action: () => Promise<StackView | string[]>, done?: string) => {
    setBusy((b) => ({ ...b, [stack.id]: true }));
    try {
      const result = await action();
      if (!Array.isArray(result) && result.lastError) pushErrorToast(t("containers.market.failed", { name: stack.name, error: result.lastError }));
      else if (done) pushSuccessToast(done);
      await refreshModules(stack.workspaceId);
    } catch (e) {
      pushErrorToast(errorText(e));
    } finally {
      setBusy((b) => ({ ...b, [stack.id]: false }));
      loadStacks();
      void refreshList(runtime.id, "containers");
    }
  };

  const remove = async (stack: StackView, options: RemoveOptions) => {
    setRemoving(null);
    setBusy((b) => ({ ...b, [stack.id]: true }));
    try {
      const kept = await containersMarketRemove(stack.id, options);
      if (kept.length) pushErrorToast(t("containers.market.r.kept", { what: kept.join("; ") }));
      else pushSuccessToast(t("containers.market.r.done", { name: stack.name }));
      await refreshModules(stack.workspaceId);
    } catch (e) {
      pushErrorToast(errorText(e));
    } finally {
      setBusy((b) => ({ ...b, [stack.id]: false }));
      loadStacks();
      for (const what of ["containers", "volumes", "networks"]) void refreshList(runtime.id, what);
    }
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead title={t("containers.market.title")} sub={t("containers.market.sub")}>
        {picked.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
            {t("containers.market.clear")}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={!picked.size || !runtime.running || ctr} onClick={() => setProvisioning(true)}>
          <ArrowUpFromLine size={13} />
          {picked.size ? t("containers.market.provision", { count: picked.size }) : t("containers.market.provisionOne")}
        </Button>
      </PageHead>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {ctr ? (
          <EmptyLine>{t("containers.m.compose.unsupported")}</EmptyLine>
        ) : (
          <div className="flex flex-col gap-4">
            {!runtime.running && <EmptyLine>{runtime.problem ?? t("containers.notRunningHint")}</EmptyLine>}
            <Panel title={t("containers.market.stacks")} aside={here.length ? String(here.length) : undefined}>
              {stacks === null ? (
                <LoadingLine />
              ) : here.length === 0 ? (
                <EmptyLine>{t("containers.market.noStacks")}</EmptyLine>
              ) : (
                <div className="divide-y divide-[var(--cf-border)]">
                  {here.map((stack) => (
                    <StackCard
                      key={stack.id}
                      stack={stack}
                      busy={!!busy[stack.id] || uppingIds.has(stack.id)}
                      upping={uppingIds.has(stack.id)}
                      onUp={() => void startMarketUp(stack)}
                      onStart={() => void run(stack, () => containersMarketStart(stack.id))}
                      onStop={() => void run(stack, () => containersMarketStop(stack.id))}
                      onRemove={() => setRemoving(stack)}
                    />
                  ))}
                </div>
              )}
            </Panel>
            {catalog === null ? (
              <LoadingLine />
            ) : (
              groups.map((group) => (
                <section key={group.category} className="flex flex-col gap-2">
                  <h4 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">{t(`containers.market.cat.${group.category}` as TranslationKey)}</h4>
                  <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(250px,1fr))]">
                    {group.services.map((service) => (
                      <ServiceCard key={service.id} service={service} selected={picked.has(service.id)} onToggle={() => toggle(service.id)} />
                    ))}
                  </div>
                </section>
              ))
            )}
          </div>
        )}
      </div>
      {provisioning && (
        <ProvisionDialog
          runtime={runtime}
          context={context}
          services={chosen}
          taken={(stacks ?? []).filter((s) => s.runtime === runtime.id && (s.context ?? "") === (context ?? "")).map((s) => s.name)}
          onDrop={(id) => toggle(id)}
          onClose={() => setProvisioning(false)}
          onDone={(stack) => {
            setProvisioning(false);
            setPicked(new Set());
            // Its passwords could not be kept: nothing to bring up. Otherwise `up` runs in the jobs panel.
            if (stack.lastError) pushErrorToast(t("containers.market.failed", { name: stack.name, error: stack.lastError }));
            else void startMarketUp(stack);
            loadStacks();
          }}
        />
      )}
      {removing && <RemoveDialog stack={removing} onClose={() => setRemoving(null)} onConfirm={(options) => void remove(removing, options)} />}
    </div>
  );
}

// ----------------------------------------------------------------------------------- catalogue

function integrationLabel(service: MarketService, t: ReturnType<typeof useT>): string {
  return t(`containers.market.int.${service.integration}` as TranslationKey);
}

function ServiceCard({ service, selected, onToggle }: { service: MarketService; selected: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      onClick={onToggle}
      aria-pressed={selected}
      className={`flex min-w-0 flex-col gap-1.5 rounded-[10px] border p-3 text-left transition-colors ${
        selected ? "border-[var(--cf-accent)] bg-[color-mix(in_oklab,var(--cf-accent)_8%,var(--cf-surface))]" : "border-[var(--cf-border)] bg-[var(--cf-surface)] hover:border-[var(--cf-border-strong)]"
      }`}
    >
      <span className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--cf-text)]">{service.name}</span>
        {needsSecret(service) && (
          <span title={t("containers.market.secret")} className="text-[var(--cf-text-faint)]">
            <KeyRound size={12} />
          </span>
        )}
        <span
          aria-hidden
          className={`flex h-4 w-4 items-center justify-center rounded-[4px] border ${selected ? "border-[var(--cf-accent)] bg-[var(--cf-accent-fill)] text-[var(--cf-on-accent)]" : "border-[var(--cf-border-strong)]"}`}
        >
          {selected && <Check size={11} strokeWidth={3} />}
        </span>
      </span>
      <span className="text-[12px] leading-snug text-[var(--cf-text-muted)]">{t(`containers.market.desc.${service.id}` as TranslationKey)}</span>
      <span className="truncate font-mono text-[10.5px] text-[var(--cf-text-faint)]" title={service.image}>
        {service.image}
      </span>
      <span className="flex flex-wrap items-center gap-1">
        {service.ports.map((port) => (
          <span key={port.key} title={port.purpose} className="inline-flex items-center rounded-[5px] border border-[var(--cf-border)] px-1.5 font-mono text-[10.5px] text-[var(--cf-text-muted)]">
            {port.purpose} {port.defaultHost}
          </span>
        ))}
      </span>
      <span className="flex items-center gap-1 text-[11px] text-[var(--cf-text-faint)]">
        {service.integration === "database" && <Database size={11} />}
        {integrationLabel(service, t)}
      </span>
    </button>
  );
}

// --------------------------------------------------------------------------------- provisioning

function ProvisionDialog({
  runtime,
  context,
  services,
  taken,
  onDrop,
  onClose,
  onDone,
}: {
  runtime: RuntimeInfo;
  context: string | null;
  services: MarketService[];
  taken: string[];
  onDrop: (id: string) => void;
  onClose: () => void;
  onDone: (stack: StackView) => void;
}) {
  const t = useT();
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [name, setName] = useState(() => suggestStackName(taken));
  const [suggested, setSuggested] = useState<PlannedService[] | null>(null);
  const [typed, setTyped] = useState<Record<string, Record<string, string>>>({});
  const [locked, setLocked] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useMemo(() => services.map((s) => s.id), [services]);
  const secrets = services.some(needsSecret);

  useEffect(() => {
    if (!ids.length) return;
    let live = true;
    setSuggested(null);
    containersMarketSuggestPorts(runtime.id, context, ids)
      .then((planned) => live && setSuggested(planned))
      .catch((e) => live && setError(errorText(e)));
    return () => {
      live = false;
    };
  }, [runtime.id, context, ids]);
  useEffect(() => {
    if (!secrets) return setLocked(false);
    void keyvaultStatus()
      .then((status) => setLocked(!status.unlocked))
      .catch(() => setLocked(false));
  }, [secrets]);

  const trimmed = name.trim();
  const nameProblem = !validStackName(trimmed) ? t("containers.market.d.nameInvalid") : taken.includes(trimmed) ? t("containers.market.d.nameTaken") : null;
  const twice = suggested ? duplicatePorts(suggested, typed) : [];
  const badPort = suggested?.some((s) => s.ports.some((p) => typed[s.id]?.[p.key] !== undefined && parsePort(typed[s.id][p.key]) === null)) ?? false;
  const portProblem = badPort ? t("containers.market.d.portInvalid") : twice.length ? t("containers.market.d.portTwice", { port: twice.join(", ") }) : null;
  const ready = !!suggested && !nameProblem && !portProblem && !locked && !working && services.length > 0;

  const submit = async () => {
    if (!suggested) return;
    if (secrets) {
      const status = await keyvaultStatus().catch(() => null);
      if (status && !status.unlocked) return setLocked(true);
    }
    setWorking(true);
    setError(null);
    const overrides = portOverrides(suggested, typed);
    try {
      const stack = await containersMarketPrepare({
        runtime: runtime.id,
        context,
        name: trimmed,
        workspaceId,
        services: services.map((s) => ({ id: s.id, ports: overrides[s.id] ?? {} })),
      });
      onDone(stack);
    } catch (e) {
      setError(errorText(e));
      setWorking(false);
    }
  };

  return (
    <Dialog
      title={t("containers.market.d.title")}
      onClose={working ? () => {} : onClose}
      width={620}
      footer={
        <>
          {working && (
            <span className="mr-auto flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
              <Loader2 size={12} className="animate-spin" />
              {t("containers.market.d.preparing")}
            </span>
          )}
          <Button size="md" variant="secondary" disabled={working} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" disabled={!ready} onClick={() => void submit()}>
            <ArrowUpFromLine size={13} />
            {t("containers.market.d.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("containers.market.d.name")} hint={nameProblem ?? t("containers.market.d.nameHint")}>
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} disabled={working} spellCheck={false} className={fieldClass({ className: "font-mono" })} />
          </Field>
          <Field label={t("containers.market.d.engine")}>
            <span className="flex h-[30px] items-center text-[13px] text-[var(--cf-text)]">
              {runtimeLabel(runtime.id, t)}
              {context ? <span className="ml-1.5 text-[var(--cf-text-muted)]">· {context}</span> : null}
            </span>
          </Field>
        </div>
        <FormSection title={t("containers.market.d.services")}>
          <p className="text-[11.5px] leading-snug text-[var(--cf-text-faint)]">{t("containers.market.d.portsHint")}</p>
          {!suggested && !error ? (
            <LoadingLine>{t("containers.market.d.loadingPorts")}</LoadingLine>
          ) : (
            <div className="flex flex-col divide-y divide-[var(--cf-border)] rounded-[8px] border border-[var(--cf-border)]">
              {services.map((service) => {
                const plan = suggested?.find((s) => s.id === service.id);
                return (
                  <div key={service.id} className="flex flex-wrap items-center gap-2 px-2.5 py-2">
                    <span className="w-[150px] min-w-0 truncate text-[12.5px] font-medium text-[var(--cf-text)]">{service.name}</span>
                    <span className="flex min-w-0 flex-1 flex-wrap gap-2">
                      {(plan?.ports ?? []).map((port) => (
                        <label key={port.key} className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                          {port.purpose}
                          <input
                            value={typed[service.id]?.[port.key] ?? String(port.host)}
                            onChange={(e) => setTyped((current) => ({ ...current, [service.id]: { ...current[service.id], [port.key]: e.target.value } }))}
                            disabled={working}
                            inputMode="numeric"
                            aria-label={`${service.name} ${port.purpose}`}
                            className={fieldClass({ size: "sm", className: "w-[72px] font-mono" })}
                          />
                          <span className="font-mono text-[10.5px] text-[var(--cf-text-faint)]">→{port.container}</span>
                        </label>
                      ))}
                    </span>
                    {needsSecret(service) && (
                      <span title={t("containers.market.secret")} className="text-[var(--cf-text-faint)]">
                        <KeyRound size={12} />
                      </span>
                    )}
                    <RowAction label={t("containers.market.d.drop")} disabled={working || services.length === 1} onClick={() => onDrop(service.id)}>
                      <X size={12} />
                    </RowAction>
                  </div>
                );
              })}
            </div>
          )}
          {portProblem && <p className="text-[11.5px] text-[var(--cf-danger)]">{portProblem}</p>}
        </FormSection>
        {locked && <p className="rounded-[8px] border border-[var(--cf-warning)] px-2.5 py-2 text-[12px] text-[var(--cf-text)]">{t("containers.market.d.locked")}</p>}
        <p className="text-[11.5px] leading-snug text-[var(--cf-text-muted)]">{workspaceId ? t("containers.market.d.workspace") : t("containers.market.d.noWorkspace")}</p>
        {error && <p className="whitespace-pre-wrap break-words text-[12px] text-[var(--cf-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}

// -------------------------------------------------------------------------------------- stacks

const CHIP_KEYS: Record<MarketCreated["kind"], TranslationKey> = {
  dbConnection: "containers.market.chip.dbConnection",
  apiEnvironment: "containers.market.chip.apiEnvironment",
  apiCollection: "containers.market.chip.apiCollection",
  vaultItem: "containers.market.chip.vaultItem",
};

function StackCard({
  stack,
  busy,
  upping,
  onUp,
  onStart,
  onStop,
  onRemove,
}: {
  stack: StackView;
  busy: boolean;
  /** Its `up` job is running in the jobs panel. */
  upping: boolean;
  onUp: () => void;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const up = runningCount(stack);
  const total = stack.services.length;
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <StateDot tone={stackTone(stack)} />
        <span className="font-mono text-[12.5px] font-semibold text-[var(--cf-text)]">{stack.name}</span>
        {stack.context && <span className="text-[11px] text-[var(--cf-text-faint)]">{stack.context}</span>}
        <span className="text-[11.5px] text-[var(--cf-text-muted)]">
          {upping ? t("containers.market.s.upping") : stack.reachable ? t("containers.market.s.running", { up, total }) : t("containers.market.s.unreachable")}
        </span>
        <div className="flex-1" />
        {busy && <Loader2 size={12} className="animate-spin text-[var(--cf-text-muted)]" />}
        <RowAction label={t("containers.market.s.upHint")} disabled={busy} onClick={onUp}>
          <ArrowUpFromLine size={12} />
        </RowAction>
        {up > 0 ? (
          <RowAction label={t("containers.market.s.stop")} disabled={busy} onClick={onStop}>
            <Square size={12} />
          </RowAction>
        ) : (
          <RowAction label={t("containers.market.s.start")} disabled={busy || !stack.services.some((s) => s.state !== "missing")} onClick={onStart}>
            <Play size={12} className="text-[var(--cf-success)]" />
          </RowAction>
        )}
        <RowAction label={t("containers.market.s.remove")} danger disabled={busy} onClick={onRemove}>
          <Trash2 size={12} />
        </RowAction>
      </div>
      <div className="flex flex-col gap-1">
        {stack.services.map((service) => (
          <div key={service.id} className="flex min-w-0 items-center gap-2 text-[12px]">
            <StateDot tone={service.state === "missing" ? "idle" : stateTone(service.state, service.health)} title={service.health ? `${service.state} · ${service.health}` : service.state} />
            <span className="w-[160px] min-w-0 truncate text-[var(--cf-text)]">{service.name}</span>
            <span className="w-[90px] shrink-0 truncate text-[11px] text-[var(--cf-text-muted)]">
              {service.state === "missing" ? t("containers.market.s.missing") : service.health ? `${service.state} · ${service.health}` : service.state}
            </span>
            <span className="flex min-w-0 flex-1 flex-wrap gap-1">
              {service.ports.map((port) => (
                <span key={port.key} title={port.purpose} className="inline-flex items-center rounded-[5px] border border-[var(--cf-border)] px-1.5 font-mono text-[10.5px] text-[var(--cf-text-muted)]">
                  {port.host}→{port.container}
                </span>
              ))}
            </span>
            {service.address && (
              <RowAction
                label={`${t("containers.market.s.copyAddress")} — ${service.address}`}
                onClick={() => {
                  void navigator.clipboard.writeText(service.address ?? "").catch(() => {});
                  pushSuccessToast(t("containers.market.s.copied"));
                }}
              >
                <Copy size={11} />
              </RowAction>
            )}
            {service.console && (
              <Button size="sm" variant="secondary" disabled={!canOpen(service)} onClick={() => void openExternalUrl(service.console ?? "")} title={service.console}>
                <ExternalLink size={11} />
                {t("containers.market.s.open")}
              </Button>
            )}
          </div>
        ))}
      </div>
      {stack.integrations.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {stack.integrations.map((created) => (
            <span key={`${created.kind}:${created.id}`} title={created.label} className="inline-flex items-center gap-1 rounded-full bg-[var(--cf-hover)] px-2 py-[1px] text-[10.5px] text-[var(--cf-text-muted)]">
              {t(CHIP_KEYS[created.kind])}
              <span className="text-[var(--cf-text-faint)]">· {created.service}</span>
            </span>
          ))}
        </div>
      )}
      {stack.lastError && (
        <p className="whitespace-pre-wrap break-words rounded-[6px] bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-2 py-1 font-mono text-[11px] text-[var(--cf-danger)]" title={t("containers.market.s.lastError")}>
          {stack.lastError === MARKET_CANCELLED ? t("containers.market.s.cancelled") : stack.lastError.slice(0, 800)}
        </p>
      )}
      <span className="truncate font-mono text-[10.5px] text-[var(--cf-text-faint)]" title={stack.composeFile}>
        {stack.composeFile}
      </span>
    </div>
  );
}

function RemoveDialog({ stack, onClose, onConfirm }: { stack: StackView; onClose: () => void; onConfirm: (options: RemoveOptions) => void }) {
  const t = useT();
  const counts = integrationCounts(stack.integrations);
  const [options, setOptions] = useState<RemoveOptions>({ volumes: false, connections: true, api: true, vault: false });
  const set = (key: keyof RemoveOptions) => (value: boolean) => setOptions((o) => ({ ...o, [key]: value }));
  const row = (key: keyof RemoveOptions, label: string, disabled = false) => (
    <label className={`flex items-center gap-2 text-[12.5px] ${disabled ? "text-[var(--cf-text-faint)]" : "text-[var(--cf-text)]"}`}>
      <Checkbox checked={options[key] && !disabled} disabled={disabled} onChange={set(key)} />
      {label}
    </label>
  );
  return (
    <Dialog
      title={t("containers.market.r.title", { name: stack.name })}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button size="md" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="danger" onClick={() => onConfirm({ ...options, connections: options.connections && counts.connections > 0, api: options.api && counts.api > 0, vault: options.vault && counts.vault > 0 })}>
            <Trash2 size={13} />
            {t("containers.market.r.confirm")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <p className="text-[12.5px] text-[var(--cf-text-muted)]">{t("containers.market.r.body")}</p>
        {row("volumes", t("containers.market.r.volumes"))}
        {row("connections", t("containers.market.r.connections", { count: counts.connections }), counts.connections === 0)}
        {row("api", t("containers.market.r.api", { count: counts.api }), counts.api === 0)}
        {row("vault", t("containers.market.r.vault", { count: counts.vault }), counts.vault === 0)}
      </div>
    </Dialog>
  );
}
