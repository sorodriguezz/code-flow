import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Select } from "../common/Select";
import { Checkbox } from "../common/Checkbox";
import { useT } from "../../state/languageStore";
import { useServicesStore } from "../../state/servicesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { servicePathExists } from "../../lib/tauri/services";
import type { ReadyKind, ServiceKind, ServiceRow } from "../../types/services";
import { serviceDeps, servicePorts } from "../../types/services";

/**
 * The form behind a service: what to run, where, when it counts as up, and what it waits for.
 *
 * # Why the readiness gate is not optional-looking
 *
 * It is the field that makes `depends_on` mean anything. A group whose services all report "ready"
 * the instant their process exists is a group that starts the API against a database that has not
 * finished opening its socket — which is the exact failure this whole screen exists to remove, and
 * it fails *intermittently*, which is worse. So the gate sits directly under the command, not in an
 * "advanced" section, and its default for a `script` is a log match rather than `none`.
 *
 * # Ports are declared, not detected
 *
 * Reading them out of the output is a guess — "listening on 3000" appears in proxy logs, in test
 * output, in a dependency's banner — and a wrong link is worse than no link, because it is a link
 * the user clicks. Typed once, it is right forever.
 */
export function ServiceEditor({
  workspaceId,
  service,
  onClose,
}: {
  workspaceId: string;
  /** `null` for a new one. */
  service: ServiceRow | null;
  onClose: () => void;
}) {
  const add = useServicesStore((s) => s.add);
  const save = useServicesStore((s) => s.save);
  const services = useServicesStore((s) => s.services);
  const groups = useServicesStore((s) => s.groups);
  const projects = useWorkspaceStore((s) =>
    s.activeWorkspaceId ? (s.projectsByWorkspace[s.activeWorkspaceId] ?? []) : [],
  );
  const t = useT();

  const [name, setName] = useState(service?.name ?? "");
  const [kind, setKind] = useState<ServiceKind>(service?.kind ?? "shell");
  const [projectId, setProjectId] = useState(service?.project_id ?? "");
  const [cwd, setCwd] = useState(service?.cwd ?? "");
  const [command, setCommand] = useState(service?.command ?? "");
  const [ports, setPorts] = useState(service ? servicePorts(service).join(", ") : "");
  const [readyKind, setReadyKind] = useState<ReadyKind>(service?.ready_kind ?? "none");
  const [readyValue, setReadyValue] = useState(service?.ready_value ?? "");
  const [deps, setDeps] = useState<string[]>(service ? serviceDeps(service) : []);
  const [groupId, setGroupId] = useState(service?.group_id ?? "");
  const [autorestart, setAutorestart] = useState(service?.autorestart ?? false);
  const [saving, setSaving] = useState(false);
  /** `null` while unknown — the field is only marked wrong once the backend has actually looked. */
  const [cwdOk, setCwdOk] = useState<boolean | null>(null);

  /** Checked against the disk as it is typed, because the alternative is finding out at the first
   *  run — by which point the group is half up and the failure reads as the service's fault. */
  useEffect(() => {
    const absolute = !projectId && cwd.trim();
    if (!absolute) {
      setCwdOk(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void servicePathExists(cwd).then((ok) => {
        if (alive) setCwdOk(ok);
      });
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cwd, projectId]);

  /** Everything except this service — you cannot wait for yourself, and offering it would be the
   *  one dependency the backend is guaranteed to refuse. */
  const candidates = useMemo(
    () => services.filter((row) => row.id !== service?.id),
    [services, service?.id],
  );

  const submit = async () => {
    if (!name.trim() || !command.trim()) return;
    setSaving(true);
    const row: ServiceRow = {
      id: service?.id ?? "",
      workspace_id: workspaceId,
      group_id: groupId || null,
      name: name.trim(),
      kind,
      project_id: projectId || null,
      cwd: cwd.trim(),
      command: command.trim(),
      env: service?.env ?? "{}",
      // Anything that is not a number is dropped rather than refused: a trailing comma or a stray
      // space is a typo, not a decision, and rejecting the save over one is a worse trade than
      // silently ignoring it.
      ports: JSON.stringify(
        ports
          .split(/[\s,]+/)
          .map((piece) => Number(piece))
          .filter((port) => Number.isInteger(port) && port > 0 && port < 65536),
      ),
      ready_kind: readyKind,
      ready_value: readyKind === "none" ? "" : readyValue.trim(),
      depends_on: JSON.stringify(deps),
      autorestart,
      color: service?.color ?? "",
      sort_order: service?.sort_order ?? 0,
      created_at: service?.created_at ?? "",
      updated_at: service?.updated_at ?? "",
    };
    if (service) await save(row);
    else await add(row);
    setSaving(false);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-4 py-2.5">
          <h2 className="flex-1 text-[13px] font-semibold">
            {service ? t("services.editTitle") : t("services.newService")}
          </h2>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-6 w-6 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-[12px]">
          <Field label={t("services.name")}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="api-auth"
              autoFocus
              className={INPUT}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("services.kind")}>
              <Select
                value={kind}
                onChange={(value) => setKind(value as ServiceKind)}
                options={[
                  { value: "shell", label: t("services.kindShell") },
                  { value: "script", label: t("services.kindScript") },
                  { value: "compose", label: t("services.kindCompose") },
                ]}
              />
            </Field>
            <Field label={t("services.group")}>
              <Select
                value={groupId}
                onChange={setGroupId}
                options={[
                  { value: "", label: t("services.ungrouped") },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                ]}
              />
            </Field>
          </div>

          <Field label={t("services.command")} hint={t("services.commandHint")}>
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="pnpm dev"
              className={`${INPUT} font-mono`}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("services.repository")} hint={t("services.repositoryHint")}>
              <Select
                value={projectId}
                onChange={setProjectId}
                options={[
                  { value: "", label: t("services.noRepository") },
                  ...projects.map((project) => ({ value: project.id, label: project.name })),
                ]}
              />
            </Field>
            <Field
              label={t("services.cwd")}
              hint={projectId ? t("services.cwdRelativeHint") : undefined}
              error={cwdOk === false ? t("services.cwdMissing") : undefined}
            >
              <input
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={projectId ? "packages/api" : "/Users/…/api"}
                className={`${INPUT} font-mono ${cwdOk === false ? "border-[var(--cf-danger)]" : ""}`}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={t("services.readyWhen")} hint={t("services.readyWhenHint")}>
              <Select
                value={readyKind}
                onChange={(value) => setReadyKind(value as ReadyKind)}
                options={[
                  { value: "none", label: t("services.readyNone") },
                  { value: "port", label: t("services.readyPort") },
                  { value: "log", label: t("services.readyLog") },
                  { value: "http", label: t("services.readyHttp") },
                ]}
              />
            </Field>
            {readyKind !== "none" && (
              <Field label={t("services.readyValue")}>
                <input
                  value={readyValue}
                  onChange={(e) => setReadyValue(e.target.value)}
                  placeholder={
                    readyKind === "port" ? "5432" : readyKind === "http" ? "http://localhost:4001/health" : "ready in"
                  }
                  className={`${INPUT} font-mono`}
                />
              </Field>
            )}
          </div>

          <Field label={t("services.ports")} hint={t("services.portsHint")}>
            <input
              value={ports}
              onChange={(e) => setPorts(e.target.value)}
              placeholder="5173, 24678"
              className={`${INPUT} font-mono`}
            />
          </Field>

          {candidates.length > 0 && (
            <Field label={t("services.dependsOn")} hint={t("services.dependsOnHint")}>
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((candidate) => {
                  const on = deps.includes(candidate.id);
                  return (
                    <button
                      key={candidate.id}
                      onClick={() =>
                        setDeps((prev) =>
                          on ? prev.filter((id) => id !== candidate.id) : [...prev, candidate.id],
                        )
                      }
                      aria-pressed={on}
                      className={`rounded-full border px-2 py-0.5 text-[11px] ${
                        on
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)]"
                      }`}
                    >
                      {candidate.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}

          {/* The bare `Checkbox` is a box and nothing else — its label is the caller's, the way
              every other checkbox in this app does it. */}
          <label className="flex cursor-pointer items-start gap-2">
            <Checkbox checked={autorestart} onChange={setAutorestart} className="mt-0.5" />
            <span className="min-w-0">
              <span className="block text-[12px] text-[var(--cf-text)]">{t("services.autorestart")}</span>
              <span className="block text-[10px] text-[var(--cf-text-muted)]">
                {t("services.autorestartHint")}
              </span>
            </span>
          </label>
        </div>

        <div className="flex shrink-0 justify-end gap-2 border-t border-[var(--cf-border)] px-4 py-2.5">
          <button
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void submit()}
            disabled={saving || !name.trim() || !command.trim()}
            className="rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

const INPUT =
  "w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">{label}</span>
      {children}
      {/* The error replaces the hint rather than stacking under it: they answer the same question,
          and two lines of guidance where one is now wrong is worse than one that is right. */}
      {error ? (
        <span className="mt-1 block text-[10px] text-[var(--cf-danger)]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[10px] text-[var(--cf-text-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}
