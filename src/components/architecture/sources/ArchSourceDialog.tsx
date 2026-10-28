/**
 * «Generar desde fuentes»: what an architecture is built from — repositories of the workspace,
 * documents, a brief (ArchFlow's intake questions) and a cloud account — and the model run that
 * builds it: a new document, or proposed changes to the open one.
 *
 * Repositories and documents are read in Rust, redacted, and a repository is previewed first (what
 * its compose files, manifests, Terraform, OpenAPI and ADRs say, with no model involved). A cloud
 * account is different in kind — it is read with the person's own CLI session — so every read is
 * a button the person presses after seeing the exact commands: accounts first, then the resources.
 * Nothing in the dialog runs a CLI on its own.
 */
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { ChevronDown, ClipboardList, Cloud, FileText, FolderGit2, Loader2, Plus, ShieldCheck, Sparkles, X } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { splitAnswer } from "../../../lib/architecture/aiBlocks";
import { PATTERNS } from "../../../lib/architecture/patterns";
import { BRIEF_KEYS, briefFilled, briefText, stampSources } from "../../../lib/architecture/sources";
import type { Brief, SourceRef } from "../../../lib/architecture/types";
import type { TranslationKey } from "../../../lib/i18n/translations";
import {
  architectureCloudContexts,
  architectureCloudPlan,
  architectureCloudRead,
  architectureCloudScopes,
  architectureGenerate,
  architectureScanRepo,
  type ArchSource,
  type CloudContexts,
  type CloudProvider,
  type CloudScope,
  type CloudSnapshot,
  type RepoScan,
} from "../../../lib/tauri/architectureCommands";
import { useArchitectureStore } from "../../../state/architectureStore";
import { useArchitectureViewStore } from "../../../state/architectureViewStore";
import { isCancellation, newRunId, useAiRunStore } from "../../../state/aiRunStore";
import { useLanguageStore, useT } from "../../../state/languageStore";
import { pushErrorToast } from "../../../state/toastStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { ChatModelPicker } from "../../ai/ChatModelPicker";
import { ApiModal, GhostButton } from "../../api/ApiModal";
import { AiSparkles } from "../../common/AiGlyph";
import { buttonClass, iconButtonClass } from "../../common/Button";
import { Segmented } from "../../common/Segmented";
import { ThinkingOrb } from "../../common/ThinkingOrb";
import { chipClass, fieldClass } from "../../common/recipes";
import { mutate, currentDoc } from "../edits";
import { useArchAskStore } from "../ai/archAi";
import { ConnectionsPreview } from "./ConnectionsPreview";

type Mode = "new" | "update";
type SectionKey = "repos" | "documents" | "brief" | "cloud";

export const useArchSourceDialog = create<{ mode: Mode | null; openAs: (mode: Mode) => void; close: () => void }>((set) => ({
  mode: null,
  openAs: (mode) => set({ mode }),
  close: () => set({ mode: null }),
}));

const DOC_EXTENSIONS = ["pdf", "docx", "doc", "pptx", "xlsx", "odt", "rtf", "epub", "md", "markdown", "txt"];
const PROVIDER_LABEL: Record<CloudProvider, string> = { azure: "Azure", aws: "AWS", gcp: "Google Cloud" };
/** The first read, shown before it runs — the same lines `architecture_cloud_contexts` runs. */
const CONTEXT_COMMAND: Record<CloudProvider, string> = {
  azure: "az account list -o json",
  aws: "aws configure list-profiles",
  gcp: "gcloud projects list --format=json",
};
const ATTRIBUTES = [...new Set(PATTERNS.flatMap((p) => [...p.improves, ...p.costs]))];

const today = () => new Date().toISOString().slice(0, 10);
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

interface CloudState {
  provider: CloudProvider;
  contexts: CloudContexts | null;
  context: string;
  scopes: CloudScope[] | null;
  scope: string;
  plan: string[] | null;
  snapshot: CloudSnapshot | null;
  busy: "contexts" | "scopes" | "read" | null;
}

export function ArchSourceDialog() {
  const mode = useArchSourceDialog((s) => s.mode);
  return mode ? <Dialog mode={mode} /> : null;
}

function Dialog({ mode }: { mode: Mode }) {
  const t = useT();
  const close = useArchSourceDialog((s) => s.close);
  const workspaceId = useArchitectureStore((s) => s.workspaceId);
  const draftId = useArchitectureStore((s) => s.draft?.id ?? null);
  const title = useArchitectureStore((s) => s.items.find((i) => i.id === s.draft?.id)?.title ?? "");
  const projects = useWorkspaceStore((s) => (workspaceId ? s.projectsByWorkspace[workspaceId] : undefined)) ?? [];
  const existing = useMemo(() => (mode === "update" ? currentDoc() : null), [mode]);

  const [repos, setRepos] = useState<string[]>(() => (existing?.sources ?? []).filter((s) => s.kind === "repo" && s.ref).map((s) => s.ref!));
  const [scans, setScans] = useState<Record<string, RepoScan | { error: string } | "loading">>({});
  const [documents, setDocuments] = useState<string[]>(() => (existing?.sources ?? []).filter((s) => s.kind === "document" && s.ref).map((s) => s.ref!));
  const [brief, setBrief] = useState<Brief>(() => existing?.brief ?? {});
  const [cloud, setCloud] = useState<CloudState>({ provider: "azure", contexts: null, context: "", scopes: null, scope: "", plan: null, snapshot: null, busy: null });
  const [focus, setFocus] = useState("");
  // Repositories and documents open; the brief and the cloud — long, and optional — open when asked
  // for (or already filled).
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>(() => ({ repos: true, documents: true, brief: briefFilled(existing?.brief), cloud: false }));
  const [running, setRunning] = useState<string | null>(null);
  const [failure, setFailure] = useState("");
  const lastCloud = (existing?.sources ?? []).filter((s) => s.kind === "cloud");

  // Each chosen repository is previewed: what its files say, before any model reads it.
  useEffect(() => {
    for (const path of repos) {
      if (scans[path]) continue;
      setScans((cur) => ({ ...cur, [path]: "loading" }));
      void architectureScanRepo(path)
        .then((scan) => setScans((cur) => ({ ...cur, [path]: scan })))
        .catch((error) => setScans((cur) => ({ ...cur, [path]: { error: String(error) } })));
    }
  }, [repos, scans]);

  // The plan follows the chosen account and scope; it runs nothing, it only spells the commands out.
  useEffect(() => {
    if (!cloud.context) return;
    let live = true;
    void architectureCloudPlan(cloud.provider, cloud.context, cloud.scope || null).then((plan) => { if (live) setCloud((c) => ({ ...c, plan })); }).catch(() => {});
    return () => { live = false; };
  }, [cloud.provider, cloud.context, cloud.scope]);

  const cloudSource = cloud.snapshot ? `${PROVIDER_LABEL[cloud.provider]} · ${cloud.contexts?.contexts.find((c) => c.id === cloud.context)?.name ?? cloud.context}${cloud.scope ? ` / ${cloud.scope}` : ""}` : "";
  const sources: ArchSource[] = [
    ...repos.map((path) => ({ kind: "repo" as const, path })),
    ...documents.map((path) => ({ kind: "document" as const, path })),
    ...(briefFilled(brief) ? [{ kind: "text" as const, name: "Brief", text: briefText(brief) }] : []),
    ...(cloud.snapshot ? [{ kind: "cloud" as const, name: cloudSource, text: cloud.snapshot.text }] : []),
  ];
  const refs: SourceRef[] = [
    ...repos.map((path) => ({ kind: "repo" as const, name: projects.find((p) => p.local_path === path)?.name ?? baseName(path), ref: path, readAt: today() })),
    ...documents.map((path) => ({ kind: "document" as const, name: baseName(path), ref: path, readAt: today() })),
    ...(briefFilled(brief) ? [{ kind: "brief" as const, name: "Brief", readAt: today() }] : []),
    ...(cloud.snapshot ? [{ kind: "cloud" as const, name: cloudSource, ref: `${cloud.provider}:${cloud.context}${cloud.scope ? `/${cloud.scope}` : ""}`, readAt: today() }] : []),
  ];

  const toggleRepo = (path: string) => setRepos((cur) => (cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path]));
  const addDocuments = async () => {
    const picked = await openDialog({ multiple: true, filters: [{ name: t("arch.gen.documents"), extensions: DOC_EXTENSIONS }] });
    const list = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
    setDocuments((cur) => [...cur, ...list.filter((p) => !cur.includes(p))]);
  };

  // ---------- cloud, one authorized read at a time ----------

  const readContexts = async () => {
    setCloud((c) => ({ ...c, busy: "contexts", contexts: null, context: "", scopes: null, scope: "", plan: null, snapshot: null }));
    try {
      const contexts = await architectureCloudContexts(cloud.provider);
      const chosen = contexts.contexts.find((c) => c.default)?.id ?? contexts.contexts[0]?.id ?? "";
      setCloud((c) => ({ ...c, contexts, context: chosen, busy: null }));
      if (chosen && cloud.provider === "aws") void architectureCloudScopes("aws", chosen).then((scopes) => setCloud((c) => ({ ...c, scopes, scope: scopes[0]?.id ?? "" })));
    } catch (error) {
      setCloud((c) => ({ ...c, busy: null, contexts: { found: true, contexts: [], error: String(error) } }));
    }
  };
  const readScopes = async () => {
    setCloud((c) => ({ ...c, busy: "scopes" }));
    try {
      const scopes = await architectureCloudScopes(cloud.provider, cloud.context);
      setCloud((c) => ({ ...c, scopes, busy: null }));
    } catch (error) {
      setCloud((c) => ({ ...c, busy: null }));
      pushErrorToast(String(error));
    }
  };
  const readCloud = async () => {
    setCloud((c) => ({ ...c, busy: "read", snapshot: null }));
    try {
      const snapshot = await architectureCloudRead(cloud.provider, cloud.context, cloud.scope || null);
      setCloud((c) => ({ ...c, snapshot, busy: null }));
    } catch (error) {
      setCloud((c) => ({ ...c, busy: null }));
      pushErrorToast(String(error));
    }
  };
  const setProvider = (provider: CloudProvider) => setCloud({ provider, contexts: null, context: "", scopes: null, scope: "", plan: null, snapshot: null, busy: null });

  // ---------- the run ----------

  const generate = async () => {
    if (!sources.length || running) return;
    setFailure("");
    const runId = newRunId("arch");
    setRunning(runId);
    useAiRunStore.getState().start(runId, { kindKey: "arch.gen.runKind", detail: mode === "update" ? title : refs.map((r) => r.name).join(", "), workspaceId, target: { view: "architecture" } });
    try {
      const raw = await architectureGenerate({
        workspaceId,
        sources,
        focus: focus.trim(),
        document: mode === "update" ? useArchitectureStore.getState().draft?.text ?? null : null,
        language: useLanguageStore.getState().language,
        runId,
      });
      const { text, changes, doc } = splitAnswer(raw);
      if (mode === "new") {
        if (!doc) { setFailure(text || t("arch.gen.noDocument")); return; }
        await useArchitectureStore.getState().createFrom(stampSources(doc, refs, brief), doc.meta?.title);
        useArchitectureViewStore.getState().setLens("review");
        close();
        return;
      }
      if (!draftId) return;
      mutate((d) => stampSources(d, refs, brief));
      useArchAskStore.getState().push(draftId, { role: "user", text: t("arch.gen.updateAsked", { sources: refs.map((r) => r.name).join(", ") }), action: "design" });
      useArchAskStore.getState().push(draftId, { role: "assistant", text, action: "design", changes, doc: changes.length ? null : doc });
      useArchitectureViewStore.getState().setLens("ask");
      close();
    } catch (error) {
      if (!isCancellation(error)) setFailure(String(error));
    } finally {
      useAiRunStore.getState().finish(runId);
      setRunning(null);
    }
  };

  const stop = () => { if (running) void useAiRunStore.getState().cancel(running); };

  // ---------- view ----------

  const toggleSection = (key: SectionKey) => setOpenSections((cur) => ({ ...cur, [key]: !cur[key] }));
  const section = (key: SectionKey, icon: React.ReactNode, heading: string, hint: string, body: React.ReactNode, count?: number) => {
    const isOpen = openSections[key];
    return (
      <section className="overflow-hidden rounded-xl border border-[var(--cf-border)] bg-[var(--cf-surface)]">
        <button type="button" aria-expanded={isOpen} onClick={() => toggleSection(key)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-[var(--cf-hover)]">
          <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--cf-sunken)] text-[var(--cf-text-muted)]">{icon}</span>
          <span className="grid min-w-0 flex-1 gap-0.5">
            <span className="flex items-center gap-2 text-[13px] font-semibold text-[var(--cf-text)]">
              {heading}
              {count ? <span className={chipClass("accent")}>{count}</span> : null}
            </span>
            <span className="text-[11.5px] leading-[1.45] text-[var(--cf-text-muted)]">{hint}</span>
          </span>
          <ChevronDown size={15} className={`mt-1.5 shrink-0 text-[var(--cf-text-faint)] transition-transform ${isOpen ? "rotate-180" : ""}`} />
        </button>
        {isOpen ? <div className="border-t border-[var(--cf-border)] px-4 pb-4 pt-3.5">{body}</div> : null}
      </section>
    );
  };

  const repoBody = (
    <div className="grid gap-2">
      {projects.length ? projects.map((p) => {
        const on = repos.includes(p.local_path);
        const scan = scans[p.local_path];
        return (
          <label
            key={p.id}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${on ? "border-[var(--cf-accent)] bg-[color-mix(in_oklab,var(--cf-accent)_5%,var(--cf-surface))]" : "border-[var(--cf-border)] hover:bg-[var(--cf-hover)]"}`}
          >
            <input type="checkbox" checked={on} onChange={() => toggleRepo(p.local_path)} className="mt-[3px] accent-[var(--cf-accent)]" />
            <span className="grid min-w-0 flex-1 gap-1.5">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="shrink-0 text-[12.5px] font-medium text-[var(--cf-text)]">{p.name}</span>
                <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--cf-text-faint)]">{p.local_path}</span>
              </span>
              {on && scan ? (
                <span className="flex flex-wrap gap-1 text-[11px]">
                  {scan === "loading" ? <span className="text-[var(--cf-text-faint)]">{t("arch.gen.scanning")}</span>
                    : "error" in scan ? <span className="text-[var(--cf-danger)]">{scan.error}</span>
                    : Object.keys(scan.counts).length ? Object.entries(scan.counts).map(([kind, n]) => <span key={kind} className={chipClass("neutral")}>{t(`arch.gen.fact.${kind}` as TranslationKey, { n: n ?? 0 })}</span>)
                    : <span className="text-[var(--cf-text-faint)]">{t("arch.gen.scanEmpty")}</span>}
                </span>
              ) : null}
            </span>
          </label>
        );
      }) : <p className="m-0 text-[12px] text-[var(--cf-text-faint)]">{t("arch.gen.noRepos")}</p>}
      {repos.filter((r) => !projects.some((p) => p.local_path === r)).map((path) => (
        <div key={path} className="flex items-center gap-2 rounded-lg border border-[var(--cf-border)] px-3 py-2 text-[12px]">
          <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{path}</span>
          <button type="button" className={iconButtonClass({ size: "xs" })} onClick={() => toggleRepo(path)} aria-label={t("arch.gen.remove")}><X size={12} /></button>
        </div>
      ))}
      {repos.length >= 2 && <ConnectionsPreview repos={repos} />}
    </div>
  );

  const documentBody = (
    <div className="grid gap-2">
      {documents.map((path) => (
        <div key={path} className="flex items-center gap-2.5 rounded-lg border border-[var(--cf-border)] px-3 py-2 text-[12px]">
          <FileText size={14} className="shrink-0 text-[var(--cf-text-muted)]" />
          <span className="min-w-0 flex-1 truncate">{baseName(path)}</span>
          <button type="button" className={iconButtonClass({ size: "xs" })} onClick={() => setDocuments((cur) => cur.filter((p) => p !== path))} aria-label={t("arch.gen.remove")}><X size={12} /></button>
        </div>
      ))}
      <button type="button" className={buttonClass({ size: "sm", className: "justify-self-start" })} onClick={() => void addDocuments()}><Plus size={13} />{t("arch.gen.addDocuments")}</button>
    </div>
  );

  const field = (key: (typeof BRIEF_KEYS)[number]) => (
    <label key={key} className="grid content-start gap-1.5 text-[11.5px] font-medium text-[var(--cf-text-muted)]">
      {t(`arch.gen.brief.${key}` as TranslationKey)}
      <textarea
        rows={2}
        value={brief[key] ?? ""}
        onChange={(e) => setBrief((b) => ({ ...b, [key]: e.target.value }))}
        placeholder={t(`arch.gen.brief.${key}Hint` as TranslationKey)}
        className={fieldClass({ size: "sm", className: "w-full resize-y py-1.5 font-normal leading-[1.45]" })}
      />
    </label>
  );
  const weightOf = (a: string) => brief.drivers?.find((d) => d.attribute === a)?.weight ?? 0;
  const setWeight = (a: string, w: number) => setBrief((b) => {
    const rest = (b.drivers ?? []).filter((d) => d.attribute !== a);
    return { ...b, drivers: w ? [...rest, { attribute: a, weight: w }] : rest };
  });
  const briefBody = (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">{BRIEF_KEYS.map(field)}</div>
      <div className="grid gap-2">
        <span className="text-[11.5px] font-medium text-[var(--cf-text-muted)]">{t("arch.gen.brief.drivers")}</span>
        <div className="flex flex-wrap gap-1.5">
          {ATTRIBUTES.map((a) => {
            const w = weightOf(a);
            return (
              <button key={a} type="button" onClick={() => setWeight(a, w >= 5 ? 0 : w + 1)} title={t("arch.gen.brief.driverHint")} className={`rounded-full border px-2.5 text-[11.5px] leading-[24px] ${w ? "border-transparent bg-[var(--cf-accent-soft)] font-semibold text-[var(--cf-accent)]" : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)]"}`}>
                {t(`arch.qa.${a}` as TranslationKey)}{w ? ` · ${w}` : ""}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );

  const ctxList = cloud.contexts?.contexts ?? [];
  const cloudBody = (
    <div className="grid gap-3">
      <div className="justify-self-start">
        <Segmented layoutId="arch-cloud-provider" size="sm" value={cloud.provider} onChange={setProvider} options={(["azure", "aws", "gcp"] as const).map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))} ariaLabel={t("arch.gen.cloud")} />
      </div>
      {lastCloud.length ? <p className="m-0 text-[11px] text-[var(--cf-text-faint)]">{t("arch.gen.cloudLast", { name: lastCloud[lastCloud.length - 1].name, date: lastCloud[lastCloud.length - 1].readAt ?? "" })}</p> : null}
      <Authorize
        command={CONTEXT_COMMAND[cloud.provider]}
        label={t("arch.gen.cloudReadAccounts")}
        busy={cloud.busy === "contexts"}
        onAuthorize={() => void readContexts()}
      />
      {cloud.contexts && !cloud.contexts.found ? <p className="m-0 text-[12px] text-[var(--cf-danger)]">{t("arch.gen.cloudMissing", { cli: CONTEXT_COMMAND[cloud.provider].split(" ")[0] })}</p> : null}
      {cloud.contexts?.error ? <p className="m-0 text-[12px] text-[var(--cf-danger)]">{cloud.contexts.error}</p> : null}
      {ctxList.length ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <label className="grid content-start gap-1.5 text-[11.5px] font-medium text-[var(--cf-text-muted)]">
            {t(`arch.gen.cloudContext.${cloud.provider}` as TranslationKey)}
            <select value={cloud.context} onChange={(e) => { const context = e.target.value; setCloud((c) => ({ ...c, context, scopes: c.provider === "aws" ? c.scopes : null, scope: c.provider === "aws" ? c.scope : "", snapshot: null })); }} className={fieldClass({ size: "sm", className: "w-full" })}>
              {ctxList.map((c) => <option key={c.id} value={c.id}>{c.name}{c.detail ? ` — ${c.detail}` : ""}</option>)}
            </select>
          </label>
          {cloud.provider !== "gcp" ? (
            <label className="grid content-start gap-1.5 text-[11.5px] font-medium text-[var(--cf-text-muted)]">
              {t(`arch.gen.cloudScope.${cloud.provider}` as TranslationKey)}
              {cloud.scopes ? (
                <select value={cloud.scope} onChange={(e) => setCloud((c) => ({ ...c, scope: e.target.value, snapshot: null }))} className={fieldClass({ size: "sm", className: "w-full" })}>
                  {cloud.provider === "azure" ? <option value="">{t("arch.gen.cloudAllGroups")}</option> : null}
                  {cloud.scopes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              ) : (
                <button type="button" disabled={cloud.busy === "scopes"} className={buttonClass({ size: "sm", className: "justify-self-start" })} onClick={() => void readScopes()}>
                  {cloud.busy === "scopes" ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}{t("arch.gen.cloudReadGroups")}
                </button>
              )}
            </label>
          ) : null}
        </div>
      ) : null}
      {cloud.context && cloud.plan ? (
        <Authorize
          command={cloud.plan.join("\n")}
          label={t("arch.gen.cloudReadResources", { n: cloud.plan.length })}
          busy={cloud.busy === "read"}
          onAuthorize={() => void readCloud()}
        />
      ) : null}
      {cloud.snapshot ? (
        <div className="grid gap-1 rounded-lg bg-[var(--cf-sunken)] px-3 py-2.5 text-[12px]">
          <span className="font-semibold text-[var(--cf-success)]">{t("arch.gen.cloudRead", { n: cloud.snapshot.resources.length, source: cloudSource })}</span>
          {cloud.snapshot.commands.filter((c) => !c.ok).map((c) => <span key={c.command} className="truncate font-mono text-[10.5px] text-[var(--cf-warning)]" title={c.error ?? ""}>✕ {c.command}{c.error ? ` — ${c.error}` : ""}</span>)}
        </div>
      ) : null}
    </div>
  );

  return (
    <ApiModal
      icon={Sparkles}
      title={mode === "new" ? t("arch.gen.titleNew") : t("arch.gen.titleUpdate")}
      subtitle={mode === "new" ? t("arch.gen.subtitleNew") : t("arch.gen.subtitleUpdate", { title })}
      width="max-w-3xl"
      height="h-[80vh]"
      busy={!!running}
      onClose={() => { if (!running) close(); }}
      footer={
        <div className="flex w-full flex-wrap items-center gap-2">
          {failure ? <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--cf-danger)]" title={failure}>{failure}</span> : <span className="flex-1 text-[11.5px] text-[var(--cf-text-faint)]">{sources.length ? t("arch.gen.summary", { n: sources.length }) : t("arch.gen.pickOne")}</span>}
          {running ? (
            <>
              <span className="flex items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]"><ThinkingOrb size="sm" />{t("arch.gen.running")}</span>
              <GhostButton onClick={stop}>{t("arch.ai.stop")}</GhostButton>
            </>
          ) : (
            <>
              <GhostButton onClick={close}>{t("arch.gen.cancel")}</GhostButton>
              <ChatModelPicker
                task="architecture"
                variant="button"
                liveModel={null}
                chatActive={false}
                action={{ icon: <AiSparkles size={13} />, label: mode === "new" ? t("arch.gen.generate") : t("arch.gen.propose"), onClick: () => void generate(), disabled: !sources.length }}
              />
            </>
          )}
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto" data-tour="arch-sources">
        <div className="grid gap-3 px-5 py-4">
          {section("repos", <FolderGit2 size={16} />, t("arch.gen.repos"), t("arch.gen.reposHint"), repoBody, repos.length)}
          {section("documents", <FileText size={16} />, t("arch.gen.documents"), t("arch.gen.documentsHint"), documentBody, documents.length)}
          {section("brief", <ClipboardList size={16} />, t("arch.gen.brief"), t("arch.gen.briefHint"), briefBody, briefFilled(brief) ? 1 : 0)}
          {section("cloud", <Cloud size={16} />, t("arch.gen.cloud"), t("arch.gen.cloudHint"), cloudBody, cloud.snapshot ? 1 : 0)}
          <label className="grid gap-1.5 px-1 pt-1 text-[11.5px] font-medium text-[var(--cf-text-muted)]">
            {t("arch.gen.focus")}
            <textarea rows={2} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder={t("arch.gen.focusHint")} className={fieldClass({ size: "sm", className: "w-full resize-y py-1.5 font-normal leading-[1.45]" })} data-ai-input />
          </label>
        </div>
      </div>
    </ApiModal>
  );
}

/** One cloud read: the exact commands, and the button that authorizes running them now. */
function Authorize({ command, label, busy, onAuthorize }: { command: string; label: string; busy: boolean; onAuthorize: () => void }) {
  const t = useT();
  return (
    <div className="grid gap-2.5 rounded-lg border border-dashed border-[var(--cf-border-strong)] p-3">
      <pre className="m-0 max-h-[120px] overflow-auto whitespace-pre-wrap rounded-md bg-[var(--cf-sunken)] px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-[var(--cf-text-muted)]">{command}</pre>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} className={buttonClass({ size: "sm" })} onClick={onAuthorize}>
          {busy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}{label}
        </button>
        <span className="text-[10.5px] leading-[1.35] text-[var(--cf-text-faint)]">{t("arch.gen.cloudAuthNote")}</span>
      </div>
    </div>
  );
}
