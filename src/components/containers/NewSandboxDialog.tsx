import { useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { Button } from "../common/Button";
import { Select } from "../common/Select";
import { Segmented } from "../common/Segmented";
import { fieldClass } from "../common/recipes";
import { Dialog, Field, FormSection, MutedNote } from "./ui";
import { runtimeLabel } from "./containerActions";
import { allowedNetworks, parsePortList } from "./sandboxModel";
import { containersPolicyGet, containersSandboxCancel, containersSandboxCreate, containersSandboxSources } from "../../lib/tauri/containersSandboxCommands";
import { useContainersStore } from "../../state/containersStore";
import { useT } from "../../state/languageStore";
import { pushSuccessToast } from "../../state/toastStore";
import type { RuntimeId } from "../../types/containers";
import type { Sandbox, SandboxNetwork, SandboxSources, StoredPolicy } from "../../types/containersSandbox";

/**
 * «Nuevo sandbox»: what an agent's isolated container works on (a new worktree of a repository, or
 * an agent task's own), where it runs, its image, network and limits. The hardening is not offered
 * as options — it is what a sandbox is — and the workspace's security policy is checked by the
 * broker before anything starts; a refusal comes back here with its reason.
 *
 * Opened from the Sandboxes page (an engine already chosen) and from a story's «Crear ambiente de
 * ingeniería» (`storyId`, its title and the story set's repository filled in).
 */
export function NewSandboxDialog({
  workspaceId,
  runtime: fixedRuntime,
  context: fixedContext,
  projectId: initialProject,
  storyId,
  title: initialTitle,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  runtime?: string;
  context?: string | null;
  projectId?: string | null;
  storyId?: string;
  title?: string;
  onClose: () => void;
  onCreated: (sandbox: Sandbox) => void;
}) {
  const t = useT();
  const runtimes = useContainersStore((s) => s.runtimes);
  const detected = useContainersStore((s) => s.detected);
  const engines = runtimes.filter((r) => r.running && (r.id === "docker" || r.id === "podman" || r.id === "nerdctl"));
  const [runtime, setRuntime] = useState(fixedRuntime ?? "");
  const chosenContext = useContainersStore((s) => (runtime ? s.contextOf(runtime as RuntimeId) : null));
  const context = fixedRuntime ? (fixedContext ?? null) : chosenContext;
  const [sources, setSources] = useState<SandboxSources | null>(null);
  const [stored, setStored] = useState<StoredPolicy | null>(null);
  const [from, setFrom] = useState<"project" | "task">("project");
  const [projectId, setProjectId] = useState(initialProject ?? "");
  const [taskId, setTaskId] = useState("");
  const [title, setTitle] = useState(initialTitle ?? "");
  const [branch, setBranch] = useState("");
  const [image, setImage] = useState("");
  const [network, setNetwork] = useState<SandboxNetwork>("none");
  const [memory, setMemory] = useState("2048");
  const [cpus, setCpus] = useState("2");
  const [pids, setPids] = useState("512");
  const [ports, setPorts] = useState("");
  const [creating, setCreating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!detected) void useContainersStore.getState().detect();
  }, [detected]);
  useEffect(() => {
    if (!runtime && engines[0]) setRuntime(engines[0].id);
  }, [runtime, engines]);
  useEffect(() => {
    let live = true;
    void Promise.all([containersSandboxSources(workspaceId), containersPolicyGet(workspaceId)])
      .then(([found, policy]) => {
        if (!live) return;
        setSources(found);
        setStored(policy);
        setProjectId((current) => current || found.projects[0]?.id || "");
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [workspaceId]);

  const networks = useMemo(() => allowedNetworks(stored?.policy ?? null), [stored]);
  useEffect(() => {
    if (!networks.includes(network)) setNetwork("none");
  }, [networks, network]);

  const task = sources?.tasks.find((x) => x.id === taskId);
  const number = (text: string) => {
    const value = Number(text.replace(",", "."));
    return text.trim() && Number.isFinite(value) ? value : undefined;
  };
  const portList = useMemo(() => parsePortList(ports), [ports]);
  const ready = !!runtime && !creating && (from === "project" ? !!projectId : !!taskId);

  const create = async () => {
    if (!ready) return;
    // Named here, so «Cancelar» can stop the creation while the broker is still pulling the image.
    const id = crypto.randomUUID().replace(/-/g, "");
    setCreating(id);
    setError(null);
    try {
      const sandbox = await containersSandboxCreate({
        id,
        runtime,
        context,
        workspaceId,
        projectId: from === "project" ? projectId : (task?.projectId ?? ""),
        taskId: from === "task" ? taskId : "",
        storyId: storyId ?? "",
        title: title.trim(),
        image: image.trim(),
        network,
        memoryMb: number(memory),
        cpus: number(cpus),
        pidsLimit: number(pids),
        ports: network === "internet" ? portList : [],
        branch: from === "project" ? branch.trim() : "",
      });
      pushSuccessToast(t("containers.sandbox.create.created", { name: sandbox.containerName }));
      onCreated(sandbox);
    } catch (e) {
      setError(String(e));
    } finally {
      setCreating(null);
    }
  };

  // Closing while it is being made cancels it: the broker removes what it had made so far.
  const close = () => {
    if (creating) void containersSandboxCancel(creating).catch(() => {});
    onClose();
  };

  const defaultImage = stored?.policy.sandboxImage || "mcr.microsoft.com/devcontainers/base:bookworm";
  return (
    <Dialog
      title={t("containers.sandbox.create.heading")}
      onClose={close}
      width={620}
      footer={
        <>
          <Button size="md" variant="ghost" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button size="md" variant="primary" onClick={() => void create()} disabled={!ready}>
            {creating && <Loader2 size={12} className="animate-spin" />}
            {creating ? t("containers.sandbox.create.creating") : t("containers.sandbox.create.submit")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!fixedRuntime && (
          <FormSection title={t("containers.sandbox.create.engine")}>
            {engines.length === 0 ? (
              <MutedNote>{t("containers.sandbox.create.noEngine")}</MutedNote>
            ) : (
              <Select value={runtime} onChange={setRuntime} options={engines.map((r) => ({ value: r.id, label: runtimeLabel(r.id, t) }))} ariaLabel={t("containers.sandbox.create.engine")} />
            )}
          </FormSection>
        )}
        <FormSection title={t("containers.sandbox.create.source")}>
          {!storyId && (
            <Segmented
              size="sm"
              value={from}
              onChange={setFrom}
              layoutId="sandbox-source"
              options={[
                { value: "project", label: t("containers.sandbox.create.fromProject") },
                { value: "task", label: t("containers.sandbox.create.fromTask") },
              ]}
            />
          )}
          {from === "project" ? (
            <div className="grid grid-cols-2 gap-2">
              <Field label={t("containers.sandbox.create.project")}>
                <Select value={projectId} onChange={setProjectId} loading={!sources} options={(sources?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))} ariaLabel={t("containers.sandbox.create.project")} />
              </Field>
              <Field label={t("containers.sandbox.create.branch")} hint={t("containers.sandbox.create.branchHint")}>
                <input value={branch} onChange={(e) => setBranch(e.target.value)} className={fieldClass({ size: "sm" })} spellCheck={false} />
              </Field>
            </div>
          ) : sources && sources.tasks.length === 0 ? (
            <MutedNote>{t("containers.sandbox.create.noTasks")}</MutedNote>
          ) : (
            <Field label={t("containers.sandbox.create.task")} hint={t("containers.sandbox.create.taskHint")}>
              <Select value={taskId} onChange={setTaskId} loading={!sources} options={(sources?.tasks ?? []).map((x) => ({ value: x.id, label: `${x.title || x.branch} · ${x.branch}` }))} ariaLabel={t("containers.sandbox.create.task")} />
            </Field>
          )}
          <Field label={t("containers.sandbox.create.name")}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} className={fieldClass({ size: "sm" })} />
          </Field>
        </FormSection>
        <FormSection title={t("containers.sandbox.create.image")}>
          <Field label={t("containers.sandbox.create.image")} hint={t("containers.sandbox.create.imageHint", { image: defaultImage })}>
            <input value={image} onChange={(e) => setImage(e.target.value)} placeholder={defaultImage} className={fieldClass({ size: "sm" })} spellCheck={false} />
          </Field>
        </FormSection>
        <FormSection title={t("containers.sandbox.create.network")}>
          <Segmented size="sm" value={network} onChange={setNetwork} layoutId="sandbox-network" options={networks.map((n) => ({ value: n, label: t(`containers.sandbox.network.${n}`) }))} />
          <p className="text-[11px] leading-snug text-[var(--cf-text-faint)]">{t(`containers.sandbox.networkHint.${network}`)}</p>
          {stored?.policy.restrictNetwork && <p className="text-[11px] text-[var(--cf-text-muted)]">{t("containers.sandbox.create.restricted")}</p>}
          {network === "internet" && (
            <Field label={t("containers.sandbox.create.ports")} hint={t("containers.sandbox.create.portsHint")}>
              <input value={ports} onChange={(e) => setPorts(e.target.value)} placeholder="3000 5173" className={fieldClass({ size: "sm" })} spellCheck={false} />
            </Field>
          )}
          <div className="grid grid-cols-3 gap-2">
            <Field label={t("containers.sandbox.create.memory")}>
              <input value={memory} onChange={(e) => setMemory(e.target.value)} inputMode="numeric" className={fieldClass({ size: "sm" })} />
            </Field>
            <Field label={t("containers.sandbox.create.cpus")}>
              <input value={cpus} onChange={(e) => setCpus(e.target.value)} inputMode="decimal" className={fieldClass({ size: "sm" })} />
            </Field>
            <Field label={t("containers.sandbox.create.pids")}>
              <input value={pids} onChange={(e) => setPids(e.target.value)} inputMode="numeric" className={fieldClass({ size: "sm" })} />
            </Field>
          </div>
        </FormSection>
        <p className="flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          <ShieldCheck size={12} className="mt-[1px] shrink-0 text-[var(--cf-success)]" />
          {t("containers.sandbox.create.hardening")}
        </p>
        {error && <p className="whitespace-pre-wrap rounded-md border border-[color-mix(in_oklab,var(--cf-danger)_35%,transparent)] px-2 py-1.5 text-[11.5px] text-[var(--cf-danger)]">{error}</p>}
      </div>
    </Dialog>
  );
}
