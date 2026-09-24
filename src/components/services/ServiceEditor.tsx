import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  ChevronDown,
  ChevronRight,
  CirclePlay,
  Flag,
  FolderOpen,
  Globe,
  LoaderCircle,
  Plug,
  Radar,
  ScrollText,
  Server,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { ApiModal, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { useT } from "../../state/languageStore";
import { promptAction } from "../../state/promptStore";
import { useServicesStore } from "../../state/servicesStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { detectServices, servicePathExists } from "../../lib/tauri/services";
import type { TranslationKey } from "../../lib/i18n/translations";
import {
  isComposeCommand,
  parseJson,
  serviceDeps,
  serviceDetectedPorts,
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
  // Open from the start only when something in it was set by hand: a new service, or one left on
  // the defaults, has nothing in there worth reading first.
  const [advanced, setAdvanced] = useState(
    () =>
      !!service &&
      (service.ready_kind !== "auto" || servicePorts(service).length > 0 || envToText(service.env) !== ""),
  );
  const [saving, setSaving] = useState(false);
  /** `null` while unknown — the field is only marked wrong once the backend has actually looked. */
  const [cwdOk, setCwdOk] = useState<boolean | null>(null);
  const [candidates, setCandidates] = useState<ServiceCandidate[] | null>(null);

  const project = projects.find((p) => p.id === projectId) ?? null;
  /** The folder the detector reads: the repository's root, or the absolute folder typed. */
  const scanRoot = project ? project.local_path : cwd.trim();

  useEffect(() => {
    if (!scanRoot) {
      setCandidates([]);
      return;
    }
    let alive = true;
    setCandidates(null);
    const timer = setTimeout(() => {
      void detectServices(scanRoot)
        .then((found) => alive && setCandidates(found))
        .catch(() => alive && setCandidates([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [scanRoot]);

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
      env: textToEnv(envText, service?.env ?? "{}"),
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

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: cwd.trim() || undefined });
    if (typeof picked === "string") setCwd(picked);
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
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[12px]">
        {/* ── Where ─────────────────────────────────────────────────────────────── */}
        <Section title={t("services.section.where")}>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
            <Labelled label={t("services.repository")} hint={t("services.repositoryHint")}>
              <Select
                value={projectId}
                onChange={(value) => {
                  setProjectId(value);
                  setCwd("");
                }}
                size="field"
                options={[
                  ...projects.map((p) => ({ value: p.id, label: p.name })),
                  { value: "", label: t("services.noRepository") },
                ]}
              />
            </Labelled>
            <Labelled
              label={project ? t("services.subfolder") : t("services.cwd")}
              hint={project ? t("services.cwdRelativeHint") : undefined}
              error={cwdOk === false ? t("services.cwdMissing") : undefined}
            >
              <div className="flex gap-1.5">
                <input
                  value={cwd}
                  onChange={(e) => setCwd(literal(e.target.value))}
                  {...MACHINE_TEXT}
                  placeholder={project ? "apps/api" : "/Users/…/api"}
                  className={`${INPUT} font-mono ${cwdOk === false ? "border-[var(--cf-danger)]" : ""}`}
                />
                {!project && (
                  <button
                    onClick={() => void browse()}
                    title={t("services.browse")}
                    aria-label={t("services.browse")}
                    className="flex shrink-0 items-center justify-center rounded-md border border-[var(--cf-border)] px-2 text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
                  >
                    <FolderOpen size={13} />
                  </button>
                )}
              </div>
            </Labelled>
          </div>
        </Section>

        {/* ── What ──────────────────────────────────────────────────────────────── */}
        <Section title={t("services.section.what")}>
          <div className="mb-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--cf-text-muted)]">
              <Radar size={11} />
              {candidates === null ? (
                <span className="flex items-center gap-1">
                  <LoaderCircle size={11} className="animate-spin" /> {t("services.detecting")}
                </span>
              ) : candidates.length ? (
                <span>{t("services.detectedHere", { count: candidates.length })}</span>
              ) : (
                <span>{scanRoot ? t("services.nothingDetected") : t("services.pickFolderFirst")}</span>
              )}
            </div>
            {candidates && candidates.length > 0 && (
              <div className="grid max-h-[168px] grid-cols-2 gap-1.5 overflow-y-auto pr-1">
                {candidates.slice(0, 12).map((candidate) => {
                  const key = `${project ? candidate.cwd : ""}\u0000${candidate.command}`;
                  const chosen = key === pickedKey;
                  return (
                    <button
                      key={`${candidate.cwd}:${candidate.command}`}
                      onClick={() => pick(candidate)}
                      className={`min-w-0 rounded-md border px-2 py-1.5 text-left transition-colors ${
                        chosen
                          ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                          : "border-[var(--cf-border)] hover:border-[color-mix(in_srgb,var(--cf-accent)_60%,transparent)] hover:bg-[var(--cf-hover)]"
                      }`}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[var(--cf-text)]">
                          {candidate.command}
                        </span>
                        {candidate.readyKind === "exit" && (
                          <span className="shrink-0 rounded bg-[var(--cf-hover)] px-1 text-[10.5px] uppercase tracking-wide text-[var(--cf-text-muted)]">
                            {t("services.oneShot")}
                          </span>
                        )}
                      </div>
                      <div className="mt-0.5 truncate text-[10.5px] text-[var(--cf-text-muted)]" title={candidate.detail}>
                        {candidate.source}
                        {candidate.detail ? ` · ${candidate.detail}` : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-3">
            <Labelled label={t("services.command")} hint={t("services.commandHint")}>
              <input
                value={command}
                onChange={(e) => setCommand(literal(e.target.value))}
                {...MACHINE_TEXT}
                placeholder="pnpm dev"
                autoFocus={!service}
                className={`${INPUT} font-mono`}
              />
            </Labelled>
            <Labelled label={t("services.name")}>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameTouched(true);
                }}
                {...MACHINE_TEXT}
                placeholder="api"
                className={INPUT}
              />
            </Labelled>
          </div>
        </Section>

        {/* ── Waits for ─────────────────────────────────────────────────────────── */}
        {/* Only once there is something to wait for. On the first service of a workspace the
            section could only say that it had nothing to offer. */}
        {others.length > 0 && (
          <Section title={t("services.dependsOn")} hint={t("services.dependsOnHint")}>
            <div className="flex flex-wrap gap-1.5">
              {others.map((candidate) => {
                const on = deps.includes(candidate.id);
                const group = groups.find((g) => g.id === candidate.group_id);
                return (
                  <button
                    key={candidate.id}
                    onClick={() =>
                      setDeps((prev) => (on ? prev.filter((id) => id !== candidate.id) : [...prev, candidate.id]))
                    }
                    aria-pressed={on}
                    className={`flex items-center gap-1.5 rounded-full border py-0.5 pl-1.5 pr-2 text-[11px] transition-colors ${
                      on
                        ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
                        : "border-[var(--cf-border)] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)]"
                    }`}
                  >
                    <StatusGlyph status={runtime[candidate.id]?.status ?? "stopped"} size={6} />
                    {candidate.name}
                    {group && <span className="opacity-60">· {group.name}</span>}
                  </button>
                );
              })}
            </div>
          </Section>
        )}

        {/* ── Options ───────────────────────────────────────────────────────────── */}
        <Section title={t("services.section.options")}>
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-3">
            <Labelled label={t("services.group")}>
              <Select
                value={groupId}
                onChange={(value) => {
                  if (value === "__new__") void newGroup();
                  else setGroupId(value);
                }}
                size="field"
                options={[
                  { value: "", label: t("services.ungrouped") },
                  ...groups.map((group) => ({ value: group.id, label: group.name })),
                  { value: "__new__", label: t("services.newGroupOption") },
                ]}
              />
            </Labelled>
            <label className="mt-5 flex cursor-pointer items-start gap-2">
              <Checkbox checked={autorestart} onChange={setAutorestart} className="mt-0.5" />
              <span className="min-w-0">
                <span className="block text-[12px] text-[var(--cf-text)]">{t("services.autorestart")}</span>
                <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                  {t("services.autorestartHint")}
                </span>
              </span>
            </label>
          </div>
        </Section>

        {/* ── Advanced ──────────────────────────────────────────────────────────── */}
        {/* Readiness lives here now. "Automatic" is right for nearly everything — it finds the port
            by itself and recognises a task that finished — and a six-way choice in the middle of
            the form made every new service look like it needed a decision it did not. The line
            beside the toggle still says what is set, so nothing in here is hidden, only folded. */}
        <div>
          <button
            onClick={() => setAdvanced((open) => !open)}
            aria-expanded={advanced}
            className="flex w-full min-w-0 items-center gap-1 text-left text-[10.5px] font-medium uppercase tracking-wide text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          >
            {advanced ? <ChevronDown size={11} className="shrink-0" /> : <ChevronRight size={11} className="shrink-0" />}
            <span className="shrink-0">{t("services.section.advanced")}</span>
            {!advanced && (
              <span className="ml-2 min-w-0 truncate text-[10.5px] font-normal normal-case tracking-normal opacity-80">
                {advancedSummary}
              </span>
            )}
          </button>
          {advanced && (
            <div className="mt-3 space-y-4">
              <Section title={t("services.readyWhen")} hint={t("services.readyWhenHint")}>
                <div className="grid grid-cols-3 gap-1.5">
                  {readyOptions.map(({ kind: option, icon: Icon }) => {
                    const on = readyKind === option;
                    return (
                      <button
                        key={option}
                        onClick={() => setReadyKind(option)}
                        aria-pressed={on}
                        className={`flex min-w-0 items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors ${
                          on
                            ? "border-[var(--cf-accent)] bg-[var(--cf-accent-soft)]"
                            : "border-[var(--cf-border)] hover:border-[color-mix(in_srgb,var(--cf-accent)_60%,transparent)]"
                        }`}
                      >
                        <Icon size={13} className={`mt-px shrink-0 ${on ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)]"}`} />
                        <span className="min-w-0">
                          <span className="block truncate text-[11px] font-medium text-[var(--cf-text)]">
                            {t(`services.ready.${option}` as TranslationKey)}
                            {option === "auto" && (
                              <span className="ml-1 text-[10.5px] font-normal uppercase tracking-wide text-[var(--cf-accent)]">
                                {t("services.recommended")}
                              </span>
                            )}
                          </span>
                          <span className="block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">
                            {t(`services.ready.${option}Hint` as TranslationKey)}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                {(readyKind === "port" || readyKind === "log" || readyKind === "http") && (
                  <div className="mt-2">
                    <input
                      value={readyValue}
                      onChange={(e) => setReadyValue(literal(e.target.value))}
                      {...MACHINE_TEXT}
                      placeholder={
                        readyKind === "port" ? "5432" : readyKind === "http" ? "http://localhost:4001/health" : t("services.ready.logPlaceholder")
                      }
                      className={`${INPUT} font-mono`}
                    />
                    {readyKind === "log" && (
                      <p className="mt-1 text-[10.5px] text-[var(--cf-text-muted)]">{t("services.ready.logHelp")}</p>
                    )}
                  </div>
                )}
                {readyKind === "auto" && learned.length > 0 && (
                  <p className="mt-2 flex flex-wrap items-center gap-1 text-[10.5px] text-[var(--cf-text-muted)]">
                    {t("services.learnedPorts")}
                    {learned.map((port) => (
                      <PortChip key={port} port={port} dim />
                    ))}
                  </p>
                )}
              </Section>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
                <Labelled label={t("services.pinnedPorts")} hint={t("services.pinnedPortsHint")}>
                  <input
                    value={pinned}
                    onChange={(e) => setPinned(e.target.value)}
                    {...MACHINE_TEXT}
                    placeholder="5432, 6379"
                    className={`${INPUT} font-mono`}
                  />
                </Labelled>
                <Labelled label={t("services.env")} hint={t("services.envHint")}>
                  <textarea
                    value={envText}
                    onChange={(e) => setEnvText(literal(e.target.value))}
                    {...MACHINE_TEXT}
                    placeholder={"PORT=4001\nNODE_ENV=development"}
                    rows={3}
                    className={`${INPUT} resize-y font-mono leading-snug`}
                  />
                </Labelled>
              </div>
            </div>
          )}
        </div>
      </div>
    </ApiModal>
  );
}

const INPUT =
  "w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-field)] px-2 py-1.5 text-[12px] text-[var(--cf-text)] outline-none focus:border-[var(--cf-accent)]";

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

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{title}</h3>
        {hint && <span className="min-w-0 truncate text-[10.5px] text-[var(--cf-text-muted)] opacity-80">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function Labelled({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="block min-w-0">
      <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">{label}</span>
      {children}
      {/* The error replaces the hint rather than stacking under it: they answer the same question. */}
      {error ? (
        <span className="mt-1 block text-[10.5px] text-[var(--cf-danger)]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[10.5px] leading-snug text-[var(--cf-text-muted)]">{hint}</span>
      ) : null}
    </div>
  );
}

/** `KEY=VALUE` lines from the stored JSON object. Entries that are not plain values (a keyring
 *  reference) are not shown — and are kept on save, see {@link textToEnv}. */
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
