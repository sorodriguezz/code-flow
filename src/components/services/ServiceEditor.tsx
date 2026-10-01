import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  CirclePlay,
  Flag,
  FolderOpen,
  Globe,
  LoaderCircle,
  Plug,
  Radar,
  ScrollText,
  Server,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { fieldClass } from "../common/recipes";
import { useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { useServicesStore } from "../../state/servicesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { detectServices, listEnvFiles, servicePathExists } from "../../lib/tauri/services";
import { folderName, relativeInside } from "../../lib/folderPath";
import { scrollEdgeMask, useScrollEdges } from "../../lib/useScrollEdges";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  isComposeCommand,
  parseJson,
  serviceDeps,
  serviceDetectedPorts,
  serviceEnvFiles,
  servicePorts,
  type ReadyKind,
  type ServiceCandidate,
  type ServiceKind,
  type ServiceRow,
} from "../../types/services";
import { PortChip, StatusGlyph, readyDescription } from "./serviceBits";

/**
 * The form behind a service — built to be filled in by the repository as much as by the person.
 *
 * # Where first, then what
 *
 * The folder comes first because it is what everything else can be read from. Pick a repository
 * and the detector proposes what it can run — the `dev` script with the right package manager, the
 * compose stack, the Spring Boot app — and one click fills the command, the subfolder, the name and
 * the right readiness gate. The command box still takes anything: the proposals are a starting
 * point, not a menu to choose from.
 *
 * # Ready means "automatic" unless you say otherwise
 *
 * The default gate watches the process tree for the port it opens (see `services::supervisor`), so
 * nobody has to know the port in advance, and a task that finishes is recognised as finished. The
 * specific gates are still here for what `auto` cannot see.
 *
 * # One grid, top to bottom
 *
 * The user found the form crowded and lopsided (2026-10-01: "demasiada información y no ordenada…
 * todo asimétrico"): two columns of fields with hints of different lengths under each, a 2:1 pair,
 * a checkbox with a paragraph, and section headings in three different shapes. It is one shape now.
 * Every section — Where, What to run, Options, Advanced — is a heading over rows of the same
 * label/field grid ({@link FormSection}, {@link FormRow}): the labels in one column, every control
 * in the other, all of them 30px, so the edges line up from the first field to the last. What a
 * field means went from a line under it to its label's tooltip (the dotted underline says there is
 * one); only an error still takes a line, and only while it is true.
 */
export function ServiceEditor({
  workspaceId,
  service,
  initialGroupId = null,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  /** `null` for a new one. */
  service: ServiceRow | null;
  /** The group a new service is filed under — the one whose "new service here" was pressed. */
  initialGroupId?: string | null;
  onClose: () => void;
  /** With the saved row, so the dock can select it. */
  onSaved?: (saved: ServiceRow) => void;
}) {
  const t = useT();
  const add = useServicesStore((s) => s.add);
  const save = useServicesStore((s) => s.save);
  const start = useServicesStore((s) => s.start);
  const addGroup = useServicesStore((s) => s.addGroup);
  const services = useServicesStore((s) => s.services);
  const groups = useServicesStore((s) => s.groups);
  const runtime = useServicesStore((s) => s.runtime);
  const projects = useWorkspaceStore((s) => s.projectsByWorkspace[workspaceId]) ?? [];
  const activeProjectId = useWorkspaceStore((s) => s.activeProjectId);

  // A new service starts in the repository on screen: it is by far the likeliest thing to run.
  const defaultProject =
    service?.project_id ??
    (activeProjectId && projects.some((p) => p.id === activeProjectId) ? activeProjectId : (projects[0]?.id ?? ""));

  const [name, setName] = useState(service?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!service);
  const [projectId, setProjectId] = useState(service ? (service.project_id ?? "") : defaultProject);
  const [cwd, setCwd] = useState(service?.cwd ?? "");
  const [command, setCommand] = useState(service?.command ?? "");
  const [kind, setKind] = useState<ServiceKind>(service?.kind ?? "shell");
  const [readyKind, setReadyKind] = useState<ReadyKind>(service?.ready_kind ?? "auto");
  const [readyValue, setReadyValue] = useState(service?.ready_value ?? "");
  const [deps, setDeps] = useState<string[]>(service ? serviceDeps(service) : []);
  const [groupId, setGroupId] = useState(service ? (service.group_id ?? "") : (initialGroupId ?? ""));
  const [autorestart, setAutorestart] = useState(service?.autorestart ?? false);
  const [pinned, setPinned] = useState(service ? servicePorts(service).join(", ") : "");
  const [envText, setEnvText] = useState(() => envToText(service?.env ?? "{}"));
  const [envFiles, setEnvFiles] = useState<string[]>(() => (service ? serviceEnvFiles(service) : []));
  /** Whether the env files were chosen by hand — until then a new service follows its folder's `.env`. */
  const [envFilesTouched, setEnvFilesTouched] = useState(!!service);
  /** The env files the folder has, offered as one click each. */
  const [availableEnvFiles, setAvailableEnvFiles] = useState<string[]>([]);
  const [envFileDraft, setEnvFileDraft] = useState("");
  /** Keyring references the row holds — which the form cannot make and a service cannot be given.
   *  Shown, and removable, instead of kept out of sight; see `supervisor::env_of`. */
  const vaultKeys = useMemo(() => keyringKeys(service?.env ?? "{}"), [service?.env]);
  const [dropVault, setDropVault] = useState(false);
  // Open from the start only when something in it was set by hand: a new service, or one left on
  // the defaults, has nothing in there worth reading first.
  const [advanced, setAdvanced] = useState(
    () =>
      !!service &&
      (service.ready_kind !== "auto" ||
        servicePorts(service).length > 0 ||
        envToText(service.env) !== "" ||
        serviceEnvFiles(service).length > 0 ||
        keyringKeys(service.env).length > 0),
  );
  const [saving, setSaving] = useState(false);
  /** `null` while unknown — the field is only marked wrong once the backend has actually looked. */
  const [cwdOk, setCwdOk] = useState<boolean | null>(null);
  const [candidates, setCandidates] = useState<ServiceCandidate[] | null>(null);

  const project = projects.find((p) => p.id === projectId) ?? null;
  /** The folder the detector reads: the repository's root, or the absolute folder typed. */
  const scanRoot = project ? project.local_path : cwd.trim();
  /**
   * The subfolder the detector is pointed at, inside a repository: what was typed or picked in the
   * Subfolder field — **not** what a proposal filled in. The detector answers for that folder alone,
   * from it down (and reads it however deep it is), so following the proposals too would narrow the
   * list under the pointer on every click: pick the one in `apps/api` and the others would vanish.
   */
  const [focus, setFocus] = useState(service?.cwd ?? "");
  const scanFocus = project ? focus.trim() : "";
  /** The subfolder as the detector's paths spell it — `/`, no `./`, no trailing separator — so a
   *  proposal's file can be shown from there rather than from the repository's root. */
  const scope = tidyRelative(scanFocus);
  /** Where the proposals on screen were read, for the tooltip that says so. */
  const scopeName = project ? scope || project.name : folderName(cwd);
  /** The root the proposals on screen were read from — see the effect below. */
  const shownRoot = useRef<string | null>(null);
  const proposalsRef = useRef<HTMLDivElement>(null);
  const proposalEdges = useScrollEdges(proposalsRef, !!candidates?.length);
  const fieldId = useId();

  useEffect(() => {
    if (!scanRoot) {
      shownRoot.current = null;
      setCandidates([]);
      return;
    }
    let alive = true;
    // Another folder altogether starts from "reading…"; another subfolder of the same repository
    // keeps the proposals on screen until the new list arrives, rather than blinking them away on
    // every keystroke of a path.
    if (shownRoot.current !== scanRoot) setCandidates(null);
    const timer = setTimeout(() => {
      void detectServices(scanRoot, scanFocus)
        .then((found) => {
          if (!alive) return;
          shownRoot.current = scanRoot;
          setCandidates(found);
        })
        .catch(() => alive && setCandidates([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scanRoot, scanFocus]);

  /** Checked against the disk as it is typed, because the alternative is finding out at the first
   *  run — by which point the group is half up and the failure reads as the service's fault. */
  useEffect(() => {
    const target = project ? joinPath(project.local_path, cwd.trim()) : cwd.trim();
    if (!target) {
      setCwdOk(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void servicePathExists(target).then((ok) => alive && setCwdOk(ok));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cwd, project]);

  /** The env files the service's folder holds. A new service loads its `.env` unless told otherwise —
   *  every framework's own dev command reads it, so the same command run here should too. */
  useEffect(() => {
    const target = project ? joinPath(project.local_path, cwd.trim()) : cwd.trim();
    if (!target) {
      setAvailableEnvFiles([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      void listEnvFiles(target)
        .then((found) => {
          if (!alive) return;
          setAvailableEnvFiles(found);
          if (!envFilesTouched) setEnvFiles(found.includes(".env") ? [".env"] : []);
        })
        .catch(() => alive && setAvailableEnvFiles([]));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [cwd, project, envFilesTouched]);

  const addEnvFile = (file: string) => {
    const trimmed = literal(file).trim();
    setEnvFilesTouched(true);
    if (trimmed) setEnvFiles((current) => (current.includes(trimmed) ? current : [...current, trimmed]));
  };

  /** Everything except this service — you cannot wait for yourself. */
  const others = useMemo(() => services.filter((row) => row.id !== service?.id), [services, service?.id]);

  const pick = (candidate: ServiceCandidate) => {
    setCommand(candidate.command);
    setKind(candidate.kind);
    setReadyKind(candidate.readyKind);
    setReadyValue("");
    // A container's published ports are held by Docker, not by anything in the process tree, so
    // they are the one kind of port the form has to be told — see `pinnedPorts`.
    setPinned(candidate.pinnedPorts.join(", "));
    setCwd(project ? candidate.cwd : joinPath(cwd.trim(), candidate.cwd));
    if (!nameTouched) setName(candidate.name);
  };

  const pickedKey = `${project ? cwd.trim() : ""}\u0000${command.trim()}`;

  const problem = useMemo(() => {
    if (!command.trim()) return t("services.problem.command");
    if (!name.trim()) return t("services.problem.name");
    if (!project && !cwd.trim()) return t("services.problem.folder");
    if (cwdOk === false) return t("services.cwdMissing");
    if (readyKind === "port") {
      const port = Number(readyValue);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return t("services.problem.port");
    }
    if ((readyKind === "log" || readyKind === "http") && !readyValue.trim()) return t("services.problem.readyValue");
    return null;
  }, [command, name, project, cwd, cwdOk, readyKind, readyValue, t]);

  const submit = async (thenStart: boolean) => {
    if (problem) return;
    setSaving(true);
    const trimmed = literal(command).trim();
    const row: ServiceRow = {
      id: service?.id ?? "",
      workspace_id: workspaceId,
      group_id: groupId || null,
      name: name.trim(),
      // What made the command decides the kind; a compose command typed by hand is still compose.
      kind: isComposeCommand(trimmed) ? "compose" : kind === "compose" ? "shell" : kind,
      project_id: projectId || null,
      cwd: cwd.trim(),
      command: trimmed,
      env: textToEnv(envText, dropVault ? "{}" : (service?.env ?? "{}")),
      ports: JSON.stringify(portList(pinned)),
      ready_kind: readyKind,
      ready_value: readyKind === "port" || readyKind === "log" || readyKind === "http" ? readyValue.trim() : "",
      depends_on: JSON.stringify(deps),
      autorestart,
      color: service?.color ?? "",
      sort_order: service?.sort_order ?? 0,
      created_at: service?.created_at ?? "",
      updated_at: service ? new Date().toISOString() : "",
      detected_ports: service?.detected_ports ?? "[]",
      env_files: JSON.stringify(envFiles),
    };
    let saved: ServiceRow | null = null;
    if (service) {
      if (await save(row)) saved = row;
    } else {
      saved = await add(row);
    }
    setSaving(false);
    if (!saved) return;
    onSaved?.(saved);
    if (thenStart) void start(saved.id);
    onClose();
  };

  const newGroup = async () => {
    const created = await promptAction(t("services.newGroup"), {
      placeholder: t("services.groupNamePlaceholder"),
      confirmLabel: t("services.createGroup"),
    });
    if (!created?.trim()) return;
    const group = await addGroup(workspaceId, created.trim());
    if (group) setGroupId(group.id);
  };

  /**
   * The folder picker — for a subfolder as much as for a folder of its own: a service three folders
   * down is walked to, not typed. It opens where the field points (the repository's root when the
   * field is blank).
   *
   * Where the pick lands decides what the form holds. Inside the chosen repository it is a
   * subfolder of it. Inside another repository of the workspace the form moves to that one — the
   * folder is the fact, the dropdown was a guess, and a service named by its repository keeps working
   * when the checkout moves (`services.repositoryHint`). Anywhere else it is a folder of its own.
   */
  const browse = async () => {
    const start = project ? joinPath(project.local_path, cwd.trim()) : cwd.trim();
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: start || undefined });
    if (typeof picked !== "string") return;
    const holds = (candidate: { local_path: string }) => relativeInside(candidate.local_path, picked) !== null;
    // The repository already chosen wins; otherwise the innermost one, for a checkout nested in another.
    const owner =
      (project && holds(project) ? project : null) ??
      [...projects].filter(holds).sort((a, b) => b.local_path.length - a.local_path.length)[0] ??
      null;
    if (owner) {
      const rel = relativeInside(owner.local_path, picked) ?? "";
      setProjectId(owner.id);
      setCwd(rel);
      setFocus(rel);
    } else {
      setProjectId("");
      setCwd(picked);
      setFocus("");
    }
  };

  const learned = service ? serviceDetectedPorts(service) : [];
  const readyOptions: Array<{ kind: ReadyKind; icon: LucideIcon }> = [
    { kind: "auto", icon: Radar },
    { kind: "port", icon: Plug },
    { kind: "log", icon: ScrollText },
    { kind: "http", icon: Globe },
    { kind: "exit", icon: Flag },
    { kind: "none", icon: Zap },
  ];

  /** What the folded Advanced section holds, in one line — the readiness gate always, the rest when
   *  set. */
  const pinnedPorts = portList(pinned);
  const envCount = envText.split("\n").filter((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith("#") && trimmed.indexOf("=") > 0;
  }).length;
  const advancedSummary = [
    readyDescription(readyKind, readyValue.trim(), t),
    pinnedPorts.length ? t("services.advancedPorts", { ports: pinnedPorts.join(", ") }) : null,
    envCount === 1 ? t("services.advancedEnvOne") : envCount > 1 ? t("services.advancedEnv", { count: envCount }) : null,
    envFiles.length ? t("services.advancedEnvFiles", { files: envFiles.join(", ") }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ApiModal
      icon={Server}
      title={service ? t("services.editTitle") : t("services.newService")}
      subtitle={service ? service.name : t("services.newServiceSubtitle")}
      width="max-w-2xl"
      busy={saving}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          {problem && (
            <p className="mr-auto min-w-0 flex-1 truncate text-[11px] text-[var(--cf-text-muted)]">{problem}</p>
          )}
          {!problem && <div className="flex-1" />}
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          {!service && (
            <GhostButton onClick={() => void submit(false)} disabled={!!problem || saving}>
              {t("common.save")}
            </GhostButton>
          )}
          <PrimaryButton onClick={() => void submit(!service)} disabled={!!problem || saving}>
            {!service && <CirclePlay size={12} />}
            {service ? t("common.save") : t("services.saveAndStart")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 text-[12px]">
        {/* ── Where ─────────────────────────────────────────────────────────────── */}
        <FormSection title={t("services.section.where")}>
          <FormRow label={t("services.repository")} hint={t("services.repositoryHint")}>
            <Select
              value={projectId}
              onChange={(value) => {
                setProjectId(value);
                setCwd("");
                setFocus("");
              }}
              size="field"
              ariaLabel={t("services.repository")}
              options={[
                ...projects.map((p) => ({ value: p.id, label: p.name })),
                { value: "", label: t("services.noRepository") },
              ]}
            />
          </FormRow>
          <FormRow
            label={project ? t("services.subfolder") : t("services.cwd")}
            hint={project ? t("services.cwdRelativeHint") : undefined}
            htmlFor={`${fieldId}-cwd`}
            error={cwdOk === false ? t("services.cwdMissing") : undefined}
          >
            <div className="flex gap-2">
              <input
                id={`${fieldId}-cwd`}
                value={cwd}
                onChange={(e) => {
                  const value = literal(e.target.value);
                  setCwd(value);
                  setFocus(value);
                }}
                {...MACHINE_TEXT}
                // Blank is the repository's root — said where it is blank, instead of under it.
                placeholder={project ? t("services.subfolderRoot") : "/Users/…/api"}
                className={fieldClass({
                  // The placeholder is words, not a path: in the UI's face, so it cannot be read as one.
                  className: `w-full flex-1 font-mono ${project ? "placeholder:font-sans" : ""} ${
                    cwdOk === false ? "!border-[var(--cf-danger)]" : ""
                  }`,
                })}
              />
              {/* With a repository too: a subfolder can sit several folders down, and walking to
                  it beats typing its path. The field's own height, border and fill, so the pair
                  reads as one control. */}
              <Tooltip label={t("services.browse")}>
                <button
                  type="button"
                  onClick={() => void browse()}
                  aria-label={t("services.browse")}
                  className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] text-[var(--cf-text-muted)] transition-colors duration-100 hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                >
                  <FolderOpen size={14} />
                </button>
              </Tooltip>
            </div>
          </FormRow>
        </FormSection>

        {/* ── What ──────────────────────────────────────────────────────────────── */}
        <FormSection title={t("services.section.what")}>
          <FormRow
            label={t("services.suggestions")}
            count={candidates?.length || undefined}
            hint={candidates?.length ? t("services.suggestionsHint", { folder: scopeName }) : undefined}
          >
            {candidates === null ? (
              <div className="flex h-[30px] items-center gap-1.5 text-[var(--cf-text-muted)]">
                <LoaderCircle size={12} className="animate-spin" /> {t("services.detecting")}
              </div>
            ) : candidates.length === 0 ? (
              <div className="flex min-h-[30px] items-center text-[var(--cf-text-muted)]">
                {scanRoot ? t("services.nothingDetected") : t("services.pickFolderFirst")}
              </div>
            ) : (
              // More than it shows at once — it scrolls, and fades at the edge it continues past —
              // because a repository's root lists everything its folders run, and the one the
              // person came for may be the 13th.
              <div
                ref={proposalsRef}
                className="max-h-[164px] overflow-y-auto"
                style={{ maskImage: scrollEdgeMask(proposalEdges, 20), WebkitMaskImage: scrollEdgeMask(proposalEdges, 20) }}
              >
                <div className="grid grid-cols-2 gap-1.5">
                  {candidates.slice(0, 40).map((candidate) => {
                    const key = `${project ? candidate.cwd : ""}\u0000${candidate.command}`;
                    const chosen = key === pickedKey;
                    return (
                      <button
                        key={`${candidate.cwd}:${candidate.command}`}
                        type="button"
                        onClick={() => pick(candidate)}
                        aria-pressed={chosen}
                        title={`${candidate.source}${candidate.detail ? `\n${candidate.detail}` : ""}`}
                        className={`min-w-0 rounded-md border px-2.5 py-[6px] text-left transition-colors duration-100 ${
                          chosen
                            ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                            : "border-[var(--cf-border)] hover:border-[color-mix(in_srgb,var(--cf-accent)_60%,transparent)] hover:bg-[var(--cf-hover)]"
                        }`}
                      >
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--cf-text)]">
                            {candidate.command}
                          </span>
                          {candidate.readyKind === "exit" && (
                            <span className="shrink-0 rounded bg-[var(--cf-hover)] px-1 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                              {t("services.oneShot")}
                            </span>
                          )}
                        </span>
                        {/* From the subfolder down — the part of the path the subfolder above
                            does not already say. */}
                        <span className="mt-0.5 block truncate text-[11px] text-[var(--cf-text-muted)]">
                          {sourceFrom(scope, candidate.source)}
                          {candidate.detail ? ` · ${candidate.detail}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </FormRow>
          <FormRow label={t("services.command")} hint={t("services.commandHint")} htmlFor={`${fieldId}-command`}>
            <input
              id={`${fieldId}-command`}
              value={command}
              onChange={(e) => setCommand(literal(e.target.value))}
              {...MACHINE_TEXT}
              placeholder="pnpm dev"
              autoFocus={!service}
              className={fieldClass({ className: "w-full font-mono" })}
            />
          </FormRow>
          <FormRow label={t("services.name")} htmlFor={`${fieldId}-name`}>
            <input
              id={`${fieldId}-name`}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              {...MACHINE_TEXT}
              placeholder="api"
              className={fieldClass({ className: "w-full" })}
            />
          </FormRow>
        </FormSection>

        {/* ── Options ───────────────────────────────────────────────────────────── */}
        {/* How it lives among the others: the group it starts with, what it waits for, what
            happens when it falls over. */}
        <FormSection title={t("services.section.options")}>
          <FormRow label={t("services.group")}>
            <Select
              value={groupId}
              onChange={(value) => {
                if (value === "__new__") void newGroup();
                else setGroupId(value);
              }}
              size="field"
              ariaLabel={t("services.group")}
              options={[
                { value: "", label: t("services.ungrouped") },
                ...groups.map((group) => ({ value: group.id, label: group.name })),
                { value: "__new__", label: t("services.newGroupOption") },
              ]}
            />
          </FormRow>
          {/* Only once there is something to wait for. On the first service of a workspace the
              row could only say that it had nothing to offer. */}
          {others.length > 0 && (
            <FormRow label={t("services.dependsOn")} hint={t("services.dependsOnHint")}>
              <div className="flex flex-wrap gap-1.5 py-1">
                {others.map((candidate) => {
                  const on = deps.includes(candidate.id);
                  const group = groups.find((g) => g.id === candidate.group_id);
                  return (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() =>
                        setDeps((prev) => (on ? prev.filter((id) => id !== candidate.id) : [...prev, candidate.id]))
                      }
                      aria-pressed={on}
                      className={`flex h-[22px] items-center gap-1.5 rounded-full border pl-1.5 pr-2 text-[11px] transition-colors duration-100 ${
                        on
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                          : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-text)]"
                      }`}
                    >
                      <StatusGlyph status={runtime[candidate.id]?.status ?? "stopped"} size={6} />
                      {candidate.name}
                      {group && <span className="opacity-60">· {group.name}</span>}
                    </button>
                  );
                })}
              </div>
            </FormRow>
          )}
          <FormRow label="">
            <label className="flex min-h-[30px] w-fit cursor-pointer items-center gap-2 text-[12px] text-[var(--cf-text)]">
              <Checkbox checked={autorestart} onChange={setAutorestart} />
              <HintedText hint={t("services.autorestartHint")}>{t("services.autorestart")}</HintedText>
            </label>
          </FormRow>
        </FormSection>

        {/* ── Advanced ──────────────────────────────────────────────────────────── */}
        {/* Readiness lives here. "Automatic" is right for nearly everything — it finds the port by
            itself and recognises a task that finished — and a six-way choice in the middle of the
            form made every new service look like it needed a decision it did not. Folded, the
            heading still says what is set, so nothing in here is hidden, only folded. */}
        <FormSection
          title={t("services.section.advanced")}
          folded={!advanced}
          onToggle={() => setAdvanced((open) => !open)}
          aside={advanced ? undefined : advancedSummary}
        >
          <FormRow label={t("services.readyWhen")} hint={t("services.readyWhenHint")}>
            <Select
              value={readyKind}
              onChange={(value) => setReadyKind(value as ReadyKind)}
              size="field"
              ariaLabel={t("services.readyWhen")}
              options={readyOptions.map(({ kind: option, icon }) => ({
                value: option,
                icon,
                label:
                  option === "auto"
                    ? `${t("services.ready.auto")} (${t("services.recommended")})`
                    : t(`services.ready.${option}` as TranslationKey),
              }))}
            />
            {(readyKind === "port" || readyKind === "log" || readyKind === "http") && (
              <input
                value={readyValue}
                onChange={(e) => setReadyValue(literal(e.target.value))}
                {...MACHINE_TEXT}
                aria-label={t("services.readyWhen")}
                placeholder={
                  readyKind === "port" ? "5432" : readyKind === "http" ? "http://localhost:4001/health" : t("services.ready.logPlaceholder")
                }
                className={fieldClass({ className: "mt-2 w-full font-mono" })}
              />
            )}
            {/* What the chosen gate does, in its one line — for a pattern, how to write one. */}
            <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {readyKind === "log" ? t("services.ready.logHelp") : t(`services.ready.${readyKind}Hint` as TranslationKey)}
            </p>
            {readyKind === "auto" && learned.length > 0 && (
              <p className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-[var(--cf-text-muted)]">
                {t("services.learnedPorts")}
                {learned.map((port) => (
                  <PortChip key={port} port={port} dim />
                ))}
              </p>
            )}
          </FormRow>
          <FormRow label={t("services.pinnedPorts")} hint={t("services.pinnedPortsHint")} htmlFor={`${fieldId}-pinned`}>
            <input
              id={`${fieldId}-pinned`}
              value={pinned}
              onChange={(e) => setPinned(e.target.value)}
              {...MACHINE_TEXT}
              placeholder="5432, 6379"
              className={fieldClass({ className: "w-full font-mono" })}
            />
          </FormRow>
          <FormRow label={t("services.env")} hint={t("services.envHint")} htmlFor={`${fieldId}-env`}>
            <textarea
              id={`${fieldId}-env`}
              value={envText}
              onChange={(e) => setEnvText(literal(e.target.value))}
              {...MACHINE_TEXT}
              placeholder={"PORT=4001\nNODE_ENV=development"}
              rows={3}
              className={AREA}
            />
            {vaultKeys.length > 0 && !dropVault && (
              <p className="mt-1 text-[11px] leading-snug text-[var(--cf-danger)]">
                {t("services.vaultRefs", { keys: vaultKeys.join(", ") })}{" "}
                <button type="button" onClick={() => setDropVault(true)} className="underline hover:no-underline">
                  {t("services.vaultRefsRemove")}
                </button>
              </p>
            )}
          </FormRow>
          <FormRow label={t("services.envFiles")} hint={t("services.envFilesHint")} htmlFor={`${fieldId}-envfile`}>
            {/* A field that holds its files as chips: the chosen ones, the ones the folder has
                (dashed, one click to add) and a box for any other path. */}
            <div className="flex min-h-[30px] flex-wrap items-center gap-1 rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-1.5 py-1 transition-[border-color,box-shadow] duration-100 focus-within:border-[var(--cf-accent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]">
              {envFiles.map((file) => (
                <span
                  key={file}
                  className="flex h-5 items-center gap-0.5 rounded-[5px] bg-[var(--cf-accent-soft)] pl-1.5 pr-0.5 font-mono text-[11px] text-[var(--cf-accent)] shadow-[inset_0_0_0_1px_var(--cf-accent-line)]"
                >
                  {file}
                  <button
                    type="button"
                    onClick={() => {
                      setEnvFilesTouched(true);
                      setEnvFiles((current) => current.filter((other) => other !== file));
                    }}
                    title={t("services.envFileRemove", { file })}
                    aria-label={t("services.envFileRemove", { file })}
                    className="rounded p-0.5 hover:bg-[var(--cf-hover)]"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
              {availableEnvFiles
                .filter((file) => !envFiles.includes(file))
                .map((file) => (
                  <button
                    key={file}
                    type="button"
                    onClick={() => addEnvFile(file)}
                    className="flex h-5 items-center rounded-[5px] border border-dashed border-[var(--cf-border-strong)] px-1.5 font-mono text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                  >
                    + {file}
                  </button>
                ))}
              <input
                id={`${fieldId}-envfile`}
                value={envFileDraft}
                onChange={(e) => setEnvFileDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" || !envFileDraft.trim()) return;
                  e.preventDefault();
                  addEnvFile(envFileDraft);
                  setEnvFileDraft("");
                }}
                onBlur={() => {
                  if (!envFileDraft.trim()) return;
                  addEnvFile(envFileDraft);
                  setEnvFileDraft("");
                }}
                {...MACHINE_TEXT}
                placeholder={t("services.envFilesAdd")}
                className="h-5 min-w-[110px] flex-1 bg-transparent px-1 font-mono text-[12px] text-[var(--cf-text)] outline-none placeholder:text-[var(--cf-text-faint)]"
              />
            </div>
          </FormRow>
        </FormSection>
      </div>
    </ApiModal>
  );
}


/**
 * What every machine-read field here wears: a command, a path, a pattern, a variable.
 *
 * macOS's text substitutions apply inside a webview's inputs as they do in any text field, and they
 * are made for prose: with smart quotes on, `node -e "…"` arrives as `node -e “…”`, and with smart
 * dashes `--port` arrives as `—port`. Both look almost right and both break the command, so the
 * substitutions are switched off where the browser allows it and undone by {@link literal} where
 * it does not.
 */
const MACHINE_TEXT = { autoCorrect: "off", autoCapitalize: "off", spellCheck: false } as const;

/** The ports in a free-text list. Anything that is not a port number is dropped rather than
 *  refused: a trailing comma or a stray space is a typo, not a decision. */
function portList(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
}

/** Undoes what typographic substitution does to a command line. See {@link MACHINE_TEXT}. */
function literal(text: string): string {
  return text
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/\u2014/g, "--")
    .replace(/\u2013/g, "-")
    .replace(/\u2026/g, "...");
}

/** The env textarea: `fieldClass`'s border, fill, type and focus halo, at the height of its lines. */
const AREA =
  "block w-full min-w-0 resize-y rounded-md border border-[var(--cf-field-border)] bg-[var(--cf-field)] px-2.5 py-[6px] font-mono text-[13px] leading-[18px] text-[var(--cf-text)] outline-none transition-[border-color,box-shadow] duration-100 placeholder:text-[var(--cf-text-faint)] focus:border-[var(--cf-accent)] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--cf-accent)_20%,transparent)]";

/**
 * Every section's grid: a column of labels and a column of controls, the same width in all of them
 * — that is what makes the edges line up down the whole form, section after section.
 */
const GRID = "grid grid-cols-[128px_minmax(0,1fr)] items-start gap-x-4 gap-y-3";

/** A label beside a 30px control: its first line sits on the control's middle, a second one wraps
 *  under it rather than pushing the control away. */
const LABEL = "py-[7px] text-[12px] leading-4 text-[var(--cf-text-muted)]";

/**
 * Text whose meaning is in its tooltip, which a dotted underline says is there: the label first,
 * then what it means — the line that used to sit under the field, in a different length for each.
 */
function HintedText({ hint, children }: { hint: string; children: string }) {
  return (
    <Tooltip side="top" label={children} description={hint}>
      <span className="cursor-help underline decoration-[color-mix(in_oklab,var(--cf-text-muted)_55%,transparent)] decoration-dotted underline-offset-[3px]">
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * One block of the form: its heading over rows on the shared grid.
 *
 * Every section's heading is the same shape — small caps, a hairline above it from the second one
 * on — and `aside` is the one thing that may sit at its other end. With `onToggle` the heading is
 * the fold's button too (Advanced), and its aside says what the folded rows hold.
 */
function FormSection({
  title,
  aside,
  folded = false,
  onToggle,
  children,
}: {
  title: string;
  aside?: string;
  folded?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const heading = (
    <>
      <h3 className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.06em] text-[var(--cf-text-faint)]">
        {title}
      </h3>
      {aside && <span className="ml-auto min-w-0 truncate text-[11px] text-[var(--cf-text-muted)]">{aside}</span>}
    </>
  );
  return (
    <section className="border-t border-[var(--cf-border)] py-4 first:border-t-0">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          className="group/fold flex w-full min-w-0 items-center gap-3 text-left"
        >
          {heading}
          <ChevronDown
            size={12}
            className={`shrink-0 text-[var(--cf-text-faint)] transition-transform duration-100 group-hover/fold:text-[var(--cf-text)] ${
              aside ? "" : "ml-auto"
            } ${folded ? "-rotate-90" : ""}`}
          />
        </button>
      ) : (
        <div className="flex min-w-0 items-center gap-3">{heading}</div>
      )}
      {!folded && <div className={`mt-3 ${GRID}`}>{children}</div>}
    </section>
  );
}

/**
 * A label and its control, as two cells of the section's grid.
 *
 * `hint` is what the label means, in its tooltip. `htmlFor` makes the label a real one, so a click
 * on it lands in the field. `count` rides after the label (the proposals). `error` is the one line a
 * row may add under its control, and only while it is true.
 */
function FormRow({
  label,
  hint,
  htmlFor,
  count,
  error,
  children,
}: {
  label: string;
  hint?: string;
  htmlFor?: string;
  count?: number;
  error?: string;
  children: ReactNode;
}) {
  const text = (
    <>
      {hint && label ? <HintedText hint={hint}>{label}</HintedText> : label}
      {count !== undefined && <span className="ml-1.5 tabular-nums text-[var(--cf-text-faint)]">{count}</span>}
    </>
  );
  return (
    <>
      {htmlFor ? (
        <label htmlFor={htmlFor} className={LABEL}>
          {text}
        </label>
      ) : (
        <div className={LABEL}>{text}</div>
      )}
      <div className="min-w-0">
        {children}
        {error && <p className="mt-1 text-[11px] leading-snug text-[var(--cf-danger)]">{error}</p>}
      </div>
    </>
  );
}

/** A repo-relative path the way the detector writes one: `/` between folders, no `./` in front, no
 *  separator at the end. `""` is the repository's root. */
function tidyRelative(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/\/+$/, "")
    .replace(/^\.$/, "");
}

/** `source` from inside `scope`: `frontend/package.json` rather than `PoC/poc-v3/frontend/package.json`
 *  once the subfolder above it says `PoC/poc-v3`. As it is at the root, and outside the scope. */
function sourceFrom(scope: string, source: string): string {
  return scope && source.startsWith(`${scope}/`) ? source.slice(scope.length + 1) : source;
}

/** The keys of a stored environment whose values are not plain — `{"vault": id}` keyring references. */
function keyringKeys(json: string): string[] {
  return Object.entries(parseJson<Record<string, unknown>>(json, {}))
    .filter(([, value]) => value !== null && typeof value === "object")
    .map(([key]) => key);
}

/** `KEY=VALUE` lines from the stored JSON object. Entries that are not plain values (a keyring
 *  reference) are not shown here — they are listed under the field, and kept on save unless removed
 *  there, see {@link textToEnv}. */
function envToText(json: string): string {
  const env = parseJson<Record<string, unknown>>(json, {});
  return Object.entries(env)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n");
}

/** The JSON object to store for `text`, keeping any non-plain entries the previous value held. */
function textToEnv(text: string, previous: string): string {
  const kept = Object.fromEntries(
    Object.entries(parseJson<Record<string, unknown>>(previous, {})).filter(
      ([, value]) => value !== null && typeof value === "object",
    ),
  );
  const env: Record<string, unknown> = { ...kept };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim().replace(/^export\s+/, "");
    let value = line.slice(at + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) env[key] = value;
  }
  return JSON.stringify(env);
}

function joinPath(base: string, rel: string): string {
  if (!rel) return base;
  if (!base) return rel;
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) return rel;
  const sep = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${rel}`;
}
