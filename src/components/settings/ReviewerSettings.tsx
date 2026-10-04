/**
 * Settings › Revisor: the switch that shows the tab, the on-demand download of SonarQube and its
 * local server, which rules and Quality Gate it judges by, and the company servers it can copy them
 * from.
 *
 * Nothing here is installed with the app. The download is ≈ 1.2 GB and starts only from the button
 * in the SonarQube pane; the server runs only while it is used.
 */

import { useEffect, useMemo, useState } from "react";
import { Check, Download, ExternalLink, Play, Plus, Square, Trash2, X } from "lucide-react";
import { usePreferencesStore } from "../../state/preferencesStore";
import { useReviewerStore } from "../../state/reviewerStore";
import { useUiStore } from "../../state/uiStore";
import { useT, type Translate } from "../../state/languageStore";
import { chooseAction, confirmAction } from "../../state/confirmStore";
import { pushErrorToast } from "../../state/toastStore";
import { openExternalUrl } from "../../lib/tauri/commands";
import {
  reviewerDiskUsed,
  reviewerServerCatalog,
  reviewerServerLog,
  type ReviewerComponent,
  type ReviewerConfig,
  type ReviewerInstallProgress,
  type ReviewerRemoteCatalog,
  type ReviewerRemoteServer,
  type ReviewerServerStatus,
  type ReviewerServerView,
} from "../../lib/tauri/reviewerCommands";
import { Checkbox } from "../common/Checkbox";
import { buttonClass } from "../common/Button";
import { fieldClass } from "../common/recipes";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { Actions, Note, Status } from "../api/settingsChrome";
import { formatBytes } from "./localModelRow";
import { PaneBlock, RailSection } from "./settingsNav";

const COMPONENT_LABEL: Record<ReviewerComponent["id"], "reviewer.componentJdk" | "reviewer.componentSonarqube" | "reviewer.componentScanner"> = {
  jdk: "reviewer.componentJdk",
  sonarqube: "reviewer.componentSonarqube",
  scanner: "reviewer.componentScanner",
};

const IDLE_CHOICES = [5, 15, 30, 60, 0];

export function ReviewerSettings() {
  const t = useT();
  const refresh = useReviewerStore((s) => s.refresh);
  useEffect(() => {
    void refresh().catch((e: unknown) => pushErrorToast(String(e)));
  }, [refresh]);

  return (
    <RailSection section="reviewer" title={t("tabbar.reviewer")} hint={t("reviewer.settingsHint")} fallback="general">
      {(tab) => (
        <>
          {tab === "general" && <GeneralPane />}
          {tab === "sonarqube" && <SonarPane />}
          {tab === "rules" && <RulesPane />}
          {tab === "servers" && <ServersPane />}
        </>
      )}
    </RailSection>
  );
}

function GeneralPane() {
  const t = useT();
  const enabled = usePreferencesStore((s) => s.reviewerEnabled);
  const setEnabled = usePreferencesStore((s) => s.setReviewerEnabled);
  const status = useReviewerStore((s) => s.status);
  const saveConfig = useReviewerStore((s) => s.saveConfig);
  const stopServer = useReviewerStore((s) => s.stopServer);
  const config = status?.config;

  const toggle = async (checked: boolean) => {
    await setEnabled(checked);
    // Switched off, the tab is gone — and with it any reason to keep two gigabytes of JVMs running.
    // A review in flight refuses the stop, and is left to finish.
    if (!checked && status?.server.state === "running") await stopServer().catch(() => {});
  };

  return (
    <>
      <label className="mb-1 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
        <Checkbox checked={enabled} onChange={(checked) => void toggle(checked)} />
        {t("reviewer.showTab")}
      </label>
      <p className="mb-3 pl-[26px] text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("reviewer.showTabHint")}</p>
      {status && !status.install.ready && (
        <div className="mb-3 flex items-center gap-2 pl-[26px]">
          <Status tone="muted">{t("reviewer.notInstalled")}</Status>
          <button
            type="button"
            onClick={() => useUiStore.getState().openSettingsAt("reviewer", "sonarqube")}
            className="text-[11px] text-[var(--cf-accent)] hover:underline"
          >
            {t("reviewer.goDownload")}
          </button>
        </div>
      )}
      {config && (
        <PaneBlock title={t("reviewer.runBlock")}>
          <div className="mb-2.5 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
            <span>{t("reviewer.idleLabel")}</span>
            <div className="w-44">
              <Select
                size="sm"
                value={String(config.idleMinutes)}
                onChange={(value) => void saveConfig({ idleMinutes: Number(value) })}
                options={IDLE_CHOICES.map((n) => ({
                  value: String(n),
                  label: n === 0 ? t("reviewer.idleNever") : t("reviewer.idleMinutes", { n }),
                }))}
                ariaLabel={t("reviewer.idleLabel")}
              />
            </div>
          </div>
          <label className="mb-1 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
            <Checkbox
              checked={config.continueOnTestFailure}
              onChange={(checked) => void saveConfig({ continueOnTestFailure: checked })}
            />
            {t("reviewer.continueOnTests")}
          </label>
          <p className="pl-[26px] text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("reviewer.continueOnTestsHint")}</p>
        </PaneBlock>
      )}
    </>
  );
}

function progressLabel(t: Translate, progress: ReviewerInstallProgress | undefined): string | null {
  if (!progress) return null;
  if (progress.phase === "extracting") return t("reviewer.extracting");
  if (progress.phase === "downloading") {
    return progress.total > 0
      ? `${formatBytes(progress.done)} / ${formatBytes(progress.total)}`
      : formatBytes(progress.done);
  }
  return null;
}

function serverLine(t: Translate, server: ReviewerServerStatus): { tone: "muted" | "success" | "warning" | "accent"; text: string; pulse: boolean } {
  switch (server.state) {
    case "running":
      return { tone: "success", text: t("reviewer.serverRunning", { url: server.url }), pulse: false };
    case "starting": {
      const detail =
        server.detail === "signing-in"
          ? t("reviewer.serverSigningIn")
          : server.detail === "rules"
            ? t("reviewer.serverRules")
            : server.detail === "migrating"
              ? t("reviewer.serverMigrating")
              : t("reviewer.serverStarting");
      return { tone: "accent", text: detail, pulse: true };
    }
    case "stopping":
      return { tone: "muted", text: t("reviewer.serverStopping"), pulse: true };
    case "failed":
      return { tone: "warning", text: t("reviewer.serverFailed"), pulse: false };
    default:
      return { tone: "muted", text: t("reviewer.serverStopped"), pulse: false };
  }
}

function SonarPane() {
  const t = useT();
  const status = useReviewerStore((s) => s.status);
  const server = useReviewerStore((s) => s.server);
  const installing = useReviewerStore((s) => s.installing);
  const progress = useReviewerStore((s) => s.installProgress);
  const installError = useReviewerStore((s) => s.installError);
  const install = useReviewerStore((s) => s.install);
  const cancelInstall = useReviewerStore((s) => s.cancelInstall);
  const uninstall = useReviewerStore((s) => s.uninstall);
  const startServer = useReviewerStore((s) => s.startServer);
  const stopServer = useReviewerStore((s) => s.stopServer);
  const saveConfig = useReviewerStore((s) => s.saveConfig);
  const [disk, setDisk] = useState<number | null>(null);
  const [log, setLog] = useState<string[] | null>(null);
  const [port, setPort] = useState("");

  const ready = status?.install.ready ?? false;
  useEffect(() => {
    if (ready) void reviewerDiskUsed().then(setDisk).catch(() => setDisk(null));
  }, [ready, server.state]);
  useEffect(() => {
    if (status) setPort(String(status.config.port));
  }, [status?.config.port]);

  if (!status) return null;
  const line = serverLine(t, server);
  const busy = server.state === "starting" || server.state === "stopping";

  const remove = async () => {
    const choice = await chooseAction({
      message: t("reviewer.removeConfirm"),
      danger: true,
      choices: [
        { id: "keep", label: t("reviewer.removeKeepData"), variant: "secondary" },
        { id: "all", label: t("reviewer.removeAll"), variant: "danger" },
      ],
    });
    if (!choice) return;
    await uninstall(choice === "all").catch((e: unknown) => pushErrorToast(String(e)));
  };

  return (
    <>
      <ul className="mb-2.5 flex flex-col gap-1.5">
        {status.install.components.map((component) => {
          const current = progress[component.id];
          const label = progressLabel(t, installing ? current : undefined);
          const fraction = current && current.total > 0 ? Math.min(1, current.done / current.total) : 0;
          return (
            <li key={component.id} className="flex min-w-0 items-center gap-2.5 text-[13px]">
              <span className="w-48 shrink-0 truncate text-[var(--cf-text)]">
                {t(COMPONENT_LABEL[component.id], { n: status.javaRelease })}
              </span>
              <span className="w-32 shrink-0 truncate text-[11px] tabular-nums text-[var(--cf-text-muted)]">{component.version}</span>
              {component.installed || current?.phase === "done" ? (
                <span className="flex items-center gap-1 text-[11px] text-[var(--cf-success)]">
                  <Check size={11} />
                  {t("reviewer.installed")}
                </span>
              ) : installing && current ? (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="h-1.5 min-w-16 flex-1 overflow-hidden rounded-full bg-[var(--cf-hover)]">
                    <span
                      className="block h-full rounded-full bg-[var(--cf-accent-fill)] transition-[width] duration-200"
                      style={{ width: `${current.phase === "extracting" ? 100 : Math.round(fraction * 100)}%` }}
                    />
                  </span>
                  <span className="shrink-0 text-[11px] tabular-nums text-[var(--cf-text-muted)]">{label}</span>
                </span>
              ) : (
                <span className="text-[11px] tabular-nums text-[var(--cf-text-muted)]">{formatBytes(component.size)}</span>
              )}
            </li>
          );
        })}
      </ul>
      <Actions>
        {!ready && !installing && (
          <button type="button" onClick={() => void install()} className={buttonClass({ variant: "primary", size: "sm" })}>
            <Download size={12} />
            {t("reviewer.download", { size: formatBytes(status.install.pendingBytes) })}
          </button>
        )}
        {installing && (
          <button type="button" onClick={() => void cancelInstall()} className={buttonClass({ variant: "secondary", size: "sm" })}>
            <X size={12} />
            {t("common.cancel")}
          </button>
        )}
        {ready && !installing && (
          <button type="button" onClick={() => void remove()} className={buttonClass({ variant: "danger-ghost", size: "sm" })}>
            <Trash2 size={12} />
            {t("reviewer.remove")}
          </button>
        )}
      </Actions>
      {installError && <Note tone="warning">{installError}</Note>}
      <p className="mt-2 text-[11px] leading-snug text-[var(--cf-text-muted)]">{t("reviewer.license")}</p>

      {ready && (
        <PaneBlock title={t("reviewer.serverTitle")}>
          <div className="mb-2 flex min-w-0 items-center gap-3">
            <Status tone={line.tone} pulse={line.pulse}>
              {line.text}
            </Status>
            <span className="flex-1" />
            {server.state === "running" && (
              <button
                type="button"
                onClick={() => void openExternalUrl(server.url).catch((e: unknown) => pushErrorToast(String(e)))}
                className={buttonClass({ variant: "ghost", size: "sm" })}
              >
                <ExternalLink size={12} />
                {t("reviewer.openBrowser")}
              </button>
            )}
            {server.state === "running" ? (
              <button type="button" onClick={() => void stopServer().catch((e: unknown) => pushErrorToast(String(e)))} className={buttonClass({ variant: "secondary", size: "sm" })}>
                <Square size={11} />
                {t("reviewer.stop")}
              </button>
            ) : (
              <button
                type="button"
                disabled={busy}
                onClick={() => void startServer().catch((e: unknown) => pushErrorToast(String(e)))}
                className={buttonClass({ variant: "secondary", size: "sm" })}
              >
                <Play size={11} />
                {t("reviewer.start")}
              </button>
            )}
          </div>
          {server.state === "failed" && (
            <>
              <p className="mb-1.5 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--cf-warning)]">
                {server.message}
              </p>
              <button
                type="button"
                onClick={() => void reviewerServerLog(200).then(setLog)}
                className="mb-2 text-[11px] text-[var(--cf-accent)] hover:underline"
              >
                {t("reviewer.showLog")}
              </button>
            </>
          )}
          {log && (
            <pre className="mb-2 max-h-48 overflow-auto rounded-md bg-[var(--cf-sunken)] p-2 font-mono text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
              {log.join("\n")}
            </pre>
          )}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[var(--cf-text)]">
            <label className="flex items-center gap-2">
              {t("reviewer.port")}
              <input
                value={port}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
                onBlur={() => {
                  const value = Math.min(65535, Math.max(1024, Number(port) || 9000));
                  setPort(String(value));
                  if (value !== status.config.port) void saveConfig({ port: value });
                }}
                className={fieldClass({ size: "sm", className: "w-20 tabular-nums" })}
              />
            </label>
            <span className="flex items-center gap-2">
              {t("reviewer.memory")}
              <Segmented<ReviewerConfig["memory"]>
                size="sm"
                value={status.config.memory}
                onChange={(memory) => void saveConfig({ memory })}
                layoutId="cf-reviewer-memory"
                ariaLabel={t("reviewer.memory")}
                options={[
                  { value: "standard", label: t("reviewer.memoryStandard") },
                  { value: "large", label: t("reviewer.memoryLarge") },
                ]}
              />
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-[var(--cf-text-muted)]">{t("reviewer.appliesNextStart")}</p>
          {disk !== null && (
            <p className="mt-2 break-all text-[11px] text-[var(--cf-text-muted)]">
              {t("reviewer.diskUsed", { size: formatBytes(disk), path: status.install.root })}
            </p>
          )}
        </PaneBlock>
      )}
    </>
  );
}

type RulesKind = "sonarWay" | "strict" | "max" | "server";
type GateKind = "sonarWay" | "strict" | "server";

function RulesPane() {
  const t = useT();
  const status = useReviewerStore((s) => s.status);
  const server = useReviewerStore((s) => s.server);
  const saveConfig = useReviewerStore((s) => s.saveConfig);
  const applyRules = useReviewerStore((s) => s.applyRules);
  const [applying, setApplying] = useState(false);
  const [catalog, setCatalog] = useState<ReviewerRemoteCatalog | null>(null);
  const [coverage, setCoverage] = useState("");
  const [duplication, setDuplication] = useState("");

  const config = status?.config;
  const servers = status?.servers ?? [];
  const serverId =
    config?.rules.kind === "server" ? config.rules.serverId : config?.gate.kind === "server" ? config.gate.serverId : servers[0]?.id;

  useEffect(() => {
    if (!config) return;
    setCoverage(String(config.thresholds.coverage));
    setDuplication(String(config.thresholds.duplication));
  }, [config?.thresholds.coverage, config?.thresholds.duplication]);

  const needsCatalog = config?.rules.kind === "server" || config?.gate.kind === "server";
  useEffect(() => {
    if (!needsCatalog || !serverId) {
      setCatalog(null);
      return;
    }
    let live = true;
    void reviewerServerCatalog(serverId)
      .then((found) => live && setCatalog(found))
      .catch((e: unknown) => {
        if (live) pushErrorToast(String(e));
      });
    return () => {
      live = false;
    };
  }, [needsCatalog, serverId]);

  if (!status || !config) return null;

  const setRules = (kind: RulesKind) => {
    if (kind === "server") {
      if (!serverId) return;
      void saveConfig({ rules: { kind: "server", serverId, profiles: [] } });
    } else {
      void saveConfig({ rules: { kind } });
    }
  };
  const setGate = (kind: GateKind) => {
    if (kind === "server") {
      if (!serverId) return;
      void saveConfig({ gate: { kind: "server", serverId, gate: "" } });
    } else {
      void saveConfig({ gate: { kind } });
    }
  };
  const apply = async () => {
    setApplying(true);
    try {
      await applyRules();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setApplying(false);
    }
  };
  const report = status.rules;
  const rulesHint: Record<RulesKind, "reviewer.rulesSonarWayHint" | "reviewer.rulesStrictHint" | "reviewer.rulesMaxHint" | "reviewer.rulesServerHint"> = {
    sonarWay: "reviewer.rulesSonarWayHint",
    strict: "reviewer.rulesStrictHint",
    max: "reviewer.rulesMaxHint",
    server: "reviewer.rulesServerHint",
  };

  return (
    <>
      <PaneBlock title={t("reviewer.rulesLabel")} hint={t(rulesHint[config.rules.kind])}>
        <Segmented<RulesKind>
          value={config.rules.kind}
          onChange={setRules}
          layoutId="cf-reviewer-rules"
          ariaLabel={t("reviewer.rulesLabel")}
          options={[
            { value: "sonarWay", label: "Sonar way" },
            { value: "strict", label: t("reviewer.rulesStrict") },
            { value: "max", label: t("reviewer.rulesMax") },
            { value: "server", label: t("reviewer.rulesServer"), disabled: servers.length === 0, title: servers.length === 0 ? t("reviewer.noServers") : undefined },
          ]}
        />
        {config.rules.kind === "server" && (
          <ServerPicker
            servers={servers}
            value={config.rules.serverId}
            onChange={(id) => void saveConfig({ rules: { kind: "server", serverId: id, profiles: [] } })}
          />
        )}
        {config.rules.kind === "server" && catalog && (
          <ProfilePicker
            catalog={catalog}
            selected={config.rules.profiles}
            onChange={(profiles) =>
              config.rules.kind === "server" && void saveConfig({ rules: { ...config.rules, profiles } })
            }
          />
        )}
      </PaneBlock>

      <PaneBlock title={t("reviewer.gateLabel")}>
        <Segmented<GateKind>
          value={config.gate.kind}
          onChange={setGate}
          layoutId="cf-reviewer-gate"
          ariaLabel={t("reviewer.gateLabel")}
          options={[
            { value: "strict", label: t("reviewer.gateStrict") },
            { value: "sonarWay", label: t("reviewer.gateSonarWay") },
            { value: "server", label: t("reviewer.rulesServer"), disabled: servers.length === 0, title: servers.length === 0 ? t("reviewer.noServers") : undefined },
          ]}
        />
        {config.gate.kind === "strict" && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-[var(--cf-text)]">
            <label className="flex items-center gap-2">
              {t("reviewer.coverageMin")}
              <input
                value={coverage}
                inputMode="decimal"
                onChange={(e) => setCoverage(e.target.value)}
                onBlur={() => {
                  const value = Math.min(100, Math.max(0, Number(coverage.replace(",", ".")) || 0));
                  setCoverage(String(value));
                  void saveConfig({ thresholds: { ...config.thresholds, coverage: value } });
                }}
                className={fieldClass({ size: "sm", className: "w-16 tabular-nums" })}
              />
              %
            </label>
            <label className="flex items-center gap-2">
              {t("reviewer.duplicationMax")}
              <input
                value={duplication}
                inputMode="decimal"
                onChange={(e) => setDuplication(e.target.value)}
                onBlur={() => {
                  const value = Math.min(100, Math.max(0, Number(duplication.replace(",", ".")) || 0));
                  setDuplication(String(value));
                  void saveConfig({ thresholds: { ...config.thresholds, duplication: value } });
                }}
                className={fieldClass({ size: "sm", className: "w-16 tabular-nums" })}
              />
              %
            </label>
            <span className="text-[11px] text-[var(--cf-text-muted)]">{t("reviewer.ratingsA")}</span>
          </div>
        )}
        {config.gate.kind === "server" && (
          <>
            <ServerPicker
              servers={servers}
              value={config.gate.serverId}
              onChange={(id) => void saveConfig({ gate: { kind: "server", serverId: id, gate: "" } })}
            />
            {catalog && (
              <div className="mt-2 w-72">
                <Select
                  size="sm"
                  value={config.gate.gate}
                  onChange={(gate) => config.gate.kind === "server" && void saveConfig({ gate: { ...config.gate, gate } })}
                  options={[
                    { value: "", label: t("reviewer.defaultOfServer") },
                    ...catalog.gates.map((g) => ({ value: g.name, label: g.name })),
                  ]}
                  ariaLabel={t("reviewer.gateLabel")}
                />
              </div>
            )}
          </>
        )}
      </PaneBlock>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={server.state !== "running" || applying}
          onClick={() => void apply()}
          className={buttonClass({ variant: "primary", size: "sm" })}
          title={server.state !== "running" ? t("reviewer.applyWhenRunning") : undefined}
        >
          {t("reviewer.apply")}
        </button>
        {server.state !== "running" && <span className="text-[11px] text-[var(--cf-text-muted)]">{t("reviewer.applyWhenRunning")}</span>}
        {report && (
          <span className="text-[11px] text-[var(--cf-text-muted)]">
            {t("reviewer.applied", { languages: report.languages, gate: report.gate })}
            {report.missing > 0 && ` · ${t("reviewer.appliedMissing", { n: report.missing })}`}
          </span>
        )}
      </div>
      {report?.warnings.map((warning) => (
        <Note key={warning}>{warning}</Note>
      ))}
    </>
  );
}

function ServerPicker({ servers, value, onChange }: { servers: ReviewerServerView[]; value: string; onChange: (id: string) => void }) {
  const t = useT();
  if (servers.length <= 1) return null;
  return (
    <div className="mt-2 w-72">
      <Select
        size="sm"
        value={value}
        onChange={onChange}
        options={servers.map((s) => ({ value: s.id, label: s.name }))}
        ariaLabel={t("reviewer.pickServer")}
      />
    </div>
  );
}

/** The server's profiles, one row per language: its default is taken unless another is picked. */
function ProfilePicker({
  catalog,
  selected,
  onChange,
}: {
  catalog: ReviewerRemoteCatalog;
  selected: string[];
  onChange: (profiles: string[]) => void;
}) {
  const t = useT();
  const languages = useMemo(() => {
    const byLanguage = new Map<string, ReviewerRemoteCatalog["profiles"]>();
    for (const profile of catalog.profiles) {
      byLanguage.set(profile.language, [...(byLanguage.get(profile.language) ?? []), profile]);
    }
    return [...byLanguage.entries()].sort((a, b) => (a[1][0]?.languageName ?? a[0]).localeCompare(b[1][0]?.languageName ?? b[0]));
  }, [catalog]);

  // An empty selection means "the server's defaults" — what is shown as picked then.
  const chosen = (profiles: ReviewerRemoteCatalog["profiles"]) =>
    profiles.find((p) => selected.includes(p.key))?.key ?? (selected.length === 0 ? (profiles.find((p) => p.isDefault)?.key ?? "") : "");

  return (
    <div className="mt-3 grid max-h-64 grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 overflow-y-auto pr-1 text-[12px]">
      {languages.map(([language, profiles]) => (
        <div key={language} className="contents">
          <span className="truncate text-[var(--cf-text-muted)]">{profiles[0]?.languageName || language}</span>
          <Select
            size="sm"
            value={chosen(profiles)}
            onChange={(key) => {
              const others = selected.length === 0 ? languages.map(([, list]) => list.find((p) => p.isDefault)?.key).filter((k): k is string => !!k) : selected;
              const next = others.filter((k) => !profiles.some((p) => p.key === k));
              if (key) next.push(key);
              onChange(next);
            }}
            options={[
              { value: "", label: t("reviewer.profileSkip") },
              ...profiles.map((p) => ({ value: p.key, label: `${p.name}${p.isDefault ? " ★" : ""} · ${p.activeRules}` })),
            ]}
            ariaLabel={profiles[0]?.languageName || language}
          />
        </div>
      ))}
    </div>
  );
}

const BLANK_SERVER: ReviewerRemoteServer = { id: "", name: "", url: "", organization: "", verifyTls: true };

function ServersPane() {
  const t = useT();
  const servers = useReviewerStore((s) => s.status?.servers) ?? [];
  const [editing, setEditing] = useState<ReviewerRemoteServer | null>(null);

  return (
    <>
      {servers.map((server) => (
        <ServerRow key={server.id} server={server} onEdit={() => setEditing({ ...server })} />
      ))}
      {editing ? (
        <ServerForm server={editing} onDone={() => setEditing(null)} />
      ) : (
        <button type="button" onClick={() => setEditing({ ...BLANK_SERVER })} className={buttonClass({ variant: "secondary", size: "sm" })}>
          <Plus size={12} />
          {t("reviewer.addServer")}
        </button>
      )}
    </>
  );
}

function ServerRow({ server, onEdit }: { server: ReviewerServerView; onEdit: () => void }) {
  const t = useT();
  const deleteServer = useReviewerStore((s) => s.deleteServer);
  const saveConfig = useReviewerStore((s) => s.saveConfig);
  const [check, setCheck] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);

  const test = async () => {
    setChecking(true);
    try {
      const catalog = await reviewerServerCatalog(server.id);
      setCheck({ ok: true, text: t("reviewer.checkOk", { version: catalog.version || "?", profiles: catalog.profiles.length }) });
    } catch (e) {
      setCheck({ ok: false, text: String(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="mb-3 border-b border-[var(--cf-border)] pb-3 last:mb-3">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13px] font-medium text-[var(--cf-text)]">{server.name}</span>
        <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-muted)]">{server.url}</span>
        <span className="flex-1" />
        <button type="button" onClick={onEdit} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("common.edit")}
        </button>
        <button
          type="button"
          onClick={async () => {
            if (await confirmAction(t("reviewer.removeServerConfirm", { name: server.name }))) {
              await deleteServer(server.id).catch((e: unknown) => pushErrorToast(String(e)));
            }
          }}
          className={buttonClass({ variant: "danger-ghost", size: "sm" })}
          aria-label={t("common.delete")}
        >
          <Trash2 size={12} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button type="button" disabled={checking} onClick={() => void test()} className={buttonClass({ variant: "secondary", size: "sm" })}>
          {t("reviewer.check")}
        </button>
        <button
          type="button"
          onClick={() => {
            void saveConfig({
              rules: { kind: "server", serverId: server.id, profiles: [] },
              gate: { kind: "server", serverId: server.id, gate: "" },
            });
            useUiStore.getState().openSettingsAt("reviewer", "rules");
          }}
          className={buttonClass({ variant: "ghost", size: "sm" })}
        >
          {t("reviewer.useRules")}
        </button>
        {!server.hasToken && <span className="text-[11px] text-[var(--cf-warning)]">{t("reviewer.noToken")}</span>}
        {check && (
          <Status tone={check.ok ? "success" : "warning"} wrap>
            {check.text}
          </Status>
        )}
      </div>
    </div>
  );
}

function ServerForm({ server, onDone }: { server: ReviewerRemoteServer; onDone: () => void }) {
  const t = useT();
  const saveServer = useReviewerStore((s) => s.saveServer);
  const [draft, setDraft] = useState(server);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const isNew = server.id === "";

  const save = async () => {
    setSaving(true);
    try {
      await saveServer(draft, token.trim() ? token.trim() : undefined);
      onDone();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setSaving(false);
    }
  };

  const row = "grid grid-cols-[9rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-[13px] text-[var(--cf-text)]";
  return (
    <div className="mt-1 rounded-md border border-[var(--cf-border)] p-3">
      <div className={row}>
        <span>{t("reviewer.serverName")}</span>
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Acme" className={fieldClass({ size: "sm" })} />
        <span>{t("reviewer.serverUrl")}</span>
        <input
          value={draft.url}
          onChange={(e) => setDraft({ ...draft, url: e.target.value })}
          placeholder="https://sonar.example.com"
          className={fieldClass({ size: "sm" })}
        />
        <span>{t("reviewer.serverToken")}</span>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={isNew ? "squ_…" : t("reviewer.serverTokenStored")}
          autoComplete="off"
          className={fieldClass({ size: "sm" })}
        />
        <span>{t("reviewer.serverOrg")}</span>
        <input
          value={draft.organization}
          onChange={(e) => setDraft({ ...draft, organization: e.target.value })}
          placeholder={t("reviewer.serverOrgPlaceholder")}
          className={fieldClass({ size: "sm" })}
        />
      </div>
      <label className="mt-2.5 flex items-center gap-2.5 text-[13px] text-[var(--cf-text)]">
        <Checkbox checked={draft.verifyTls} onChange={(checked) => setDraft({ ...draft, verifyTls: checked })} />
        {t("reviewer.serverVerifyTls")}
      </label>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={saving || !draft.url.trim() || (isNew && !token.trim())}
          onClick={() => void save()}
          className={buttonClass({ variant: "primary", size: "sm" })}
        >
          {t("common.save")}
        </button>
        <button type="button" onClick={onDone} className={buttonClass({ variant: "ghost", size: "sm" })}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}
