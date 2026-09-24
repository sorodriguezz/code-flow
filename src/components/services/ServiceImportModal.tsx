import { useEffect, useMemo, useState } from "react";
import { Container, LoaderCircle, Plus, Radar } from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { useT } from "../../state/languageStore";
import { useServicesStore } from "../../state/servicesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { pushErrorToast } from "../../state/toastStore";
import { detectWorkspaceServices } from "../../lib/tauri/services";
import type { ProjectCandidates, ServiceCandidate, ServiceRow } from "../../types/services";
import { PortChip } from "./serviceBits";
import { fieldClass } from "../common/recipes";

/** A candidate's identity within the import: which repository, which folder, which command. */
const keyOf = (projectId: string, candidate: ServiceCandidate) =>
  `${projectId}\u0000${candidate.cwd}\u0000${candidate.command}`;

/**
 * Every repository in the workspace, read for what it can run — and turned into services in one go.
 *
 * The automatic half of creating services. The editor proposes for one folder at a time; this reads
 * them all and lists what it found, **nothing ticked**: a workspace of a dozen repositories proposes
 * dozens of commands, and deciding which of them are services is the user's call — the detection
 * is the automatic part, the choosing is not. The one wiring it does on its own is the one that is
 * almost always right — an app waits for the containers its own repository defines — and it is a
 * checkbox, not a rule.
 */
export function ServiceImportModal({
  workspaceId,
  onClose,
  onImported,
}: {
  workspaceId: string;
  onClose: () => void;
  onImported: (first: ServiceRow | null) => void;
}) {
  const t = useT();
  const services = useServicesStore((s) => s.services);
  const groups = useServicesStore((s) => s.groups);
  const add = useServicesStore((s) => s.add);
  const addGroup = useServicesStore((s) => s.addGroup);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === workspaceId));

  const [found, setFound] = useState<ProjectCandidates[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [names, setNames] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<string>(groups.length ? groups[0].id : "__new__");
  const [groupName, setGroupName] = useState(workspace?.name ?? "");
  const [wire, setWire] = useState(true);
  const [saving, setSaving] = useState(false);

  const exists = (projectId: string, candidate: ServiceCandidate) =>
    services.some(
      (s) => s.project_id === projectId && s.cwd.trim() === candidate.cwd && s.command.trim() === candidate.command,
    );

  // Read once, on open: the list below is a snapshot to choose from.
  useEffect(() => {
    let alive = true;
    void detectWorkspaceServices(workspaceId)
      .then((projects) => {
        if (alive) setFound(projects.filter((p) => p.candidates.length > 0));
      })
      .catch((err: unknown) => {
        pushErrorToast(String(err));
        if (alive) setFound([]);
      });
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const count = selected.size;
  const nameFor = (key: string, candidate: ServiceCandidate) => names[key] ?? candidate.name;

  const problem = useMemo(() => {
    if (!count) return t("services.import.pickSome");
    if (target === "__new__" && !groupName.trim()) return t("services.import.groupNeedsName");
    return null;
  }, [count, target, groupName, t]);

  const submit = async () => {
    if (!found || problem) return;
    setSaving(true);
    let groupId: string | null = null;
    if (target === "__new__") {
      const group = await addGroup(workspaceId, groupName.trim());
      if (!group) {
        setSaving(false);
        return;
      }
      groupId = group.id;
    } else if (target) {
      groupId = target;
    }

    let first: ServiceRow | null = null;
    for (const project of found) {
      const chosen = project.candidates.filter((c) => selected.has(keyOf(project.projectId, c)));
      // Containers first, so the apps created after them can name them as what they wait for.
      const ordered = [...chosen.filter((c) => c.kind === "compose"), ...chosen.filter((c) => c.kind !== "compose")];
      const composeIds: string[] = [];
      for (const candidate of ordered) {
        const key = keyOf(project.projectId, candidate);
        const waitsFor = wire && candidate.kind !== "compose" ? composeIds : [];
        const created = await add(
          draft(workspaceId, groupId, project.projectId, nameFor(key, candidate).trim() || candidate.name, candidate, waitsFor),
        );
        if (!created) continue;
        first ??= created;
        if (candidate.kind === "compose") composeIds.push(created.id);
      }
    }
    setSaving(false);
    onImported(first);
    onClose();
  };

  return (
    <ApiModal
      icon={Radar}
      title={t("services.import.title")}
      subtitle={t("services.import.subtitle")}
      width="max-w-3xl"
      height="h-[70vh]"
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">{t("services.import.into")}</span>
            <div className="w-44 shrink-0">
              <Select
                value={target}
                onChange={setTarget}
                size="compact"
                options={[
                  { value: "__new__", label: t("services.import.newGroup") },
                  ...groups.map((g) => ({ value: g.id, label: g.name })),
                  { value: "", label: t("services.ungrouped") },
                ]}
              />
            </div>
            {target === "__new__" && (
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder={t("services.groupNamePlaceholder")}
                className={fieldClass({ size: "sm", className: "w-36 min-w-0" })}
              />
            )}
            <label className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
              <Checkbox checked={wire} onChange={setWire} />
              <span className="truncate" title={t("services.import.wireHint")}>
                {t("services.import.wire")}
              </span>
            </label>
          </div>
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={() => void submit()} disabled={!!problem || saving}>
            <Plus size={12} />
            {t("services.import.add", { count })}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {found === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-[12px] text-[var(--cf-text-muted)]">
            <LoaderCircle size={18} className="animate-spin" />
            {t("services.import.reading")}
          </div>
        ) : found.length === 0 ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-[12px] text-[var(--cf-text-muted)]">
            {t("services.import.nothing")}
          </div>
        ) : (
          found.map((project) => {
            const keys = project.candidates
              .filter((c) => !exists(project.projectId, c))
              .map((c) => keyOf(project.projectId, c));
            const picked = keys.filter((k) => selected.has(k)).length;
            return (
              <div key={project.projectId} className="border-b border-[var(--cf-border)] last:border-b-0">
                <label className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 bg-[var(--cf-surface)] px-4 py-2">
                  <Checkbox
                    checked={picked > 0 && picked === keys.length}
                    indeterminate={picked > 0 && picked < keys.length}
                    disabled={!keys.length}
                    onChange={(on) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        for (const key of keys) {
                          if (on) next.add(key);
                          else next.delete(key);
                        }
                        return next;
                      })
                    }
                  />
                  <span className="text-[12px] font-semibold text-[var(--cf-text)]">{project.projectName}</span>
                  <span className="min-w-0 truncate font-mono text-[10.5px] text-[var(--cf-text-muted)]">{project.path}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] tabular-nums text-[var(--cf-text-muted)]">
                    {picked}/{project.candidates.length}
                  </span>
                </label>
                {project.candidates.map((candidate) => {
                  const key = keyOf(project.projectId, candidate);
                  const already = exists(project.projectId, candidate);
                  const on = selected.has(key);
                  return (
                    <div
                      key={key}
                      className={`flex items-center gap-2 px-4 py-1.5 pl-10 ${already ? "opacity-50" : ""} ${
                        on ? "bg-[color-mix(in_srgb,var(--cf-accent)_5%,transparent)]" : ""
                      }`}
                    >
                      <Checkbox checked={on} disabled={already} onChange={() => toggle(key)} />
                      <input
                        value={nameFor(key, candidate)}
                        disabled={already}
                        autoCorrect="off"
                        autoCapitalize="off"
                        spellCheck={false}
                        onChange={(e) => setNames((prev) => ({ ...prev, [key]: e.target.value }))}
                        className="w-32 shrink-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-[12px] text-[var(--cf-text)] outline-none hover:border-[var(--cf-border)] focus:border-[var(--cf-accent)]"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          {candidate.kind === "compose" && <Container size={11} className="shrink-0 text-[var(--cf-text-muted)]" />}
                          <span className="truncate font-mono text-[11px] text-[var(--cf-text)]">
                            {candidate.cwd ? <span className="text-[var(--cf-text-muted)]">{candidate.cwd}$ </span> : null}
                            {candidate.command}
                          </span>
                        </div>
                        <div className="truncate text-[10.5px] text-[var(--cf-text-muted)]" title={candidate.detail}>
                          {candidate.source}
                          {candidate.detail ? ` · ${candidate.detail}` : ""}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {candidate.ports.slice(0, 3).map((port) => (
                          <PortChip key={port} port={port} dim />
                        ))}
                        {candidate.readyKind === "exit" && (
                          <span className="rounded bg-[var(--cf-hover)] px-1 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                            {t("services.oneShot")}
                          </span>
                        )}
                        {already && (
                          <span className="rounded bg-[var(--cf-hover)] px-1 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                            {t("services.import.exists")}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })
        )}
      </div>
    </ApiModal>
  );
}

function draft(
  workspaceId: string,
  groupId: string | null,
  projectId: string,
  name: string,
  candidate: ServiceCandidate,
  dependsOn: string[],
): ServiceRow {
  return {
    id: "",
    workspace_id: workspaceId,
    group_id: groupId,
    name,
    kind: candidate.kind,
    project_id: projectId,
    cwd: candidate.cwd,
    command: candidate.command,
    env: "{}",
    // Only what the process tree cannot show — a container's published ports. See `pinnedPorts`.
    ports: JSON.stringify(candidate.pinnedPorts),
    ready_kind: candidate.readyKind,
    ready_value: "",
    depends_on: JSON.stringify(dependsOn),
    autorestart: false,
    color: "",
    sort_order: 0,
    created_at: "",
    updated_at: "",
    detected_ports: "[]",
  };
}
