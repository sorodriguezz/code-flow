import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Download, Loader2, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import { Button } from "../common/Button";
import { chipClass, fieldClass, rowClass } from "../common/recipes";
import { DetailTabs, Facts, HeaderAction, RowAction, StateDot, TextView, ago, useInterval } from "./containerBits";
import { DetailHeader } from "./ContainersDetail";
import { DataTable, Dialog, EmptyLine, Field, FormSection, LiveMark, LoadingLine, PageHead, PageToolbar, SearchField, Td, Th, trClass } from "./ui";
import { InstallHint } from "./KubeLocalClusters";
import { helmTone, releaseNameFor, validNamespace, validReleaseName, validRepoName, validRepoUrl } from "./localModel";
import {
  containersHelmChartValues,
  containersHelmInstall,
  containersHelmRelease,
  containersHelmReleases,
  containersHelmRepoAdd,
  containersHelmRepoRemove,
  containersHelmRepoUpdate,
  containersHelmRepos,
  containersHelmRollback,
  containersHelmSearch,
  containersHelmUninstall,
  containersHelmUpgrade,
} from "../../lib/tauri/containersLocalCommands";
import { confirmAction } from "../../state/confirmStore";
import { useContainersStore } from "../../state/containersStore";
import { useLocalClustersStore } from "../../state/localClustersStore";
import { useLanguageStore, useT } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";
import type { HelmChart, HelmRelease, HelmReleaseDetail, HelmRepo } from "../../types/containersLocal";

/**
 * «Helm» — one cluster's releases, through the user's own `helm` (`containers/helm.rs`): what is
 * installed, one release's state, revisions, values and manifest, and the verbs a person types most —
 * upgrade with other values, roll back, uninstall, install a chart from a repository. Every command
 * names the context the panel is on; the namespace picked in the navigation filters the list.
 */

/** Repositories most charts come from, offered when none is configured yet. */
const KNOWN_REPOS: HelmRepo[] = [
  { name: "bitnami", url: "https://charts.bitnami.com/bitnami" },
  { name: "ingress-nginx", url: "https://kubernetes.github.io/ingress-nginx" },
  { name: "jetstack", url: "https://charts.jetstack.io" },
  { name: "prometheus-community", url: "https://prometheus-community.github.io/helm-charts" },
];

function Ago({ stamp }: { stamp: string }) {
  const language = useLanguageStore((s) => s.language);
  return <span className="text-[var(--cf-text-muted)]">{stamp ? ago(stamp, language) : "—"}</span>;
}

function Status({ status }: { status: string }) {
  const tone = helmTone(status);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <StateDot tone={tone} />
      <span className={`truncate ${tone === "bad" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text)]"}`}>{status || "—"}</span>
    </span>
  );
}

const mono = (value: string) => <span className="font-mono text-[11.5px] text-[var(--cf-text-muted)]">{value || "—"}</span>;

interface ReleasesState {
  context: string | null;
  rows: HelmRelease[];
  error: string | null;
  loading: boolean;
}

export function HelmPage() {
  const t = useT();
  const context = useContainersStore((s) => s.contextOf("kubernetes"));
  const namespace = useContainersStore((s) => s.namespaceOf(context));
  const reach = useContainersStore((s) => s.reach[context ?? ""]);
  const tools = useLocalClustersStore((s) => s.tools);
  const loadTools = useLocalClustersStore((s) => s.load);
  const [state, setState] = useState<ReleasesState | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<{ namespace: string; name: string } | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (tools === null) void loadTools();
  }, [tools, loadTools]);
  useEffect(() => setOpen(null), [context]);

  const load = useCallback(async () => {
    setState((s) => (s && s.context === context ? { ...s, loading: true } : { context, rows: [], error: null, loading: true }));
    try {
      const rows = await containersHelmReleases(context);
      setState({ context, rows, error: null, loading: false });
    } catch (error) {
      setState({ context, rows: [], error: String(error), loading: false });
    }
  }, [context]);
  const helm = tools?.helm === true;
  useInterval(() => void load(), 10000, helm && !!context && !open && reach?.ok !== false);

  const current = state?.context === context ? state : null;
  const rows = useMemo(() => {
    const all = current?.rows ?? [];
    const needle = query.trim().toLowerCase();
    return all.filter((r) => (!namespace || r.namespace === namespace) && (!needle || r.name.includes(needle) || r.chart.toLowerCase().includes(needle) || r.status.includes(needle)));
  }, [current, namespace, query]);

  const uninstall = async (release: { namespace: string; name: string }) => {
    if (!(await confirmAction(t("containers.helm.confirmUninstall", { name: release.name, namespace: release.namespace, context: context ?? "" }), true, t("containers.helm.uninstall")))) return;
    try {
      await containersHelmUninstall(context, release.namespace, release.name);
      pushSuccessToast(t("containers.helm.uninstalled", { name: release.name }));
      setOpen(null);
      void load();
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  if (tools && !helm) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <PageHead title={t("containers.helm.title")} sub={context ?? undefined} />
        <div className="flex flex-col gap-2 px-3 py-3">
          <p className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.helm.missing")}</p>
          <InstallHint tool="helm" />
        </div>
      </div>
    );
  }
  if (open) {
    return <HelmReleaseView context={context} namespace={open.namespace} name={open.name} onBack={() => setOpen(null)} onUninstall={() => void uninstall(open)} onChanged={() => void load()} />;
  }
  const failing = rows.filter((r) => r.status === "failed").length;
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHead
        title={t("containers.helm.title")}
        sub={[context, namespace || t("containers.allNamespaces"), rows.length ? String(rows.length) : null, failing ? t("containers.m.kube.failing", { count: failing }) : null].filter(Boolean).join(" · ")}
      >
        <Button size="sm" variant="primary" onClick={() => setInstalling(true)} disabled={!helm}>
          <Plus size={13} />
          {t("containers.helm.install")}
        </Button>
      </PageHead>
      <PageToolbar>
        <SearchField value={query} onChange={setQuery} placeholder={t("containers.helm.search")} />
        <div className="flex-1" />
        {current?.loading && <Loader2 size={11} className="animate-spin text-[var(--cf-text-muted)]" />}
        {reach?.ok !== false && <LiveMark />}
      </PageToolbar>
      {reach && !reach.ok ? (
        <EmptyLine>{t("containers.clusterUnreachable", { reason: reach.text })}</EmptyLine>
      ) : !current || (current.loading && current.rows.length === 0 && !current.error) ? (
        <LoadingLine />
      ) : current.error ? (
        <EmptyLine>{current.error}</EmptyLine>
      ) : rows.length === 0 ? (
        <EmptyLine>{current.rows.length ? t("containers.m.kube.noMatch") : t("containers.helm.none")}</EmptyLine>
      ) : (
        <DataTable minWidth={760}>
          <thead>
            <tr>
              <Th>{t("containers.m.col.name")}</Th>
              {!namespace && <Th width={140}>{t("containers.namespace")}</Th>}
              <Th width={140}>{t("containers.m.col.state")}</Th>
              <Th width={80} align="right">
                {t("containers.helm.revision")}
              </Th>
              <Th>{t("containers.helm.chart")}</Th>
              <Th width={110}>{t("containers.helm.appVersion")}</Th>
              <Th width={90}>{t("containers.helm.updated")}</Th>
              <Th align="right" width={40} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.namespace}/${row.name}`} className={trClass(false, true)} onClick={() => setOpen({ namespace: row.namespace, name: row.name })}>
                <Td className="max-w-[260px]">
                  <span className="block truncate font-medium text-[var(--cf-text)]" title={row.name}>
                    {row.name}
                  </span>
                </Td>
                {!namespace && <Td>{mono(row.namespace)}</Td>}
                <Td>
                  <Status status={row.status} />
                </Td>
                <Td align="right">{row.revision}</Td>
                <Td>{mono(row.chart)}</Td>
                <Td>{mono(row.appVersion)}</Td>
                <Td>
                  <Ago stamp={row.updated} />
                </Td>
                <Td align="right">
                  <RowAction label={t("containers.helm.uninstall")} danger onClick={() => void uninstall(row)}>
                    <Trash2 size={12} />
                  </RowAction>
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {installing && (
        <HelmInstallDialog
          context={context}
          namespace={namespace || "default"}
          onClose={() => setInstalling(false)}
          onInstalled={(release) => {
            setInstalling(false);
            void load();
            setOpen(release);
          }}
        />
      )}
    </div>
  );
}

type ReleaseTab = "overview" | "history" | "values" | "manifest";

/** One release: its state and notes, its revisions (each one a rollback away), its values (edited
 *  and upgraded with) and its manifest. */
function HelmReleaseView({
  context,
  namespace,
  name,
  onBack,
  onUninstall,
  onChanged,
}: {
  context: string | null;
  namespace: string;
  name: string;
  onBack: () => void;
  onUninstall: () => void;
  onChanged: () => void;
}) {
  const t = useT();
  const [detail, setDetail] = useState<HelmReleaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<ReleaseTab>("overview");
  const [draft, setDraft] = useState<string | null>(null);
  const [chart, setChart] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await containersHelmRelease(context, namespace, name);
      setDetail(next);
      setError(null);
      setDraft(null);
      setChart(next.chartGuess ?? next.chartName);
      setVersion(next.chartVersion);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [context, namespace, name]);
  useEffect(() => {
    void load();
  }, [load]);

  const changed = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    try {
      await work();
      pushSuccessToast(label);
      await load();
      onChanged();
    } catch (e) {
      pushErrorToast(String(e));
    } finally {
      setBusy(null);
    }
  };
  const upgrade = async () => {
    if (!detail || !chart.trim()) return;
    if (!(await confirmAction(t("containers.helm.confirmUpgrade", { name, chart: chart.trim(), context: context ?? "" }), false, t("containers.helm.upgrade")))) return;
    void changed(t("containers.helm.upgraded", { name }), () =>
      containersHelmUpgrade({ context, namespace, name, chart: chart.trim(), version: version.trim() || null, values: draft ?? detail.values }),
    );
  };
  const rollback = async (revision: number) => {
    if (!(await confirmAction(t("containers.helm.confirmRollback", { name, revision, context: context ?? "" }), false, t("containers.helm.rollback")))) return;
    void changed(t("containers.helm.rolledBack", { name, revision }), () => containersHelmRollback(context, namespace, name, revision));
  };

  const values = draft ?? detail?.values ?? "";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <DetailHeader
        leading={
          <RowAction label={t("containers.helm.back")} onClick={onBack}>
            <ArrowLeft size={14} />
          </RowAction>
        }
        title={name}
        subtitle={[namespace, detail && `${detail.chartName}-${detail.chartVersion}`, context].filter(Boolean).join(" · ")}
      >
        {detail && <Status status={detail.status} />}
        <HeaderAction onClick={() => void load()} label={t("containers.refresh")} icon={loading ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />} disabled={loading} />
        <HeaderAction onClick={onUninstall} label={t("containers.helm.uninstall")} icon={<Trash2 size={11} />} danger disabled={!!busy} />
      </DetailHeader>
      <DetailTabs<ReleaseTab>
        tabs={[
          { id: "overview", label: t("containers.helm.tab.overview") },
          { id: "history", label: t("containers.helm.tab.history") },
          { id: "values", label: t("containers.helm.tab.values") },
          { id: "manifest", label: t("containers.helm.tab.manifest") },
        ]}
        value={tab}
        onChange={setTab}
      />
      {error ? (
        <EmptyLine>{error}</EmptyLine>
      ) : !detail ? (
        <LoadingLine />
      ) : tab === "overview" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <Facts
            rows={[
              [t("containers.m.col.state"), <Status status={detail.status} />],
              [t("containers.helm.revision"), String(detail.revision)],
              [t("containers.helm.chart"), `${detail.chartName} ${detail.chartVersion}`],
              [t("containers.helm.appVersion"), detail.appVersion],
              [t("containers.namespace"), detail.namespace],
              [t("containers.helm.firstDeployed"), detail.firstDeployed && <Ago stamp={detail.firstDeployed} />],
              [t("containers.helm.lastDeployed"), detail.lastDeployed && <Ago stamp={detail.lastDeployed} />],
              [t("containers.helm.description"), detail.description],
            ]}
          />
          {detail.notes.trim() && (
            <>
              <h4 className="mb-1.5 mt-4 text-[11px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)]">{t("containers.helm.notes")}</h4>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-[var(--cf-sunken)] p-2.5 font-mono text-[11.5px] leading-snug text-[var(--cf-text)] shadow-[inset_0_0_0_1px_var(--cf-border)]">{detail.notes.trim()}</pre>
            </>
          )}
        </div>
      ) : tab === "history" ? (
        <DataTable minWidth={680}>
          <thead>
            <tr>
              <Th width={80} align="right">
                {t("containers.helm.revision")}
              </Th>
              <Th width={130}>{t("containers.m.col.state")}</Th>
              <Th>{t("containers.helm.chart")}</Th>
              <Th width={100}>{t("containers.helm.appVersion")}</Th>
              <Th width={90}>{t("containers.helm.updated")}</Th>
              <Th>{t("containers.helm.description")}</Th>
              <Th align="right" width={110} />
            </tr>
          </thead>
          <tbody>
            {detail.history.map((rev) => (
              <tr key={rev.revision} className={trClass(rev.revision === detail.revision)}>
                <Td align="right">{rev.revision}</Td>
                <Td>
                  <Status status={rev.status} />
                </Td>
                <Td>{mono(rev.chart)}</Td>
                <Td>{mono(rev.appVersion)}</Td>
                <Td>
                  <Ago stamp={rev.updated} />
                </Td>
                <Td className="max-w-[260px]">
                  <span className="block truncate text-[11.5px] text-[var(--cf-text-muted)]" title={rev.description}>
                    {rev.description}
                  </span>
                </Td>
                <Td align="right">
                  {rev.revision !== detail.revision && (
                    <Button size="sm" variant="ghost" onClick={() => void rollback(rev.revision)} disabled={!!busy}>
                      <RotateCcw size={12} />
                      {t("containers.helm.rollback")}
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : tab === "values" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex shrink-0 flex-wrap items-end gap-2 border-b border-[var(--cf-border)] px-3 py-2">
            <Field label={t("containers.helm.chart")} className="min-w-[220px] flex-1" hint={detail.chartGuess ? undefined : t("containers.helm.chartHint")}>
              <input value={chart} onChange={(e) => setChart(e.target.value)} placeholder="repo/chart" spellCheck={false} className={fieldClass({ size: "sm", className: "w-full font-mono" })} />
            </Field>
            <Field label={t("containers.helm.version")} className="w-[130px]">
              <input value={version} onChange={(e) => setVersion(e.target.value)} spellCheck={false} className={fieldClass({ size: "sm", className: "w-full font-mono" })} />
            </Field>
            {draft !== null && (
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                {t("containers.helm.discard")}
              </Button>
            )}
            <Button size="sm" variant="primary" onClick={() => void upgrade()} disabled={!!busy || !chart.trim()}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t("containers.helm.upgrade")}
            </Button>
          </div>
          <p className="shrink-0 px-3 py-1.5 text-[11px] text-[var(--cf-text-faint)]">{t("containers.helm.valuesHint")}</p>
          <TextView value={values} language="yaml" editable onChange={setDraft} />
        </div>
      ) : (
        <TextView value={detail.manifest} language="yaml" />
      )}
    </div>
  );
}

/** «Instalar chart»: the repositories Helm knows (add, update, remove), a chart found in them, and
 *  the release's name, namespace and values. */
function HelmInstallDialog({
  context,
  namespace: initialNamespace,
  onClose,
  onInstalled,
}: {
  context: string | null;
  namespace: string;
  onClose: () => void;
  onInstalled: (release: { namespace: string; name: string }) => void;
}) {
  const t = useT();
  const [repos, setRepos] = useState<HelmRepo[] | null>(null);
  const [repoName, setRepoName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoBusy, setRepoBusy] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<HelmChart[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [chart, setChart] = useState("");
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [namespace, setNamespace] = useState(initialNamespace);
  const [values, setValues] = useState("");
  const [loadingValues, setLoadingValues] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const loadRepos = useCallback(async () => {
    try {
      setRepos(await containersHelmRepos());
    } catch (e) {
      setRepos([]);
      setProblem(String(e));
    }
  }, []);
  useEffect(() => {
    void loadRepos();
  }, [loadRepos]);

  const repoWork = async (label: string, work: () => Promise<string>) => {
    setRepoBusy(label);
    setProblem(null);
    try {
      await work();
      await loadRepos();
    } catch (e) {
      setProblem(String(e));
    } finally {
      setRepoBusy(null);
    }
  };
  const addRepo = (repo: HelmRepo) =>
    void repoWork(`add:${repo.name}`, async () => {
      const out = await containersHelmRepoAdd(repo.name, repo.url);
      setRepoName("");
      setRepoUrl("");
      pushSuccessToast(t("containers.helm.repoAdded", { name: repo.name }));
      return out;
    });
  const removeRepo = async (repo: HelmRepo) => {
    if (!(await confirmAction(t("containers.helm.confirmRepoRemove", { name: repo.name }), true, t("containers.remove")))) return;
    void repoWork(`remove:${repo.name}`, () => containersHelmRepoRemove(repo.name));
  };

  const search = async () => {
    setSearching(true);
    setProblem(null);
    try {
      setResults(await containersHelmSearch(term.trim()));
    } catch (e) {
      setResults([]);
      setProblem(String(e));
    } finally {
      setSearching(false);
    }
  };
  const pick = (picked: HelmChart) => {
    setChart(picked.name);
    setVersion(picked.version);
    setVersions([]);
    if (!nameTouched) setName(releaseNameFor(picked.name));
    containersHelmSearch(picked.name, true)
      .then((all) => setVersions(all.filter((c) => c.name === picked.name).map((c) => c.version)))
      .catch(() => {});
  };
  const loadDefaults = async () => {
    if (!chart.trim()) return;
    setLoadingValues(true);
    setProblem(null);
    try {
      setValues(await containersHelmChartValues(chart.trim(), version.trim() || null));
    } catch (e) {
      setProblem(String(e));
    } finally {
      setLoadingValues(false);
    }
  };

  const releaseName = name.trim();
  const ns = namespace.trim();
  const valid = chart.trim() !== "" && !chart.trim().startsWith("-") && validReleaseName(releaseName) && validNamespace(ns);
  const install = async () => {
    if (!valid || installing) return;
    setInstalling(true);
    setProblem(null);
    try {
      await containersHelmInstall({ context, namespace: ns, name: releaseName, chart: chart.trim(), version: version.trim() || null, values });
      pushSuccessToast(t("containers.helm.installed", { name: releaseName }));
      onInstalled({ namespace: ns, name: releaseName });
    } catch (e) {
      setProblem(String(e));
    } finally {
      setInstalling(false);
    }
  };

  const suggestions = KNOWN_REPOS.filter((k) => !(repos ?? []).some((r) => r.name === k.name || r.url === k.url));
  const sm = (extra = "") => fieldClass({ size: "sm", className: `w-full ${extra}` });
  return (
    <Dialog
      title={t("containers.helm.installTitle", { context: context ?? "" })}
      onClose={onClose}
      width={680}
      footer={
        <>
          <Button size="md" variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" onClick={() => void install()} disabled={!valid || installing}>
            {installing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {installing ? t("containers.helm.installing") : t("containers.helm.install")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormSection
          title={t("containers.helm.repos")}
          trailing={
            <Button size="sm" variant="ghost" onClick={() => void repoWork("update", containersHelmRepoUpdate)} disabled={!!repoBusy || !repos?.length}>
              {repoBusy === "update" ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {t("containers.helm.repoUpdate")}
            </Button>
          }
        >
          {repos === null ? (
            <LoadingLine />
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {repos.length === 0 && <span className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.helm.noRepos")}</span>}
              {repos.map((repo) => (
                <span key={repo.name} className={chipClass("neutral", "gap-1")} title={repo.url}>
                  {repo.name}
                  <button type="button" onClick={() => void removeRepo(repo)} aria-label={t("containers.remove")} className="text-[var(--cf-text-faint)] hover:text-[var(--cf-danger)]">
                    {repoBusy === `remove:${repo.name}` ? <Loader2 size={10} className="animate-spin" /> : <X size={10} />}
                  </button>
                </span>
              ))}
              {suggestions.map((repo) => (
                <button key={repo.name} type="button" onClick={() => addRepo(repo)} title={repo.url} disabled={!!repoBusy} className={chipClass("accent", "cursor-pointer gap-1")}>
                  {repoBusy === `add:${repo.name}` ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                  {repo.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <Field label={t("containers.helm.repoName")} className="w-[150px]">
              <input value={repoName} onChange={(e) => setRepoName(e.target.value.trim())} placeholder="bitnami" spellCheck={false} className={sm("font-mono")} />
            </Field>
            <Field label={t("containers.helm.repoUrl")} className="min-w-0 flex-1">
              <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value.trim())} placeholder="https://charts.bitnami.com/bitnami" spellCheck={false} className={sm("font-mono")} />
            </Field>
            <Button size="md" onClick={() => addRepo({ name: repoName, url: repoUrl })} disabled={!validRepoName(repoName) || !validRepoUrl(repoUrl) || !!repoBusy}>
              <Plus size={12} />
              {t("containers.helm.repoAdd")}
            </Button>
          </div>
        </FormSection>
        <FormSection title={t("containers.helm.chart")}>
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <input
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void search();
                  }
                }}
                placeholder={t("containers.helm.searchCharts")}
                spellCheck={false}
                className={sm()}
              />
            </div>
            <Button size="md" onClick={() => void search()} disabled={searching}>
              {searching ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
              {t("containers.kube.add.search")}
            </Button>
          </div>
          {results && (
            <div className="flex max-h-[170px] flex-col gap-px overflow-y-auto rounded-md border border-[var(--cf-border)] p-1">
              {results.length === 0 ? (
                <p className="px-2 py-1.5 text-[12px] text-[var(--cf-text-muted)]">{t("containers.helm.noCharts")}</p>
              ) : (
                results.map((c) => (
                  <button key={c.name} type="button" onClick={() => pick(c)} aria-pressed={c.name === chart} className={rowClass(c.name === chart, "h-8 shrink-0")} title={c.description}>
                    <span className="shrink-0 font-mono text-[12px] font-medium">{c.name}</span>
                    <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--cf-text-faint)]">{c.description}</span>
                    <span className={chipClass("neutral")}>{c.version}</span>
                  </button>
                ))
              )}
            </div>
          )}
          <div className="grid grid-cols-[1fr_140px] gap-3">
            <Field label={t("containers.helm.chartRef")} hint={t("containers.helm.chartRefHint")}>
              <input value={chart} onChange={(e) => setChart(e.target.value.trim())} placeholder="bitnami/nginx" spellCheck={false} className={sm("font-mono")} />
            </Field>
            <Field label={t("containers.helm.version")}>
              <input value={version} onChange={(e) => setVersion(e.target.value.trim())} list="cf-helm-versions" placeholder={t("containers.helm.latest")} spellCheck={false} className={sm("font-mono")} />
              <datalist id="cf-helm-versions">
                {versions.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            </Field>
          </div>
        </FormSection>
        <FormSection
          title={t("containers.helm.release")}
          trailing={
            <Button size="sm" variant="ghost" onClick={() => void loadDefaults()} disabled={!chart.trim() || loadingValues}>
              {loadingValues ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {t("containers.helm.loadDefaults")}
            </Button>
          }
        >
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("containers.m.col.name")} hint={releaseName && !validReleaseName(releaseName) ? <span className="text-[var(--cf-danger)]">{t("containers.helm.badName")}</span> : undefined}>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value.trim());
                  setNameTouched(true);
                }}
                spellCheck={false}
                className={sm("font-mono")}
              />
            </Field>
            <Field label={t("containers.namespace")} hint={ns && !validNamespace(ns) ? <span className="text-[var(--cf-danger)]">{t("containers.helm.badNamespace")}</span> : t("containers.helm.namespaceHint")}>
              <input value={namespace} onChange={(e) => setNamespace(e.target.value.trim())} spellCheck={false} className={sm("font-mono")} />
            </Field>
          </div>
          <div className="flex h-[220px] flex-col overflow-hidden rounded-md border border-[var(--cf-border)]">
            <TextView value={values} language="yaml" editable onChange={setValues} />
          </div>
          <p className="text-[11px] text-[var(--cf-text-faint)]">{t("containers.helm.installValuesHint")}</p>
        </FormSection>
        {problem && <p className="whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-[var(--cf-danger)]">{problem}</p>}
      </div>
    </Dialog>
  );
}
