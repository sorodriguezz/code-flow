import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Check, ChevronDown, ChevronRight, CircleAlert, Copy, Eye, EyeOff, FolderOpen, Loader2, Plug, RefreshCw, Search, TriangleAlert } from "lucide-react";
import { Button, iconButtonClass } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Segmented } from "../common/Segmented";
import { Select } from "../common/Select";
import { chipClass, fieldClass, rowClass } from "../common/recipes";
import { Dialog, Field } from "./ui";
import { containersKubeAccounts, containersKubeAdd, containersKubeClouds, containersKubeTest, containersKubeTools } from "../../lib/tauri/containersCommands";
import { currentPlatform } from "../../lib/platform";
import type { TranslationKey } from "../../lib/i18n/translations";
import { useT, type Translate } from "../../state/languageStore";
import { pushSuccessToast } from "../../state/toastStore";
import type { CloudAccount, CloudCluster, CloudSource, KubeAdded, KubeAddRequest, KubeTest, KubeTools } from "../../types/containers";

/**
 * «Agregar clúster» — a Kubernetes cluster from anywhere into the Contenedores panel: a kubeconfig
 * file, Azure AKS, AWS EKS or Google GKE through their own CLIs, or a server typed in. Everything
 * lands in CodeFlow's own kubeconfig (`kubeconfig.rs`), which every kubectl the app runs reads after
 * the user's; "also in ~/.kube/config" puts it where a terminal's kubectl sees it too.
 *
 * The dialog stays open after an add — `onAdded` fires at once so the panel can read its contexts
 * again — to show what the add warned about and to test the first new context from here.
 */

type Source = "file" | CloudSource | "manual";
type Tool = keyof KubeTools;

/** The picker's options, in its order: each source's name and the line its tooltip adds. */
const SOURCES: Array<{ value: Source; label: TranslationKey; title: TranslationKey }> = [
  { value: "file", label: "containers.kube.add.source.file", title: "containers.kube.add.source.fileHint" },
  { value: "aks", label: "containers.kube.add.source.aks", title: "containers.kube.add.source.aksHint" },
  { value: "eks", label: "containers.kube.add.source.eks", title: "containers.kube.add.source.eksHint" },
  { value: "gke", label: "containers.kube.add.source.gke", title: "containers.kube.add.source.gkeHint" },
  { value: "manual", label: "containers.kube.add.source.manual", title: "containers.kube.add.source.manualHint" },
];
const ACCOUNT_LABELS: Record<CloudSource, TranslationKey> = {
  aks: "containers.kube.add.account.aks",
  eks: "containers.kube.add.account.eks",
  gke: "containers.kube.add.account.gke",
};
const CLI: Record<CloudSource, Tool> = { aks: "az", eks: "aws", gke: "gcloud" };
const TOOL_NAMES: Record<Tool, string> = {
  kubectl: "kubectl",
  az: "Azure CLI",
  aws: "AWS CLI",
  gcloud: "Google Cloud CLI",
  kubelogin: "kubelogin",
  gkeAuthPlugin: "gke-gcloud-auth-plugin",
};

/** One command that installs each tool here — what the hints and the missing-tool lines offer. */
const INSTALL: Record<Tool, { macos: string; windows: string; linux: string }> = {
  kubectl: { macos: "brew install kubectl", windows: "winget install -e --id Kubernetes.kubectl", linux: "sudo snap install kubectl --classic" },
  az: { macos: "brew install azure-cli", windows: "winget install -e --id Microsoft.AzureCLI", linux: "curl -sL https://aka.ms/InstallAzureCLIDeb | sudo bash" },
  aws: { macos: "brew install awscli", windows: "winget install -e --id Amazon.AWSCLI", linux: "sudo snap install aws-cli --classic" },
  gcloud: { macos: "brew install --cask google-cloud-sdk", windows: "winget install -e --id Google.CloudSDK", linux: "sudo snap install google-cloud-cli --classic" },
  kubelogin: { macos: "brew install Azure/kubelogin/kubelogin", windows: "az aks install-cli", linux: "az aks install-cli" },
  gkeAuthPlugin: {
    macos: "gcloud components install gke-gcloud-auth-plugin",
    windows: "gcloud components install gke-gcloud-auth-plugin",
    linux: "gcloud components install gke-gcloud-auth-plugin",
  },
};

function installCommand(tool: Tool): string {
  const platform = currentPlatform();
  return INSTALL[tool][platform === "unknown" ? "linux" : platform];
}

/** EKS lists one region at a time: the regions offered as the field is typed in. */
const AWS_REGIONS = [
  "us-east-1", "us-east-2", "us-west-1", "us-west-2", "ca-central-1", "ca-west-1", "mx-central-1", "sa-east-1",
  "eu-west-1", "eu-west-2", "eu-west-3", "eu-central-1", "eu-central-2", "eu-north-1", "eu-south-1", "eu-south-2",
  "ap-south-1", "ap-south-2", "ap-southeast-1", "ap-southeast-2", "ap-southeast-3", "ap-southeast-4", "ap-southeast-5",
  "ap-northeast-1", "ap-northeast-2", "ap-northeast-3", "ap-east-1", "me-south-1", "me-central-1", "il-central-1", "af-south-1",
];

/** A context name kubectl takes and every shell reads the same (`kubeconfig::valid_name`). */
const CONTEXT_NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:-]*$/;

/** The text field recipe's fill, hairline and focus halo, at a multi-line field's own height. */
const TEXTAREA =
  "block w-full resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-1.5 font-mono text-[11.5px] text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)] disabled:opacity-50";

interface CloudState {
  /** `null` until read. */
  accounts: CloudAccount[] | null;
  account: string;
  accountsError: string | null;
  loadingAccounts: boolean;
  region: string;
  clusters: CloudCluster[] | null;
  clustersError: string | null;
  searching: boolean;
  picked: CloudCluster | null;
  admin: boolean;
}

const NEW_CLOUD: CloudState = {
  accounts: null,
  account: "",
  accountsError: null,
  loadingAccounts: false,
  region: "",
  clusters: null,
  clustersError: null,
  searching: false,
  picked: null,
  admin: false,
};

interface ManualState {
  name: string;
  server: string;
  token: string;
  showToken: boolean;
  insecure: boolean;
  ca: string;
  cert: string;
  key: string;
  namespace: string;
  advanced: boolean;
}

const NEW_MANUAL: ManualState = { name: "", server: "", token: "", showToken: false, insecure: false, ca: "", cert: "", key: "", namespace: "", advanced: false };

/** Text with its `commands` set as code — how the backend's messages and the hints write them. */
function Coded({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded-[4px] bg-[var(--cf-hover)] px-1 py-px font-mono text-[11px] text-[var(--cf-text)]">
            {part}
          </code>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  );
}

function copyCommand(command: string, t: Translate) {
  void navigator.clipboard.writeText(command).catch(() => {});
  pushSuccessToast(t("containers.kube.add.cli.copied"));
}

/**
 * The words for a `KubeTest.hint` (`kubeconfig::hint_for` in Rust): a key, with `awsLogin` carrying
 * the profile after a colon. An unknown one is shown as it came.
 */
export function kubeHintText(t: Translate, hint: string | null | undefined): string | null {
  if (!hint) return null;
  const at = hint.indexOf(":");
  const key = at === -1 ? hint : hint.slice(0, at);
  const arg = at === -1 ? "" : hint.slice(at + 1);
  switch (key) {
    case "kubectl":
      return t("containers.kube.add.hint.kubectl", { command: installCommand("kubectl") });
    case "kubelogin":
      return t("containers.kube.add.hint.kubelogin", { command: installCommand("kubelogin") });
    case "gkePlugin":
      return t("containers.kube.add.hint.gkePlugin", { command: installCommand("gkeAuthPlugin") });
    case "awsCli":
      return t("containers.kube.add.hint.awsCli", { command: installCommand("aws") });
    case "awsLogin":
      return t("containers.kube.add.hint.awsLogin", { profile: arg ? ` --profile ${arg}` : "" });
    case "azLogin":
      return t("containers.kube.add.hint.azLogin");
    case "gcloudLogin":
      return t("containers.kube.add.hint.gcloudLogin");
    case "interactive":
      return t("containers.kube.add.hint.interactive");
    case "credentials":
      return t("containers.kube.add.hint.credentials");
    case "ca":
      return t("containers.kube.add.hint.ca");
    case "unreachable":
      return t("containers.kube.add.hint.unreachable");
    default:
      return hint;
  }
}

/** A connection test's outcome: the server's version, or kubectl's error and what to do about it. */
export function KubeTestLine({ test }: { test: KubeTest }) {
  const t = useT();
  if (test.ok) {
    return (
      <span className={chipClass("ok")}>
        <Check size={11} />
        {t("containers.kube.add.connected", { version: test.version ?? "" })}
      </span>
    );
  }
  const hint = kubeHintText(t, test.hint);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {hint && (
        <p className="text-[12px] leading-snug text-[var(--cf-text)]">
          <Coded text={hint} />
        </p>
      )}
      {test.error && <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--cf-danger)]">{test.error}</p>}
    </div>
  );
}

/** A tool this source cannot work without: its name and the one command that installs it. */
function MissingTool({ tool }: { tool: Tool }) {
  const t = useT();
  const command = installCommand(tool);
  return (
    <div className="flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
      <TriangleAlert size={13} className="shrink-0 text-[var(--cf-warning)]" />
      <span className="min-w-0 flex-1">
        <Coded text={t("containers.kube.add.cli.missing", { tool: TOOL_NAMES[tool], command })} />
      </span>
      <button type="button" onClick={() => copyCommand(command, t)} className={iconButtonClass({ size: "xs" })} aria-label={t("containers.kube.add.cli.copy")} title={t("containers.kube.add.cli.copy")}>
        <Copy size={12} />
      </button>
    </div>
  );
}

/** A plugin a cluster may need but the form can go on without: a chip that copies its install. */
function PluginChip({ tool, hint }: { tool: Tool; hint: string }) {
  const t = useT();
  const command = installCommand(tool);
  return (
    <button type="button" onClick={() => copyCommand(command, t)} title={`${hint}\n${command}`} className={chipClass("warn", "cursor-pointer")}>
      <TriangleAlert size={11} />
      {t("containers.kube.add.plugin.missing", { tool: TOOL_NAMES[tool] })}
    </button>
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 text-[12px] leading-snug text-[var(--cf-danger)]">
      <CircleAlert size={13} className="mt-px shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        <Coded text={text} />
      </span>
    </div>
  );
}

function accountLabel(source: CloudSource, account: CloudAccount): string {
  if (source === "gke" && account.name !== account.id) return `${account.name} (${account.id})`;
  return account.name || account.id;
}

function CloudPane({
  source,
  tools,
  state,
  onPatch,
  onLoadAccounts,
  onSearch,
}: {
  source: CloudSource;
  tools: KubeTools | null;
  state: CloudState;
  onPatch: (patch: Partial<CloudState>) => void;
  onLoadAccounts: () => void;
  onSearch: () => void;
}) {
  const t = useT();
  if (tools && !tools[CLI[source]]) return <MissingTool tool={CLI[source]} />;
  const accounts = state.accounts ?? [];
  // EKS can list with the AWS CLI's own default credentials when no profile is configured.
  const options =
    source === "eks" && state.accounts !== null && accounts.length === 0
      ? [{ value: "", label: t("containers.kube.add.account.defaultChain") }]
      : accounts.map((account) => ({ value: account.id, label: accountLabel(source, account) }));
  const placeholder = state.loadingAccounts || state.accounts === null ? t("containers.kube.add.account.loading") : t("containers.kube.add.account.none");
  const canSearch =
    !!tools && !state.loadingAccounts && !state.searching && (source === "eks" ? state.region.trim() !== "" : state.account !== "");
  const pickedKey = state.picked ? `${state.picked.group}/${state.picked.location}/${state.picked.name}` : null;
  const accountTitle = ACCOUNT_LABELS[source];

  return (
    <div className="flex flex-col gap-3">
      {tools && source === "aks" && !tools.kubelogin && (
        <div>
          <PluginChip tool="kubelogin" hint={t("containers.kube.add.plugin.kubeloginHint")} />
        </div>
      )}
      {tools && source === "gke" && !tools.gkeAuthPlugin && (
        <div>
          <PluginChip tool="gkeAuthPlugin" hint={t("containers.kube.add.plugin.gkeHint")} />
        </div>
      )}
      <div className="flex items-end gap-2">
        <Field label={t(accountTitle)} className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {/* `Select`'s trigger fills its parent: the parent sets the width. */}
            <div className="min-w-0 flex-1">
              <Select
                value={state.account}
                onChange={(account) => onPatch({ account, clusters: null, clustersError: null, picked: null })}
                options={options}
                placeholder={placeholder}
                disabled={!tools || state.loadingAccounts || options.length === 0}
                size="field"
                ariaLabel={t(accountTitle)}
              />
            </div>
            <button
              type="button"
              onClick={onLoadAccounts}
              disabled={!tools || state.loadingAccounts}
              className={iconButtonClass({ size: "md" })}
              aria-label={t("containers.kube.add.account.reload")}
              title={t("containers.kube.add.account.reload")}
            >
              {state.loadingAccounts ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            </button>
          </div>
        </Field>
        {source === "eks" && (
          <Field label={t("containers.kube.add.region")} className="w-[150px] shrink-0">
            <input
              value={state.region}
              onChange={(e) => onPatch({ region: e.target.value, clusters: null, clustersError: null, picked: null })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSearch) {
                  e.preventDefault();
                  onSearch();
                }
              }}
              list="cf-kube-aws-regions"
              placeholder="us-east-1"
              spellCheck={false}
              className={fieldClass({ className: "w-full font-mono" })}
            />
            <datalist id="cf-kube-aws-regions">
              {AWS_REGIONS.map((region) => (
                <option key={region} value={region} />
              ))}
            </datalist>
          </Field>
        )}
        <Button size="lg" onClick={onSearch} disabled={!canSearch}>
          {state.searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
          {state.searching ? t("containers.kube.add.searching") : t("containers.kube.add.search")}
        </Button>
      </div>
      {state.accountsError && <ErrorLine text={state.accountsError} />}
      {state.clustersError && <ErrorLine text={state.clustersError} />}
      {state.clusters && !state.clustersError && (
        <div className="flex max-h-[220px] flex-col gap-px overflow-y-auto rounded-md border border-[var(--cf-border)] p-1">
          {state.clusters.length === 0 ? (
            <p className="px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("containers.kube.add.noClusters")}</p>
          ) : (
            state.clusters.map((cluster) => {
              const key = `${cluster.group}/${cluster.location}/${cluster.name}`;
              return (
                <button key={key} type="button" onClick={() => onPatch({ picked: cluster })} aria-pressed={key === pickedKey} className={rowClass(key === pickedKey, "h-8 shrink-0")}>
                  <span className="min-w-0 truncate font-medium">{cluster.name}</span>
                  {cluster.group && cluster.group !== cluster.location && <span className="min-w-0 truncate text-[11.5px] text-[var(--cf-text-faint)]">{cluster.group}</span>}
                  <span className="flex-1" />
                  <span className="shrink-0 font-mono text-[11.5px] text-[var(--cf-text-muted)]">{cluster.location}</span>
                  {cluster.version && <span className={chipClass("neutral")}>{cluster.version}</span>}
                </button>
              );
            })
          )}
        </div>
      )}
      {source === "aks" && (
        <label className="flex w-fit items-center gap-2 text-[12px] text-[var(--cf-text)]" title={t("containers.kube.add.adminHint")}>
          <Checkbox checked={state.admin} onChange={(admin) => onPatch({ admin })} />
          {t("containers.kube.add.admin")}
        </label>
      )}
    </div>
  );
}

function ManualPane({ state, onPatch, onSubmit }: { state: ManualState; onPatch: (patch: Partial<ManualState>) => void; onSubmit: () => void }) {
  const t = useT();
  const name = state.name.trim();
  const server = state.server.trim();
  const badName = name !== "" && !CONTEXT_NAME.test(name);
  const badServer = server !== "" && !/^https?:\/\/[^/\s]+/i.test(server);
  const unpaired = (state.cert.trim() === "") !== (state.key.trim() === "");
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSubmit();
    }
  };
  const input = fieldClass({ className: "w-full" });
  const mono = fieldClass({ className: "w-full font-mono" });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[1fr_170px] gap-3">
        <Field label={t("containers.kube.add.manual.name")} hint={badName ? <span className="text-[var(--cf-danger)]">{t("containers.kube.add.manual.badName")}</span> : undefined}>
          <input autoFocus value={state.name} onChange={(e) => onPatch({ name: e.target.value })} onKeyDown={enter} placeholder={t("containers.kube.add.manual.namePlaceholder")} spellCheck={false} className={input} />
        </Field>
        <Field label={t("containers.kube.add.manual.namespace")}>
          <input value={state.namespace} onChange={(e) => onPatch({ namespace: e.target.value })} onKeyDown={enter} placeholder="default" spellCheck={false} className={input} />
        </Field>
      </div>
      <Field
        label={t("containers.kube.add.manual.server")}
        hint={
          badServer ? (
            <span className="text-[var(--cf-danger)]">{t("containers.kube.add.manual.badServer")}</span>
          ) : /^http:\/\//i.test(server) ? (
            <span className="text-[var(--cf-warning)]">{t("containers.kube.add.manual.http")}</span>
          ) : undefined
        }
      >
        <input value={state.server} onChange={(e) => onPatch({ server: e.target.value })} onKeyDown={enter} placeholder="https://10.0.0.1:6443" spellCheck={false} className={mono} />
      </Field>
      <Field label={t("containers.kube.add.manual.token")}>
        <div className="relative">
          <input
            type={state.showToken ? "text" : "password"}
            value={state.token}
            onChange={(e) => onPatch({ token: e.target.value })}
            onKeyDown={enter}
            spellCheck={false}
            autoComplete="off"
            className={fieldClass({ className: "w-full pr-8 font-mono" })}
          />
          <button
            type="button"
            onClick={() => onPatch({ showToken: !state.showToken })}
            className={iconButtonClass({ size: "xs", className: "absolute right-1 top-1/2 -translate-y-1/2" })}
            aria-label={state.showToken ? t("containers.kube.add.manual.hideToken") : t("containers.kube.add.manual.showToken")}
            title={state.showToken ? t("containers.kube.add.manual.hideToken") : t("containers.kube.add.manual.showToken")}
          >
            {state.showToken ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        </div>
      </Field>
      <label className="flex w-fit items-center gap-2 text-[12px] text-[var(--cf-text)]" title={t("containers.kube.add.manual.insecureHint")}>
        <Checkbox checked={state.insecure} onChange={(insecure) => onPatch({ insecure })} />
        {t("containers.kube.add.manual.insecure")}
      </label>
      {!state.insecure && (
        <Field label={t("containers.kube.add.manual.ca")} hint={t("containers.kube.add.manual.caHint")}>
          <textarea value={state.ca} onChange={(e) => onPatch({ ca: e.target.value })} rows={3} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" className={TEXTAREA} />
        </Field>
      )}
      <div className="flex flex-col gap-2">
        <button type="button" onClick={() => onPatch({ advanced: !state.advanced })} aria-expanded={state.advanced} className="flex w-fit items-center gap-1 text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]">
          {state.advanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {t("containers.kube.add.manual.advanced")}
        </button>
        {state.advanced && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("containers.kube.add.manual.clientCert")}>
              <textarea value={state.cert} onChange={(e) => onPatch({ cert: e.target.value })} rows={3} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" className={TEXTAREA} />
            </Field>
            <Field label={t("containers.kube.add.manual.clientKey")}>
              <textarea value={state.key} onChange={(e) => onPatch({ key: e.target.value })} rows={3} spellCheck={false} placeholder="-----BEGIN PRIVATE KEY-----" className={TEXTAREA} />
            </Field>
          </div>
        )}
        {unpaired && <p className="text-[11px] text-[var(--cf-danger)]">{t("containers.kube.add.manual.certPair")}</p>}
      </div>
    </div>
  );
}

export function KubeAddCluster({ onClose, onAdded }: { onClose: () => void; onAdded: (added: KubeAdded) => void }) {
  const t = useT();
  const [source, setSource] = useState<Source>("file");
  const [tools, setTools] = useState<KubeTools | null>(null);
  const [path, setPath] = useState("");
  const [clouds, setClouds] = useState<Record<CloudSource, CloudState>>({ aks: NEW_CLOUD, eks: NEW_CLOUD, gke: NEW_CLOUD });
  const [manual, setManual] = useState<ManualState>(NEW_MANUAL);
  const [toUserConfig, setToUserConfig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [added, setAdded] = useState<KubeAdded | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<KubeTest | null>(null);

  useEffect(() => {
    let live = true;
    containersKubeTools()
      .then((found) => live && setTools(found))
      .catch(() => live && setTools({ kubectl: false, az: false, aws: false, gcloud: false, kubelogin: false, gkeAuthPlugin: false }));
    return () => {
      live = false;
    };
  }, []);

  const patchCloud = (cloud: CloudSource, patch: Partial<CloudState>) => setClouds((all) => ({ ...all, [cloud]: { ...all[cloud], ...patch } }));

  const loadAccounts = async (cloud: CloudSource) => {
    patchCloud(cloud, { loadingAccounts: true, accountsError: null });
    try {
      const accounts = await containersKubeAccounts(cloud);
      const preferred = accounts.find((account) => account.isDefault) ?? accounts[0];
      patchCloud(cloud, { accounts, account: preferred?.id ?? "", loadingAccounts: false, clusters: null, clustersError: null, picked: null });
    } catch (error) {
      patchCloud(cloud, { accounts: [], account: "", accountsError: String(error), loadingAccounts: false });
    }
  };

  // A cloud's accounts are read the first time its tab is shown, once its CLI is known to be there.
  const cloud = source === "file" || source === "manual" ? null : source;
  const cloudState = cloud ? clouds[cloud] : null;
  useEffect(() => {
    if (!cloud || !tools || !tools[CLI[cloud]] || !cloudState || cloudState.accounts !== null || cloudState.loadingAccounts) return;
    void loadAccounts(cloud);
    // `loadAccounts` only patches state; the read is keyed by what decides it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud, tools, cloudState?.accounts, cloudState?.loadingAccounts]);

  const search = async (cloud: CloudSource) => {
    const state = clouds[cloud];
    patchCloud(cloud, { searching: true, clustersError: null, picked: null });
    try {
      const clusters = await containersKubeClouds(cloud, state.account || null, cloud === "eks" ? state.region.trim() || null : null);
      // One cluster is the one meant.
      patchCloud(cloud, { clusters, searching: false, picked: clusters.length === 1 ? clusters[0] : null });
    } catch (error) {
      patchCloud(cloud, { clusters: [], clustersError: String(error), searching: false });
    }
  };

  const request = useMemo<KubeAddRequest | null>(() => {
    if (source === "file") {
      return path.trim() ? { source: "file", path: path.trim(), toUserConfig } : null;
    }
    if (source === "manual") {
      const name = manual.name.trim();
      const server = manual.server.trim();
      if (!CONTEXT_NAME.test(name) || !/^https?:\/\/[^/\s]+/i.test(server)) return null;
      if ((manual.cert.trim() === "") !== (manual.key.trim() === "")) return null;
      return {
        source: "manual",
        name,
        server,
        token: manual.token.trim(),
        certificateAuthority: manual.insecure ? "" : manual.ca,
        insecure: manual.insecure,
        clientCertificate: manual.cert,
        clientKey: manual.key,
        namespace: manual.namespace.trim(),
        toUserConfig,
      };
    }
    const state = clouds[source];
    const picked = state.picked;
    if (!picked) return null;
    switch (source) {
      case "aks":
        return { source: "aks", subscription: picked.account || state.account, resourceGroup: picked.group, name: picked.name, admin: state.admin, toUserConfig };
      case "eks":
        return { source: "eks", region: picked.location || state.region.trim(), name: picked.name, profile: state.account, toUserConfig };
      case "gke":
        return { source: "gke", project: picked.group || state.account, location: picked.location, name: picked.name, toUserConfig };
    }
  }, [source, path, manual, clouds, toUserConfig]);

  const submit = async () => {
    if (!request || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await containersKubeAdd(request);
      setAdded(result);
      setTest(null);
      pushSuccessToast(t("containers.kube.add.added", { name: result.contexts.join(", ") }));
      onAdded(result);
    } catch (error) {
      setProblem(String(error));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    const context = added?.contexts[0];
    if (!context) return;
    setTesting(true);
    setTest(null);
    try {
      setTest(await containersKubeTest(context));
    } catch (error) {
      setTest({ ok: false, version: null, error: String(error), hint: null });
    } finally {
      setTesting(false);
    }
  };

  const another = () => {
    setAdded(null);
    setTest(null);
    setProblem(null);
    setPath("");
    setManual((m) => ({ ...m, name: "", token: "", cert: "", key: "" }));
    setClouds((all) => ({ aks: { ...all.aks, picked: null }, eks: { ...all.eks, picked: null }, gke: { ...all.gke, picked: null } }));
  };

  const pickFile = async () => {
    const chosen = await openDialog({ multiple: false, directory: false, title: t("containers.kube.add.file.pickTitle") }).catch(() => null);
    if (typeof chosen === "string") setPath(chosen);
  };

  const sourceOptions = SOURCES.map((option) => ({ value: option.value, label: t(option.label), title: t(option.title) }));

  const footer = added ? (
    <>
      <Button size="md" variant="ghost" onClick={another}>
        {t("containers.kube.add.another")}
      </Button>
      <Button size="md" variant="primary" onClick={onClose}>
        {t("containers.kube.add.done")}
      </Button>
    </>
  ) : (
    <>
      <label className="mr-auto flex items-center gap-2 text-[12px] text-[var(--cf-text)]" title={t("containers.kube.add.toUserHint")}>
        <Checkbox checked={toUserConfig} onChange={setToUserConfig} />
        {t("containers.kube.add.toUser")}
      </label>
      <Button size="md" variant="ghost" onClick={onClose}>
        {t("common.cancel")}
      </Button>
      <Button size="md" variant="primary" onClick={() => void submit()} disabled={!request || busy}>
        {busy && <Loader2 size={13} className="animate-spin" />}
        {busy ? t("containers.kube.add.adding") : t("containers.kube.add.add")}
      </Button>
    </>
  );

  return (
    <Dialog title={t("containers.kube.add.title")} onClose={onClose} width={620} footer={footer}>
      {added ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_oklab,var(--cf-success)_16%,transparent)] text-[var(--cf-success)]">
              <Check size={12} />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <p className="break-all text-[13px] font-medium text-[var(--cf-text)]">{t("containers.kube.add.added", { name: added.contexts.join(", ") })}</p>
              <p className="break-all font-mono text-[11px] text-[var(--cf-text-faint)]">{t("containers.kube.add.savedIn", { file: added.file })}</p>
            </div>
          </div>
          {added.warnings.length > 0 && (
            <ul className="flex flex-col gap-1.5">
              {added.warnings.map((warning, index) => (
                <li key={index} className="flex items-start gap-2 text-[12px] leading-snug text-[var(--cf-text-muted)]">
                  <TriangleAlert size={13} className="mt-px shrink-0 text-[var(--cf-warning)]" />
                  <span className="min-w-0 break-words">
                    <Coded text={warning} />
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-start gap-3">
            <Button size="md" onClick={() => void runTest()} disabled={testing}>
              {testing ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
              {testing ? t("containers.kube.add.testing") : t("containers.kube.add.test")}
            </Button>
            {test && (
              <div className="min-w-0 flex-1 pt-1">
                <KubeTestLine test={test} />
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className="flex flex-col gap-4"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        >
          <Segmented<Source> options={sourceOptions} value={source} onChange={setSource} layoutId="cf-kube-add-source" full ariaLabel={t("containers.kube.add.title")} />
          {tools && !tools.kubectl && <MissingTool tool="kubectl" />}
          {source === "file" && (
            <Field label={t("containers.kube.add.file.label")} hint={t("containers.kube.add.file.hint")}>
              <div className="flex gap-1.5">
                <input
                  autoFocus
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="~/Downloads/cluster.yaml"
                  spellCheck={false}
                  className={fieldClass({ className: "w-full font-mono" })}
                />
                <Button size="lg" onClick={() => void pickFile()}>
                  <FolderOpen size={13} />
                  {t("containers.kube.add.file.choose")}
                </Button>
              </div>
            </Field>
          )}
          {cloud && cloudState && (
            <CloudPane
              source={cloud}
              tools={tools}
              state={cloudState}
              onPatch={(patch) => patchCloud(cloud, patch)}
              onLoadAccounts={() => void loadAccounts(cloud)}
              onSearch={() => void search(cloud)}
            />
          )}
          {source === "manual" && <ManualPane state={manual} onPatch={(patch) => setManual((m) => ({ ...m, ...patch }))} onSubmit={() => void submit()} />}
          {problem && <ErrorLine text={problem} />}
        </div>
      )}
    </Dialog>
  );
}
