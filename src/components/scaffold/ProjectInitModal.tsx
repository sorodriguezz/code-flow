import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { homeDir } from "@tauri-apps/api/path";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Code2, FolderOpen, FolderSearch, Rocket, X } from "lucide-react";
import { useT } from "../../state/languageStore";
import { useUiStore } from "../../state/uiStore";
import { useWorkspaceStore } from "../../state/workspaceStore";
import { sourceKey, useScaffoldStore } from "../../state/scaffoldStore";
import { startTerminalRouter } from "../../state/terminalStore";
import { pushErrorToast } from "../../state/toastStore";
import { useFocusTrap } from "../../lib/useFocusTrap";
import { currentPlatform } from "../../lib/platform";
import { onTerminalExit } from "../../lib/tauri/events";
import { closeTerminal, defaultCloneDir, openInVsCode, revealInFileManager } from "../../lib/tauri/commands";
import { DEFAULT_WORKSPACE_COLOR } from "../../lib/workspaceColors";
import {
  checkDest,
  fetchVersions,
  runScript,
  springGenerate,
  writeFiles,
  type DestCheck,
  type ScaffoldPlatform,
  type SpringRequest,
  type VersionLine,
} from "../../lib/scaffold/api";
import {
  TEMPLATES,
  gitSteps,
  npmNameProblem,
  type Options,
  type OptionValue,
  type PackageManager,
  type Requirement,
  type Template,
  type TemplateContext,
} from "../../lib/scaffold/catalog";
import { buildScript, shellFor } from "../../lib/scaffold/script";
import { pickLine, satisfies } from "../../lib/scaffold/semver";
import { VALID_JAVA_PACKAGE, springPackage } from "../../lib/scaffold/spring";
import { TOOLS, recipesFor, type ToolId } from "../../lib/scaffold/tools";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Button, buttonClass, iconButtonClass, Kbd } from "../common/Button";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { Tooltip } from "../common/Tooltip";
import { fieldClass } from "../common/recipes";
import { EnvironmentPanel, type CheckedRequirement, type InstallRequest } from "./EnvironmentPanel";
import { Field } from "./Field";
import { RunView, type RunStatus } from "./RunView";
import { SpringFields, initialSpring, type SpringState } from "./SpringFields";
import { TemplateList } from "./TemplateList";
import { TemplateLogo } from "./TemplateLogo";
import { TemplateOptions } from "./TemplateOptions";

type Phase =
  | { kind: "form" }
  | {
      kind: "run";
      purpose: "create" | "install";
      title: string;
      /** The template or tool the run is about, for the header's mark. */
      logo?: string;
      logoName: string;
      sessionId: string | null;
      status: RunStatus;
      code: number | null;
      stage: string | null;
      error: string | null;
      /** Set once a project exists: where it is and what to do with it. */
      result?: { root: string; workspace: string | null; run: string | null };
    };

/** The workspace picker's two values that are not workspaces. */
const NO_IMPORT = "__none__";
const NEW_WORKSPACE = "__new__";

function localPlatform(): ScaffoldPlatform {
  const platform = currentPlatform();
  return platform === "windows" || platform === "linux" ? platform : "macos";
}

/** Which line a template's picker starts on: the registry's `latest`, else its first LTS, else the
 *  newest. Never a `next` prerelease — that one has to be chosen on purpose. */
function defaultLine(lines: VersionLine[]): VersionLine | null {
  return lines.find((l) => l.channel === "latest") ?? lines.find((l) => l.channel === "lts") ?? lines.find((l) => l.channel !== "next") ?? null;
}

/**
 * The project initializer: pick a template, answer its few questions, see whether this machine can
 * build it — and install what it cannot, at the version it needs — then generate it in a terminal on
 * screen, make it a repository and import it into whichever workspace the user chose.
 *
 * Opened from the projects panel (unfolded, the rocket beside clone and add; folded, the rocket under
 * the "+"), and from the command palette. Rendered once at the app root, like the pull-request-link
 * dialog, so it is portalled out of the sidebar by construction.
 */
export function ProjectInitModal({ onClose }: { onClose: () => void }) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);

  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const addProject = useWorkspaceStore((s) => s.addProject);
  const addWorkspace = useWorkspaceStore((s) => s.addWorkspace);
  const focusProject = useWorkspaceStore((s) => s.focusProject);
  const setActiveView = useUiStore((s) => s.setActiveView);

  const detectedPlatform = useScaffoldStore((s) => s.platform);
  const tools = useScaffoldStore((s) => s.tools);
  const detecting = useScaffoldStore((s) => s.detecting);
  const detect = useScaffoldStore((s) => s.detect);
  const versions = useScaffoldStore((s) => s.versions);
  const loadVersions = useScaffoldStore((s) => s.loadVersions);
  const springLoad = useScaffoldStore((s) => s.spring);
  const loadSpring = useScaffoldStore((s) => s.loadSpring);
  const loadPrefs = useScaffoldStore((s) => s.loadPrefs);
  const savePrefs = useScaffoldStore((s) => s.savePrefs);
  const platform = detectedPlatform ?? localPlatform();

  const [ready, setReady] = useState(false);
  const [templateId, setTemplateId] = useState(TEMPLATES[0].id);
  const [name, setName] = useState(TEMPLATES[0].defaultName);
  const [nameEdited, setNameEdited] = useState(false);
  const [parent, setParent] = useState("");
  const [sep, setSep] = useState("/");
  /** Every template's choices, kept as the user moves between templates. */
  const [optionsById, setOptionsById] = useState<Record<string, Options>>({});
  const [lineById, setLineById] = useState<Record<string, string>>({});
  const [pm, setPm] = useState<PackageManager>("npm");
  const [spring, setSpring] = useState<SpringState | null>(null);
  const [target, setTarget] = useState<string>(activeWorkspaceId ?? NO_IMPORT);
  const [newWorkspace, setNewWorkspace] = useState("");
  const [commit, setCommit] = useState(true);
  const [dest, setDest] = useState<DestCheck | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "form" });

  const template = TEMPLATES.find((candidate) => candidate.id === templateId) ?? TEMPLATES[0];
  const running = phase.kind === "run" && (phase.status === "preparing" || phase.status === "running");

  // ── Boot: remembered choices, where projects go, and one detection pass per app session ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [prefs, base] = await Promise.all([loadPrefs(), defaultCloneDir().catch(() => ({ root: "", separator: "/" }))]);
      if (cancelled) return;
      setSep(base.separator);
      setParent(prefs.parent || base.root);
      const remembered = TEMPLATES.find((candidate) => candidate.id === prefs.template);
      if (remembered) {
        setTemplateId(remembered.id);
        setName(remembered.defaultName);
      }
      if (prefs.pm) setPm(prefs.pm);
      if (prefs.commit !== undefined) setCommit(prefs.commit);
      if (prefs.options) setOptionsById(prefs.options);
      setReady(true);
    })();
    if (Object.keys(useScaffoldStore.getState().tools).length === 0) void detect(false);
    return () => {
      cancelled = true;
    };
    // Once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusTrap(panelRef, phase.kind === "form");

  /**
   * A beat every few minutes while the dialog is open, re-running the loads below. Each load is a
   * no-op until the answer it holds is an hour old (`scaffoldStore`), so this costs nothing — and it
   * is what makes a release published while the dialog sits open appear in its picker.
   */
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const beat = window.setInterval(() => setTick((n) => n + 1), 5 * 60 * 1000);
    return () => window.clearInterval(beat);
  }, []);

  // ── The chosen template's registries ──
  useEffect(() => {
    if (template.versions) loadVersions(template.versions);
    if (template.engines) loadVersions(template.engines);
    if (template.spring) loadSpring();
  }, [template, loadVersions, loadSpring, tick]);

  const versionLoad = template.versions ? versions[sourceKey(template.versions)] : undefined;
  const lines = useMemo(() => {
    const raw = versionLoad?.data ?? [];
    return raw
      .filter((line) => !template.versionFilter || template.versionFilter(line))
      .map((line) => (template.ltsLine && !line.channel && template.ltsLine(line.line) ? { ...line, channel: "lts" as const } : line));
  }, [versionLoad, template]);
  const version = lines.find((line) => line.line === lineById[template.id]) ?? defaultLine(lines);
  const enginesLoad = template.engines ? versions[sourceKey(template.engines)] : undefined;
  const engines = enginesLoad?.data?.[0] ?? null;

  // Python's interpreter lines, for the templates that let uv fetch one.
  const needsPythonLines = template.options.some((option) => option.kind === "runtime" && option.tool === "python");
  useEffect(() => {
    if (needsPythonLines && TOOLS.python.versions) loadVersions(TOOLS.python.versions);
  }, [needsPythonLines, loadVersions, tick]);
  const pythonLines = (TOOLS.python.versions ? versions[sourceKey(TOOLS.python.versions)]?.data : null) ?? [];

  const present = useMemo(
    () => new Set(Object.values(tools).filter((status) => status.found).map((status) => status.id)),
    [tools],
  );

  // ── This template's options, with defaults that depend on the machine and on the version ──
  const pythonRange = template.id === "fastapi" ? (engines?.requires ?? null) : (version?.requires ?? null);
  const runtimeLines = useMemo(
    () => ({ python: pythonLines.filter((line) => !line.eol && satisfies(line.version, pythonRange, "pep440")) }),
    [pythonLines, pythonRange],
  );
  const opts = useMemo<Options>(() => {
    const chosen = optionsById[template.id] ?? {};
    const out: Options = {};
    for (const option of template.options) {
      const explicit = chosen[option.id];
      if (option.kind === "text") out[option.id] = typeof explicit === "string" ? explicit : option.default(name);
      else if (option.kind === "runtime") {
        const valid = runtimeLines.python.some((line) => line.line === explicit);
        // Empty when the Python lines could not be fetched: the steps then pin the framework's own
        // floor instead (see `pythonSteps`), never a number written here.
        out[option.id] = valid ? String(explicit) : (pickLine(runtimeLines.python, pythonRange, "pep440")?.line ?? "");
      } else if (option.id === "env" && explicit === undefined) {
        // uv when it is here, or when nothing is: it is the route that can also fetch the interpreter.
        out[option.id] = present.has("uv") || !present.has("python") ? "uv" : "venv";
      } else out[option.id] = explicit ?? option.default;
    }
    return out;
  }, [optionsById, template, name, runtimeLines, pythonRange, present]);

  const setOption = (id: string, value: OptionValue) =>
    setOptionsById((all) => ({ ...all, [template.id]: { ...(all[template.id] ?? {}), [id]: value } }));

  const effectivePm: PackageManager = template.pms?.includes(pm) ? pm : (template.pms?.[0] ?? "npm");

  // ── Spring's form, from start.spring.io's metadata ──
  const springMeta = springLoad?.status === "ready" ? springLoad.data : null;
  useEffect(() => {
    if (!template.spring || !springMeta || spring) return;
    const saved = useScaffoldStore.getState().prefs?.options?.spring as Partial<SpringState> | undefined;
    setSpring(initialSpring(springMeta, saved));
  }, [template.spring, springMeta, spring]);
  const springPackageName = spring ? (spring.packageEdited ? spring.packageName : springPackage(spring.groupId, name)) : "";
  const springRequest: SpringRequest | undefined =
    template.spring && spring
      ? {
          type: spring.type,
          language: spring.language,
          bootVersion: spring.bootVersion,
          javaVersion: spring.javaVersion,
          packaging: spring.packaging,
          groupId: spring.groupId,
          artifactId: name,
          name,
          description: name,
          packageName: springPackageName,
          dependencies: spring.dependencies,
        }
      : undefined;

  // ── Where it goes ──
  const trimmedParent = parent.replace(/[\\/]+$/, "");
  const root = trimmedParent && name ? `${trimmedParent}${sep}${name}` : "";
  useEffect(() => {
    if (!parent || !name) {
      setDest(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void checkDest(parent, name)
        .then((check) => !cancelled && setDest(check))
        .catch(() => {});
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [parent, name, phase.kind]);

  const ctx: TemplateContext = {
    name,
    parent: trimmedParent,
    root,
    sep,
    platform,
    version,
    engines,
    opts,
    pm: effectivePm,
    present,
    label: (key) => t(key),
    spring: springRequest,
  };

  // ── What it needs, against what is here ──
  const requirements: Requirement[] = useMemo(() => {
    const list = [...template.requirements(ctx), { tool: "git" as ToolId }];
    return list.filter((req, at) => list.findIndex((other) => other.tool === req.tool) === at);
    // `ctx` is rebuilt every render; these are the parts requirements read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, version, engines, opts, effectivePm, springRequest?.javaVersion, springRequest?.bootVersion]);

  const rows: CheckedRequirement[] = requirements.map((req) => {
    const status = tools[req.tool];
    const problem: CheckedRequirement["problem"] = !status
      ? detecting
        ? null
        : "missing"
      : !status.found
        ? "missing"
        : req.range && status.version && !satisfies(status.version, req.range, TOOLS[req.tool].dialect)
          ? "version"
          : null;
    return { req, status, problem, hint: hintFor(req, status?.version ?? null, problem) };
  });

  /** A way round a failed requirement that is not an install. */
  function hintFor(req: Requirement, found: string | null, problem: CheckedRequirement["problem"]) {
    if (problem === null) return undefined;
    // An older framework line that the installed runtime already satisfies.
    if (problem === "version" && found && template.versions && req.tool !== "git") {
      const dialect = TOOLS[req.tool].dialect;
      const fits = lines.find((line) => line.channel !== "next" && line.requires && satisfies(found, line.requires, dialect));
      if (fits && fits.line !== version?.line)
        return (
          <button type="button" onClick={() => setLineById((all) => ({ ...all, [template.id]: fits.line }))} className="text-[var(--cf-accent)] hover:underline">
            {t("scaffold.hint.useLine", { name: template.name, version: fits.version })}
          </button>
        );
    }
    // Spring: a Java target the installed JDK can compile.
    if (problem === "version" && found && template.spring && spring && springMeta) {
      const installed = Number(found.split(".")[0]);
      const fits = springMeta.javaVersions.map((java) => java.id).find((id) => Number(id) <= installed);
      if (fits)
        return (
          <button type="button" onClick={() => setSpring({ ...spring, javaVersion: fits })} className="text-[var(--cf-accent)] hover:underline">
            {t("scaffold.hint.useJava", { version: fits })}
          </button>
        );
    }
    // Python: uv can fetch the interpreter itself.
    if (req.tool === "python" && opts.env === "venv")
      return (
        <button type="button" onClick={() => setOption("env", "uv")} className="text-[var(--cf-accent)] hover:underline">
          {t("scaffold.hint.useUv")}
        </button>
      );
    return undefined;
  }

  // ── What is wrong with the form ──
  const nameProblem: string | null = !name
    ? t("scaffold.err.name")
    : template.npmName && npmNameProblem(name)
      ? t(npmNameProblem(name) as TranslationKey)
      : dest?.problem ?? null;
  const textProblems: Record<string, string | null> = {};
  for (const option of template.options) {
    if (option.kind === "text" && option.validate) {
      const problem = option.validate(String(opts[option.id] ?? ""));
      textProblems[option.id] = problem ? t(problem) : null;
    }
  }
  const packageProblem = template.spring && spring && !VALID_JAVA_PACKAGE.test(springPackageName) ? t("scaffold.err.javaPackage") : null;
  const envReady = rows.every((row) => row.problem === null) && !detecting && Object.keys(tools).length > 0;
  const blockers = [
    !ready && "loading",
    !!nameProblem && "name",
    !dest && "dest",
    Object.values(textProblems).some(Boolean) && "options",
    !!packageProblem && "package",
    template.spring && !springRequest && "spring",
    versionLoad?.status === "loading" && "versions",
    target === NEW_WORKSPACE && !newWorkspace.trim() && "workspace",
    !envReady && "env",
  ].filter(Boolean);
  const canCreate = blockers.length === 0;

  // ── Running things ──
  /** Exit codes that arrived, by session — an exit can beat the `invoke` that started it. */
  const exits = useRef(new Map<string, number | null>());
  const waiting = useRef<{ id: string; resolve: (code: number | null) => void } | null>(null);
  const liveSession = useRef<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void onTerminalExit((event) => {
      exits.current.set(event.id, event.code ?? null);
      const pending = waiting.current;
      if (pending && pending.id === event.id) {
        waiting.current = null;
        pending.resolve(event.code ?? null);
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
      // A dialog torn down mid-run (the window closing) takes its process with it.
      if (liveSession.current) void closeTerminal(liveSession.current).catch(() => {});
    };
  }, []);

  const patchRun = useCallback(
    (patch: Partial<Extract<Phase, { kind: "run" }>>) =>
      setPhase((current) => (current.kind === "run" ? { ...current, ...patch } : current)),
    [],
  );

  /** Runs `script` in a pty from `cwd` and resolves with its exit code (`null`: stopped). */
  const runShell = async (cwd: string, script: string): Promise<number | null> => {
    // Before the pty exists, so its first bytes are held for the pane rather than dropped.
    startTerminalRouter();
    const id = await runScript(cwd, script);
    liveSession.current = id;
    patchRun({ sessionId: id, status: "running", stage: null });
    const code = await new Promise<number | null>((resolve) => {
      if (exits.current.has(id)) resolve(exits.current.get(id) ?? null);
      else waiting.current = { id, resolve };
    });
    liveSession.current = null;
    return code;
  };

  const labels = { skipped: t("scaffold.run.skipped"), done: t("scaffold.run.done") };

  const install = async (request: InstallRequest): Promise<boolean> => {
    const info = TOOLS[request.tool];
    setPhase({
      kind: "run",
      purpose: "install",
      title: t("scaffold.run.installing", { name: request.label }),
      logo: info.logo,
      logoName: info.name,
      sessionId: null,
      status: "preparing",
      code: null,
      stage: null,
      error: null,
    });
    try {
      const script = buildScript(shellFor(platform), request.steps, labels);
      const code = await runShell(await homeDir(), script);
      if (code !== 0) {
        patchRun({ status: "failed", code });
        return false;
      }
      patchRun({ stage: t("scaffold.run.rechecking") });
      await detect(true);
      patchRun({ status: "ok", stage: null });
      return true;
    } catch (e) {
      patchRun({ status: "failed", error: String(e) });
      return false;
    }
  };

  /** Everything missing, one tool at a time, re-detecting between them — so a runtime installed
   *  first is the one the next install (a package manager through npm, say) runs on. */
  const installAll = async () => {
    for (const row of rows) {
      if (row.problem === null) continue;
      const { tools: now } = useScaffoldStore.getState();
      const status = now[row.req.tool];
      const dialect = TOOLS[row.req.tool].dialect;
      if (status?.found && (!row.req.range || !status.version || satisfies(status.version, row.req.range, dialect))) continue;
      const info = TOOLS[row.req.tool];
      const available = info.versions ? await fetchVersions(info.versions).catch(() => []) : [];
      const line = pickLine(available, row.req.range ?? null, dialect);
      const nowPresent = new Set(Object.values(now).filter((tool) => tool.found).map((tool) => tool.id));
      const recipes = recipesFor(row.req.tool, { platform, present: nowPresent, line: line?.line, lts: line ? line.channel === "lts" : undefined });
      const preferred = useScaffoldStore.getState().prefs?.recipes?.[row.req.tool];
      const recipe = recipes.find((r) => r.id === preferred) ?? recipes[0];
      if (!recipe) continue;
      const ok = await install({ tool: row.req.tool, steps: recipe.steps, label: line && info.versions ? `${info.name} ${line.line}` : info.name });
      if (!ok) return;
    }
  };

  const create = async () => {
    if (!canCreate) return;
    const plan = template.plan(ctx);
    savePrefs({
      template: template.id,
      parent: trimmedParent,
      pm: effectivePm,
      commit,
      options: {
        ...optionsById,
        // Text answers follow the name (a Go module path), so they are not carried to the next one.
        [template.id]: Object.fromEntries(
          Object.entries(optionsById[template.id] ?? {}).filter(([id]) => template.options.find((o) => o.id === id)?.kind !== "text"),
        ),
        ...(spring
          ? { spring: { type: spring.type, language: spring.language, javaVersion: spring.javaVersion, packaging: spring.packaging, groupId: spring.groupId, dependencies: spring.dependencies } as unknown as Options }
          : {}),
      },
    });
    setPhase({
      kind: "run",
      purpose: "create",
      title: t("scaffold.run.creating", { name }),
      logo: template.logo,
      logoName: template.name,
      sessionId: null,
      status: "preparing",
      code: null,
      stage: null,
      error: null,
    });
    try {
      if (plan.spring) {
        patchRun({ stage: t("scaffold.run.spring") });
        await springGenerate(plan.spring, trimmedParent, name);
      }
      if (plan.files?.length) {
        patchRun({ stage: t("scaffold.run.files") });
        await writeFiles(root, plan.files);
      }
      const script = buildScript(shellFor(platform), [...plan.steps, ...gitSteps(root, (key) => t(key), commit)], labels);
      const code = await runShell(trimmedParent, script);
      if (code !== 0) {
        patchRun({ status: "failed", code });
        return;
      }

      let workspace: string | null = null;
      if (target !== NO_IMPORT) {
        patchRun({ stage: t("scaffold.run.importing") });
        let workspaceId = target;
        if (target === NEW_WORKSPACE) {
          const created = await addWorkspace(newWorkspace.trim(), "briefcase", "#6366f1");
          workspaceId = created.id;
          workspace = created.name;
        } else workspace = workspaces.find((w) => w.id === target)?.name ?? null;
        const project = await addProject({
          workspace_id: workspaceId,
          name,
          local_path: root,
          remote_url: null,
          color: DEFAULT_WORKSPACE_COLOR,
          icon: "git-branch",
          ado_org: null,
          ado_project: null,
          ado_repo_id: null,
          github_owner: null,
          github_repo: null,
          github_host: null,
          gitlab_project: null,
          gitlab_host: null,
        });
        await focusProject(workspaceId, project.id);
      }
      patchRun({ status: "ok", stage: null, result: { root, workspace, run: plan.run ?? null } });
    } catch (e) {
      patchRun({ status: "failed", error: String(e) });
    }
  };

  const stop = () => {
    if (phase.kind === "run" && phase.sessionId) void closeTerminal(phase.sessionId).catch(() => {});
  };

  const backToForm = () => {
    setPhase({ kind: "form" });
    // Whatever just ran may have created the folder, or installed the tool; look again.
    setDest(null);
  };

  const another = () => {
    setNameEdited(false);
    setName(template.defaultName);
    backToForm();
  };

  // Escape closes the form; while something runs, the terminal owns the keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || phase.kind !== "form") return;
      // An Escape something inside already answered — an open select closing its menu — is not
      // also a request to close the dialog.
      if (e.defaultPrevented || (e.target as HTMLElement | null)?.closest?.(".xterm")) return;
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase.kind, onClose]);

  const pickTemplate = (next: Template) => {
    setTemplateId(next.id);
    if (!nameEdited) setName(next.defaultName);
  };

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false, defaultPath: parent || undefined, title: t("scaffold.location") });
    if (typeof picked === "string") setParent(picked);
  };

  const workspaceOptions = [
    ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name })),
    { value: NEW_WORKSPACE, label: t("scaffold.ws.new") },
    { value: NO_IMPORT, label: t("scaffold.ws.none") },
  ];

  const versionOptions = lines.map((line) => ({
    value: line.line,
    label: `${line.version}${
      line.channel === "latest" ? ` · ${t("scaffold.channel.latest")}` : line.channel === "lts" ? " · LTS" : line.channel === "next" ? " · next" : ""
    }${line.eol ? ` · ${t("scaffold.eol")}` : ""}`,
  }));

  const blockerHint =
    !envReady && !detecting
      ? t("scaffold.blocked.env")
      : nameProblem
        ? nameProblem
        : Object.values(textProblems).find(Boolean) ?? packageProblem ?? (target === NEW_WORKSPACE && !newWorkspace.trim() ? t("scaffold.blocked.workspace") : null);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("scaffold.title")}
        tabIndex={-1}
        data-tour="scaffold-dialog"
        className="cf-fade-in flex h-[680px] max-h-[90vh] w-[1000px] max-w-[94vw] flex-col overflow-hidden rounded-[14px] border border-[var(--cf-border)] bg-[var(--cf-surface)] shadow-[var(--cf-shadow-modal)]"
      >
        {phase.kind === "run" ? (
          <RunView
            icon={<TemplateLogo logo={phase.logo} name={phase.logoName} size={18} />}
            title={phase.title}
            sessionId={phase.sessionId}
            status={phase.status}
            code={phase.code}
            stage={phase.stage}
            error={phase.error}
            footer={
              running ? (
                <Button variant="ghost" onClick={stop} disabled={!phase.sessionId}>
                  {t("scaffold.run.stop")}
                </Button>
              ) : phase.status === "failed" ? (
                <>
                  {phase.purpose === "create" && root && (
                    <Button variant="ghost" onClick={() => void revealInFileManager(root).catch((e) => pushErrorToast(String(e)))}>
                      <FolderSearch size={13} />
                      {t("scaffold.done.reveal")}
                    </Button>
                  )}
                  <Button variant="primary" onClick={backToForm}>
                    {t("scaffold.run.back")}
                  </Button>
                </>
              ) : phase.purpose === "install" ? (
                <Button variant="primary" onClick={backToForm}>
                  {t("scaffold.run.continue")}
                </Button>
              ) : (
                <DoneActions
                  result={phase.result ?? null}
                  onEditor={() => {
                    setActiveView("editor");
                    onClose();
                  }}
                  onAnother={another}
                  onClose={onClose}
                />
              )
            }
          />
        ) : (
          <>
            <div className="flex h-12 shrink-0 items-center gap-2.5 border-b border-[var(--cf-border)] pl-4 pr-3">
              <Rocket size={15} className="text-[var(--cf-accent)]" />
              <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold text-[var(--cf-text)]">{t("scaffold.title")}</h2>
              <Tooltip label={t("common.close")} trailing={<Kbd>esc</Kbd>} side="bottom">
                <button type="button" onClick={onClose} aria-label={t("common.close")} className={iconButtonClass({ size: "md" })}>
                  <X size={15} />
                </button>
              </Tooltip>
            </div>
            <div className="flex min-h-0 flex-1">
              <TemplateList selected={template.id} onSelect={pickTemplate} disabled={false} />
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border border-[var(--cf-border)] bg-[var(--cf-sunken)]">
                      <TemplateLogo logo={template.logo} name={template.name} size={22} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate text-[15px] font-semibold text-[var(--cf-text)]">{template.name}</h3>
                      <p className="truncate text-[12px] text-[var(--cf-text-muted)]">{t(template.descriptionKey)}</p>
                    </div>
                    {template.versions && (
                      <div className="w-[230px] shrink-0">
                        <Select
                          size="sm"
                          value={version?.line ?? ""}
                          onChange={(line) => setLineById((all) => ({ ...all, [template.id]: line }))}
                          ariaLabel={t("scaffold.version")}
                          disabled={versionLoad?.status !== "ready" || lines.length === 0}
                          placeholder={versionLoad?.status === "error" ? t("scaffold.latest") : t("scaffold.loading")}
                          options={versionOptions}
                        />
                        {versionLoad?.status === "error" && (
                          <p className="mt-1 truncate text-[11px] text-[var(--cf-warning)]" title={versionLoad.error ?? undefined}>
                            {t("scaffold.versionsOffline")}
                          </p>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="space-y-2.5">
                    <Field label={t("scaffold.name")} error={nameProblem} hint={nameProblem ? null : root}>
                      <input
                        autoFocus
                        value={name}
                        onChange={(e) => {
                          setName(e.target.value.trim());
                          setNameEdited(true);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && canCreate) void create();
                        }}
                        spellCheck={false}
                        className={fieldClass({ size: "sm", className: "w-full font-mono" })}
                      />
                    </Field>
                    <Field label={t("scaffold.location")}>
                      <div className="flex min-w-0 gap-1.5">
                        <input
                          value={parent}
                          onChange={(e) => setParent(e.target.value)}
                          spellCheck={false}
                          className={fieldClass({ size: "sm", className: "min-w-0 flex-1 font-mono" })}
                        />
                        <Tooltip label={t("scaffold.browse")} side="top">
                          <button type="button" onClick={() => void browse()} aria-label={t("scaffold.browse")} className={iconButtonClass({ size: "sm" })}>
                            <FolderOpen size={14} />
                          </button>
                        </Tooltip>
                      </div>
                    </Field>
                    {template.spring ? (
                      springMeta && spring ? (
                        <SpringFields
                          meta={springMeta}
                          value={spring}
                          packageName={springPackageName}
                          onChange={(patch) => setSpring((current) => (current ? { ...current, ...patch } : current))}
                          packageProblem={packageProblem}
                        />
                      ) : (
                        <Field label="start.spring.io">
                          <span className={`text-[12px] ${springLoad?.status === "error" ? "text-[var(--cf-danger)]" : "text-[var(--cf-text-muted)]"}`}>
                            {springLoad?.status === "error" ? springLoad.error : t("scaffold.loading")}
                          </span>
                        </Field>
                      )
                    ) : (
                      <TemplateOptions
                        template={template}
                        opts={opts}
                        onChange={setOption}
                        pm={effectivePm}
                        onPm={setPm}
                        runtimeLines={runtimeLines}
                        problems={textProblems}
                      />
                    )}
                  </div>

                  <EnvironmentPanel rows={rows} platform={platform} onInstall={(request) => void install(request)} onInstallAll={() => void installAll()} />
                </div>

                <div className="flex h-14 shrink-0 items-center gap-3 border-t border-[var(--cf-border)] px-4">
                  <span className="shrink-0 text-[12px] text-[var(--cf-text-muted)]">{t("scaffold.ws.label")}</span>
                  <div className="w-[170px] shrink-0">
                    <Select size="sm" value={target} onChange={setTarget} options={workspaceOptions} ariaLabel={t("scaffold.ws.label")} />
                  </div>
                  {target === NEW_WORKSPACE && (
                    <input
                      value={newWorkspace}
                      onChange={(e) => setNewWorkspace(e.target.value)}
                      placeholder={t("scaffold.ws.newName")}
                      className={fieldClass({ size: "sm", className: "w-[150px]" })}
                    />
                  )}
                  <Tooltip label={t("scaffold.commit")} description={t("scaffold.commitHint")} side="top">
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
                      <Checkbox checked={commit} onChange={setCommit} />
                      {t("scaffold.commit")}
                    </label>
                  </Tooltip>
                  <span className="min-w-0 flex-1" />
                  <Button variant="ghost" onClick={onClose}>
                    {t("common.cancel")}
                  </Button>
                  <Tooltip label={canCreate ? t("scaffold.create") : (blockerHint ?? t("scaffold.create"))} side="top">
                    <span className="inline-flex">
                      <button type="button" disabled={!canCreate} onClick={() => void create()} className={buttonClass({ variant: "primary" })}>
                        <Rocket size={13} />
                        {t("scaffold.create")}
                      </button>
                    </span>
                  </Tooltip>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The finished project: where it is, where it was imported, how to start it, and what next. */
function DoneActions({
  result,
  onEditor,
  onAnother,
  onClose,
}: {
  result: { root: string; workspace: string | null; run: string | null } | null;
  onEditor: () => void;
  onAnother: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <>
      <div className="mr-auto min-w-0 truncate text-[12px] text-[var(--cf-text-muted)]">
        {result?.workspace ? t("scaffold.done.imported", { workspace: result.workspace }) : t("scaffold.done.notImported")}
        {result?.run && (
          <>
            {" · "}
            <code className="rounded bg-[var(--cf-hover)] px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--cf-text)]">{result.run}</code>
          </>
        )}
      </div>
      {result && (
        <>
          <Button variant="ghost" onClick={() => void revealInFileManager(result.root).catch((e) => pushErrorToast(String(e)))}>
            <FolderSearch size={13} />
            {t("scaffold.done.reveal")}
          </Button>
          <Button variant="ghost" onClick={() => void openInVsCode(result.root).catch((e) => pushErrorToast(String(e)))}>
            <Code2 size={13} />
            VS Code
          </Button>
        </>
      )}
      <Button variant="ghost" onClick={onAnother}>
        {t("scaffold.done.another")}
      </Button>
      {result?.workspace ? (
        <Button variant="primary" onClick={onEditor}>
          {t("scaffold.done.editor")}
        </Button>
      ) : (
        <Button variant="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      )}
    </>
  );
}
