import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, TerminalSquare, TriangleAlert } from "lucide-react";
import { Button } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { fieldClass } from "../common/recipes";
import { Dialog, Field, FormSection, LoadingLine } from "./ui";
import { composeProjectPreview, configFor, DEVCONTAINER_CLI_INSTALL, featuresBlock, initialProposal, plausibleBranch } from "./envsModel";
import { writeClipboardText } from "../../lib/clipboard";
import { pushSuccessToast } from "../../state/toastStore";
import { containersEnvsClone, containersEnvsCreate, containersEnvsDiscover, containersEnvsRepos } from "../../lib/tauri/containersEnvsCommands";
import { listBranches } from "../../lib/tauri/commands";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { BranchInfo } from "../../types/domain";
import type { EnvDiscovery, EnvProposal, EnvRepo, EnvView } from "../../types/containersEnvs";
import type { RuntimeInfo } from "../../types/containers";

/**
 * A new environment: a repository CodeFlow knows, a branch (one that exists, or a new one from a
 * base), how to run it (what the repository's files propose — its devcontainer, its Compose stacks),
 * and the port offset, suggested past the other environments and off every port in use. Cloning
 * opens the same dialog on another environment's repository and configuration: only the branch and
 * the offset are left to choose.
 *
 * For a devcontainer the dialog says, before anything exists, what of its file this way of running
 * applies and what it leaves out, the `initializeCommand` that will run on this computer (approved
 * by creating), and — for a direct run of a file with `features` — that only the Dev Containers CLI
 * installs them: the install command to copy, or an explicit "run without features".
 */

const REASON: Record<string, TranslationKey> = {
  noCli: "containers.envs.create.reason.noCli",
  unknownSource: "containers.envs.create.reason.unknownSource",
  invalid: "containers.envs.create.reason.invalid",
};

const KIND: Record<EnvProposal["kind"], TranslationKey> = {
  compose: "containers.envs.kind.compose",
  devcontainer: "containers.envs.kind.devcontainer",
  devcontainerCli: "containers.envs.kind.devcontainerCli",
};

/** `origin/feature/x` → `feature/x`: a remote's branch is checked out under its own name, tracked. */
function branchName(branch: BranchInfo): string {
  if (!branch.is_remote) return branch.name;
  const slash = branch.name.indexOf("/");
  return slash >= 0 ? branch.name.slice(slash + 1) : branch.name;
}

export function EnvCreateDialog({
  runtime,
  context,
  cloneFrom,
  onClose,
  onCreated,
}: {
  runtime: RuntimeInfo;
  context: string | null;
  cloneFrom: EnvView | null;
  onClose: () => void;
  onCreated: (env: EnvView, startNow: boolean) => void;
}) {
  const t = useT();
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);
  const [repos, setRepos] = useState<EnvRepo[] | null>(null);
  const [repoId, setRepoId] = useState<string>(cloneFrom?.projectId ?? "");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [branch, setBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [base, setBase] = useState("");
  const [discovery, setDiscovery] = useState<EnvDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [proposalId, setProposalId] = useState<string>("");
  const [offset, setOffset] = useState<string>("");
  const [startNow, setStartNow] = useState(true);
  const [withoutFeatures, setWithoutFeatures] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void containersEnvsRepos()
      .then((list) => {
        setRepos(list);
        setRepoId((current) => current || (list.find((r) => r.id === activeProjectId) ?? list[0])?.id || "");
      })
      .catch((e) => setError(String(e)));
  }, [activeProjectId]);

  const repo = repos?.find((r) => r.id === repoId) ?? null;

  useEffect(() => {
    if (!repo) return;
    let live = true;
    setBranches([]);
    setBranch("");
    setDiscovery(null);
    setDiscovering(true);
    void listBranches(repo.path)
      .then((list) => {
        if (!live) return;
        setBranches(list);
        const head = list.find((b) => b.is_head && !b.is_remote) ?? list.find((b) => !b.is_remote);
        setBase(head?.name ?? "");
        if (!cloneFrom) setBranch(head?.name ?? "");
      })
      .catch(() => live && setBranches([]));
    void containersEnvsDiscover(repo.id)
      .then((found) => {
        if (!live) return;
        setDiscovery(found);
        const first = cloneFrom ? found.proposals.find((p) => JSON.stringify(p.config) === JSON.stringify(cloneFrom.config)) : initialProposal(found.proposals);
        setProposalId(first?.id ?? "");
        const suggested = first?.suggestedOffset ?? found.proposals[0]?.suggestedOffset ?? (cloneFrom ? cloneFrom.portOffset + 100 : 100);
        setOffset(String(suggested));
      })
      .catch((e) => live && setError(String(e)))
      .finally(() => live && setDiscovering(false));
    return () => {
      live = false;
    };
  }, [repo, cloneFrom]);

  const proposal = discovery?.proposals.find((p) => p.id === proposalId) ?? null;
  const branchOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: { value: string; label: string }[] = [];
    for (const b of branches) {
      const name = branchName(b);
      if (b.name.endsWith("/HEAD") || seen.has(name)) continue;
      seen.add(name);
      out.push({ value: name, label: b.is_remote ? `${name}  (${b.name})` : name });
    }
    return out;
  }, [branches]);
  const baseOptions = useMemo(() => branches.filter((b) => !b.name.endsWith("/HEAD")).map((b) => ({ value: b.name, label: b.name })), [branches]);

  const chosenBranch = (mode === "new" ? newBranch : branch).trim();
  const offsetNumber = Number(offset);
  const offsetValid = offset.trim() !== "" && Number.isInteger(offsetNumber) && offsetNumber >= 0 && offsetNumber <= 60000;
  const branchValid = plausibleBranch(chosenBranch) && (mode === "existing" || !branchOptions.some((o) => o.value === chosenBranch));
  // A clone keeps its source's configuration even if the main checkout no longer proposes it.
  const configReady = cloneFrom ? true : !!proposal?.available && !featuresBlock(proposal, withoutFeatures);
  const ready = !!repo && branchValid && offsetValid && configReady && !working;
  const previewPorts = (proposal?.ports ?? []).slice(0, 4);

  const submit = async () => {
    if (!repo || !ready) return;
    setWorking(true);
    setError(null);
    try {
      const baseRef = mode === "new" ? base || null : null;
      const env = cloneFrom
        ? await containersEnvsClone(cloneFrom.id, chosenBranch, baseRef, offsetNumber)
        : await containersEnvsCreate({ projectId: repo.id, branch: chosenBranch, base: baseRef, config: configFor(proposal!, withoutFeatures), offset: offsetNumber, runtime: runtime.id, context });
      onCreated(env, startNow);
    } catch (e) {
      setError(String(e));
      setWorking(false);
    }
  };

  return (
    <Dialog
      title={cloneFrom ? t("containers.envs.clone.title", { name: cloneFrom.composeProject }) : t("containers.envs.create.title")}
      onClose={onClose}
      width={640}
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <Checkbox checked={startNow} onChange={setStartNow} />
            {t("containers.envs.create.startNow")}
          </label>
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void submit()} disabled={!ready}>
            {working && <Loader2 size={12} className="animate-spin" />}
            {cloneFrom ? t("containers.envs.clone.submit") : t("containers.envs.create.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormSection title={t("containers.envs.create.repoSection")}>
          {repos === null ? (
            <LoadingLine />
          ) : repos.length === 0 ? (
            <p className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.envs.create.noRepos")}</p>
          ) : (
            <Field label={t("containers.envs.create.repo")}>
              <Select
                value={repoId}
                onChange={setRepoId}
                disabled={!!cloneFrom}
                options={repos.map((r) => ({ value: r.id, label: `${r.name} · ${r.workspace}` }))}
                ariaLabel={t("containers.envs.create.repo")}
              />
            </Field>
          )}
          <div className="flex items-center gap-2">
            <Segmented
              layoutId="env-branch-mode"
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: "existing", label: t("containers.envs.create.existing") },
                { value: "new", label: t("containers.envs.create.newBranch") },
              ]}
            />
          </div>
          {mode === "existing" ? (
            <Field label={t("containers.envs.create.branch")} hint={t("containers.envs.create.branchHint")}>
              <Select value={branch} onChange={setBranch} options={branchOptions} placeholder={t("containers.envs.create.pickBranch")} ariaLabel={t("containers.envs.create.branch")} />
            </Field>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("containers.envs.create.branchName")} hint={chosenBranch && !branchValid ? t("containers.envs.create.branchInvalid") : undefined}>
                <input value={newBranch} onChange={(e) => setNewBranch(e.target.value)} placeholder="feature/payment" spellCheck={false} className={fieldClass({ size: "sm", className: "font-mono" })} />
              </Field>
              <Field label={t("containers.envs.create.base")}>
                <Select value={base} onChange={setBase} options={baseOptions} ariaLabel={t("containers.envs.create.base")} />
              </Field>
            </div>
          )}
          {repo && chosenBranch && (
            <p className="text-[11.5px] text-[var(--cf-text-muted)]">
              {t("containers.envs.create.projectPreview")} <span className="font-mono text-[var(--cf-text)]">{composeProjectPreview(repo.name, chosenBranch)}</span>
            </p>
          )}
        </FormSection>

        {!cloneFrom && (
          <FormSection title={t("containers.envs.create.configSection")}>
            {discovering ? (
              <LoadingLine>{t("containers.envs.create.discovering")}</LoadingLine>
            ) : !discovery || discovery.proposals.length === 0 ? (
              <p className="text-[12px] text-[var(--cf-text-muted)]">{t("containers.envs.create.noConfig")}</p>
            ) : (
              <div role="radiogroup" aria-label={t("containers.envs.create.configSection")} className="flex flex-col gap-1">
                {discovery.proposals.map((p) => {
                  const selected = p.id === proposalId;
                  return (
                    <button
                      key={p.id}
                      role="radio"
                      aria-checked={selected}
                      disabled={!p.available}
                      onClick={() => {
                        setProposalId(p.id);
                        setOffset(String(p.suggestedOffset));
                        setWithoutFeatures(false);
                      }}
                      className={`flex flex-col gap-0.5 rounded-md border px-2.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-60 ${selected ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]" : "border-[var(--cf-border)] hover:bg-[var(--cf-hover)]"}`}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 rounded-[4px] border border-[var(--cf-border)] px-1 text-[10.5px] text-[var(--cf-text-muted)]">{t(KIND[p.kind])}</span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">{p.label}</span>
                        {p.recommended && p.available && <span className="shrink-0 text-[10.5px] text-[var(--cf-accent)]">{t("containers.envs.create.recommended")}</span>}
                      </span>
                      {p.detail && <span className="truncate text-[11px] text-[var(--cf-text-muted)]">{p.detail}</span>}
                      {p.reason && <span className="text-[11px] text-[var(--cf-text-faint)]">{t(REASON[p.reason] ?? "containers.envs.create.reason.invalid")}{p.problem ? ` — ${p.problem}` : ""}</span>}
                      {p.unsupported.length > 0 && (
                        <span className="flex items-center gap-1 text-[11px] text-[var(--cf-warning)]">
                          <TriangleAlert size={10} />
                          {t(p.kind === "devcontainerCli" ? "containers.envs.create.ignoredCli" : "containers.envs.create.unsupported", { keys: p.unsupported.join(", ") })}
                        </span>
                      )}
                      {!p.offsetApplies && p.available && <span className="text-[11px] text-[var(--cf-text-faint)]">{t("containers.envs.warn.cliNoOffset")}</span>}
                    </button>
                  );
                })}
              </div>
            )}
            {proposal && proposal.kind !== "compose" && (
              <DevcontainerDetails proposal={proposal} cliInstalled={!!discovery?.devcontainerCli} withoutFeatures={withoutFeatures} onWithoutFeatures={setWithoutFeatures} />
            )}
          </FormSection>
        )}

        <FormSection title={t("containers.envs.create.portsSection")}>
          <div className="grid grid-cols-[140px_1fr] items-start gap-3">
            <Field label={t("containers.envs.create.offset")}>
              <input value={offset} onChange={(e) => setOffset(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric" className={fieldClass({ size: "sm", className: "font-mono" })} />
            </Field>
            <p className="pt-5 text-[11.5px] leading-snug text-[var(--cf-text-muted)]">
              {previewPorts.length > 0 && offsetValid
                ? t("containers.envs.create.offsetPreview", { ports: previewPorts.map((p) => `${p} → ${p + offsetNumber}`).join(", ") })
                : t("containers.envs.create.offsetHint")}
            </p>
          </div>
        </FormSection>
        <p className="text-[11px] leading-snug text-[var(--cf-text-faint)]">{t("containers.envs.create.footnote")}</p>
        {error && <p className="whitespace-pre-wrap text-[12px] text-[var(--cf-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}

/** What of a devcontainer.json the chosen way of running applies, what runs on this computer, and
 *  what features need — said before the environment exists. */
function DevcontainerDetails({
  proposal,
  cliInstalled,
  withoutFeatures,
  onWithoutFeatures,
}: {
  proposal: EnvProposal;
  cliInstalled: boolean;
  withoutFeatures: boolean;
  onWithoutFeatures: (value: boolean) => void;
}) {
  const t = useT();
  const direct = proposal.kind === "devcontainer";
  const needsCli = direct && proposal.features.length > 0;
  const copyInstall = () =>
    void writeClipboardText(DEVCONTAINER_CLI_INSTALL)
      .then(() => pushSuccessToast(t("containers.envs.create.copied")))
      .catch(() => undefined);
  return (
    <div className="mt-1 flex flex-col gap-2 rounded-md border border-[var(--cf-border)] p-2.5 text-[11.5px]">
      {proposal.honoured.length > 0 && (
        <p className="leading-snug text-[var(--cf-text-muted)]">
          <span className="text-[var(--cf-text)]">{t("containers.envs.create.honoured")}</span> <span className="font-mono">{proposal.honoured.join(", ")}</span>
        </p>
      )}
      {proposal.unsupported.length > 0 && (
        <p className="leading-snug text-[var(--cf-text-muted)]">
          <span className="text-[var(--cf-warning)]">{t("containers.envs.create.ignored")}</span> <span className="font-mono">{proposal.unsupported.join(", ")}</span>
        </p>
      )}
      {direct && proposal.honoured.includes("runArgs") && <p className="leading-snug text-[var(--cf-text-faint)]">{t("containers.envs.create.runArgsJudged")}</p>}
      {proposal.initialize.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5 text-[var(--cf-text)]">
            <TerminalSquare size={11} className="text-[var(--cf-warning)]" />
            {t("containers.envs.create.initialize")}
          </span>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-[5px] bg-[var(--cf-hover)] px-2 py-1 font-mono text-[11px] text-[var(--cf-text)]">{proposal.initialize.join("\n")}</pre>
          <span className="leading-snug text-[var(--cf-text-faint)]">{t("containers.envs.create.initializeHint")}</span>
        </div>
      )}
      {needsCli && (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--cf-warning)] p-2">
          <span className="flex items-start gap-1.5 text-[var(--cf-text)]">
            <TriangleAlert size={12} className="mt-[2px] shrink-0 text-[var(--cf-warning)]" />
            <span>{t("containers.envs.create.features", { features: proposal.features.join(", ") })}</span>
          </span>
          {cliInstalled ? (
            <span className="text-[var(--cf-text-muted)]">{t("containers.envs.create.featuresUseCli")}</span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5 text-[var(--cf-text-muted)]">
              {t("containers.envs.create.featuresInstall")}
              <code className="rounded-[4px] bg-[var(--cf-hover)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--cf-text)]">{DEVCONTAINER_CLI_INSTALL}</code>
              <Button size="sm" variant="ghost" onClick={copyInstall} aria-label={t("containers.envs.create.copyInstall")}>
                <Copy size={11} />
                {t("containers.envs.create.copyInstall")}
              </Button>
            </span>
          )}
          <label className="flex items-start gap-2 text-[var(--cf-text)]">
            <Checkbox checked={withoutFeatures} onChange={onWithoutFeatures} className="mt-[2px]" />
            <span>
              {t("containers.envs.create.withoutFeatures")}
              <span className="block text-[11px] text-[var(--cf-text-faint)]">{t("containers.envs.create.withoutFeaturesHint")}</span>
            </span>
          </label>
        </div>
      )}
    </div>
  );
}
