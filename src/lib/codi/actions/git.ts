import { useRepoStore } from "../../../state/repoStore";
import { useWorkspaceStore } from "../../../state/workspaceStore";
import { notify } from "../../../state/notificationStore";
import { translate } from "../../../state/languageStore";
import { canPublishRepo, canPull, canPush, headBranch, restartAutoFetchCountdown } from "../../gitActions";
import { describeGitError, GIT_ERROR, hasTag, stoppedOperation } from "../../gitErrors";
import { gitFetch, gitPull, gitPush, listBranches } from "../../tauri/commands";
import { CodiError, type CodiAction, type CodiOutcome } from "../registry";
import type { BranchInfo, Project } from "../../../types/domain";
import { answerOrTell as answerOrTellAs, closedReason, defineAction, findRepoToAct, flag, optionalText, params, requireProject, say, text, workspaceName } from "./shared";

/**
 * Fetch, pull, push and commit — on the repository of the window asked, or on one named by voice
 * («haz pull del repositorio node core», user report 2026-10-22).
 *
 * **The repository on screen** goes through its own `repoStore` (a repository island has its own;
 * see `codeflow-satellite-windows`), so its dialogs — the diverged pull's question, the force push
 * with lease, the publish — and its conflicts banner are the ones the buttons have. The rules for
 * when each is possible are `gitActions`' — the same ones that grey out the status bar's buttons —
 * read here before acting, so Codi can *say* why nothing happened ("there is nothing to pull")
 * instead of reporting a success the shortcut's silent no-op would have implied.
 *
 * **Any other repository** is worked on where it lies, without switching the screen to it: the same
 * backend commands on its folder, its branch read fresh. What needs the repository open to be
 * answered — a pull that diverged or stopped on conflicts, a push the remote rejected, a branch to
 * publish — is said, and opening it offered. Found only in another workspace, it is asked about first.
 *
 * A remote can take longer than the turn waits for an answer: past `shared.ANSWER_WITHIN_MS` Codi says
 * it is still at it, and tells how it went when it lands.
 */

/** Where the branch on screen stands against its remote, for the engine. */
function branchState() {
  const head = headBranch();
  const { status, error } = useRepoStore.getState();
  return {
    branch: status?.current_branch ?? head?.name ?? null,
    ahead: head?.ahead ?? 0,
    behind: head?.behind ?? 0,
    ...(error ? { error } : {}),
  };
}

/** The repository of this window, with its path loaded — or a refusal. */
function requireRepo() {
  const project = requireProject();
  if (!useRepoStore.getState().repoPath) throw new CodiError(`${project.name} is still loading`);
  return project;
}

type Op = "fetch" | "pull" | "push" | "commit";

/** The repository an order is for: the one on screen (`open`), or the one it names. */
async function target(op: Op, args: Record<string, unknown>): Promise<{ project: Project; open: boolean }> {
  const named = typeof args.repo === "string" && args.repo.trim() ? args.repo.trim() : null;
  const inWorkspace = typeof args.workspace === "string" && args.workspace.trim() ? args.workspace : null;
  if (!named && !inWorkspace) return { project: requireRepo(), open: true };
  if (!named) throw new CodiError("which repository?", say("codi.say.whichRepoIn", { workspace: String(inWorkspace) }));
  // A commit is only ever made on screen, so what a yes leads to there is opening the repository.
  const project = await findRepoToAct(
    named,
    inWorkspace,
    (p) => (op === "commit" ? openOffer(p) : { action: `git.${op}`, params: { ...args, repo: p.name, workspace: workspaceName(p.workspace_id) } }),
    (p) => say(op === "commit" ? "codi.say.repoElsewhere" : "codi.say.gitElsewhere", { name: p.name, workspace: workspaceName(p.workspace_id), op }),
  );
  if (project.id === useWorkspaceStore.getState().activeProject()?.id) return { project: requireRepo(), open: true };
  const closed = closedReason(project);
  if (closed === "missing" || closed === "notARepo") {
    throw new CodiError(`${project.name} cannot be worked on: its folder is gone or is no longer a git repository`, say("codi.say.repoGone", { name: project.name }));
  }
  return { project, open: false };
}

/** «Open it?» — for what only the repository on screen can answer. */
function openOffer(project: Project) {
  return { action: "repo.switch", params: { name: project.name, workspace: workspaceName(project.workspace_id) } };
}

/** The branch checked out in `path`, read now. */
async function headOf(path: string): Promise<BranchInfo | null> {
  return (await listBranches(path)).find((b) => b.is_head) ?? null;
}

/** git's reason, as the app says it, in one line short enough to be said. */
function reasonOf(error: unknown): string {
  const line = describeGitError(error, translate).split("\n")[0].trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

/** The bell's line for work done on a repository not on screen — what the store files for its own. */
function filed(project: Project, branch: string | null | undefined, titleKey: Parameters<typeof notify>[0]["titleKey"], ok: boolean) {
  notify({ source: "git", titleKey, status: ok ? "success" : "error", detail: [project.name, branch].filter(Boolean).join(" · "), workspaceId: project.workspace_id });
}

/** `work`'s answer, or «sigo con el pull…» and its answer told when it lands (`shared.answerOrTell`). */
function answerOrTell(work: Promise<CodiOutcome>, op: Op, name: string): Promise<CodiOutcome> {
  return answerOrTellAs(work, {
    source: `git:${name}`,
    still: { result: { running: op, repo: name }, say: say("codi.say.gitStillRunning", { op, name }) },
    failed: (error) => say("codi.say.gitFailed", { op, name, reason: reasonOf(error) }),
  });
}

async function fetchElsewhere(project: Project): Promise<CodiOutcome> {
  try {
    await gitFetch(project.local_path);
  } catch (error) {
    filed(project, null, "notifications.gitFetchFailed", false);
    throw new CodiError(`the fetch of ${project.name} failed: ${String(error)}`, say("codi.say.gitFailed", { op: "fetch", name: project.name, reason: reasonOf(error) }));
  }
  const head = await headOf(project.local_path);
  filed(project, head?.name, "notifications.gitFetched", true);
  const behind = head?.behind ?? 0;
  return {
    result: { repo: project.name, branch: head?.name ?? null, behind },
    say: behind > 0 ? say("codi.say.fetchedBehind", { name: project.name, n: behind }) : say("codi.say.fetched", { name: project.name }),
  };
}

async function pullElsewhere(project: Project): Promise<CodiOutcome> {
  const before = await headOf(project.local_path);
  if (!before?.upstream) {
    throw new CodiError(`${project.name}'s branch tracks no remote branch`, say("codi.say.noUpstreamIn", { name: project.name, branch: before?.name ?? "" }));
  }
  try {
    await gitPull(project.local_path);
  } catch (error) {
    // Both need the repository on screen: the question of how to join them, the conflicts banner.
    if (hasTag(error, GIT_ERROR.pullDiverged)) {
      throw new CodiError(
        `${project.name}'s branch and its upstream have diverged — merge or rebase is the user's choice, with the repository open`,
        say("codi.say.pullDiverged", { name: project.name }),
        openOffer(project),
      );
    }
    if (stoppedOperation(error)) {
      throw new CodiError(`the pull of ${project.name} stopped on conflicts`, say("codi.say.pullConflicts", { name: project.name }), openOffer(project));
    }
    filed(project, before.name, "notifications.gitPullFailed", false);
    throw new CodiError(`the pull of ${project.name} failed: ${String(error)}`, say("codi.say.gitFailed", { op: "pull", name: project.name, reason: reasonOf(error) }));
  }
  const after = await headOf(project.local_path);
  const moved = after?.target !== before.target;
  filed(project, before.name, "notifications.gitPulled", true);
  return {
    result: { repo: project.name, branch: before.name, pulled: moved },
    say: moved ? say("codi.say.pulledRepo", { name: project.name, branch: before.name }) : say("codi.say.upToDate", { name: project.name }),
  };
}

async function pushElsewhere(project: Project): Promise<CodiOutcome> {
  const head = await headOf(project.local_path);
  if (!head) throw new CodiError(`${project.name} has no branch checked out`, say("codi.say.noUpstreamIn", { name: project.name, branch: "" }));
  if (!head.upstream) {
    // Publishing asks where (an account, a URL): the dialogs of the repository on screen.
    throw new CodiError(`${head.name} of ${project.name} is not published yet — that is done with the repository open`, say("codi.say.publishIn", { name: project.name, branch: head.name }), openOffer(project));
  }
  if (head.is_locked) throw new CodiError(`${head.name} is locked against pushes`, say("codi.say.branchLocked", { name: head.name }));
  if (head.ahead === 0) return { result: { repo: project.name, branch: head.name, pushed: false }, say: say("codi.say.nothingToPushIn", { name: project.name }) };
  try {
    await gitPush(project.local_path, false);
  } catch (error) {
    // A force push with lease is offered only behind a danger confirmation, on screen.
    if (hasTag(error, GIT_ERROR.pushRejected)) {
      throw new CodiError(`the remote rejected the push of ${project.name}`, say("codi.say.pushRejected", { name: project.name }), openOffer(project));
    }
    filed(project, head.name, "notifications.gitPushFailed", false);
    throw new CodiError(`the push of ${project.name} failed: ${String(error)}`, say("codi.say.gitFailed", { op: "push", name: project.name, reason: reasonOf(error) }));
  }
  filed(project, head.name, "notifications.gitPushed", true);
  return { result: { repo: project.name, branch: head.name, pushed: true }, say: say("codi.say.pushedRepo", { name: project.name, branch: head.name }) };
}

const repoParams = {
  repo: optionalText("The repository, as said; left out, the one on screen. Another one is worked on without switching to it."),
  workspace: optionalText("The workspace it is in, when the user said it (or said yes to it)."),
};

export function gitActions(): CodiAction[] {
  return [
    defineAction({
      id: "git.fetch",
      title: {
        en: "Fetch a repository's remotes — the one on screen, or `repo` by name (any workspace), without switching to it.",
        es: "Hace fetch de los remotos de un repositorio: el de la pantalla, o `repo` por nombre (cualquier workspace), sin cambiarse a él.",
      },
      aliases: {
        es: ["haz fetch", "fetch", "fech", "trae del remoto", "actualiza del remoto", "busca cambios en el remoto", "sincroniza"],
        en: ["fetch", "do a fetch", "check the remote", "fetch the remote"],
      },
      params: params(repoParams),
      risk: "write",
      where: "any",
      frequent: true,
      run: async (args) => {
        const { project, open } = await target("fetch", args);
        if (!open) return answerOrTell(fetchElsewhere(project), "fetch", project.name);
        const work = (async (): Promise<CodiOutcome> => {
          await useRepoStore.getState().fetch();
          restartAutoFetchCountdown();
          const state = branchState();
          return {
            result: state,
            say: state.behind > 0 ? say("codi.say.fetchedBehind", { name: project.name, n: state.behind }) : say("codi.say.fetched", { name: project.name }),
          };
        })();
        return answerOrTell(work, "fetch", project.name);
      },
    }),
    defineAction({
      id: "git.pull",
      title: {
        en: "Pull the current branch from its upstream — of the repository on screen, or of `repo` by name (any workspace), without switching to it. Speech recognition often writes «pull» as «pool».",
        es: "Hace pull de la rama actual desde su upstream: del repositorio de la pantalla, o de `repo` por nombre (cualquier workspace), sin cambiarse a él. El reconocimiento de voz suele escribir «pull» como «pool».",
      },
      aliases: {
        es: ["haz pull", "pull", "pool", "pul", "baja los cambios", "trae los cambios", "actualiza la rama", "jala los cambios"],
        en: ["pull", "do a pull", "pull the changes", "update the branch"],
      },
      params: params(repoParams),
      risk: "write",
      where: "any",
      frequent: true,
      run: async (args) => {
        const { project, open } = await target("pull", args);
        if (!open) return answerOrTell(pullElsewhere(project), "pull", project.name);
        const work = (async (): Promise<CodiOutcome> => {
          if (!headBranch()?.upstream) throw new CodiError("the current branch tracks no remote branch", say("codi.say.noUpstream"));
          // What the remote has is known as of the last fetch: asked to pull, ask the remote first.
          if (!canPull(headBranch())) await useRepoStore.getState().fetch();
          if (!canPull(headBranch())) return { result: { ...branchState(), pulled: false }, say: say("codi.say.nothingToPull") };
          await useRepoStore.getState().pull();
          const state = branchState();
          return { result: { ...state, pulled: true }, say: say("codi.say.pulled", { name: state.branch ?? "" }) };
        })();
        return answerOrTell(work, "pull", project.name);
      },
    }),
    defineAction({
      id: "git.push",
      title: {
        en: "Push the current branch to its upstream — or publish it when it has none — of the repository on screen, or of `repo` by name (any workspace), without switching to it. Asks the user first.",
        es: "Hace push de la rama actual a su upstream, o la publica si no tiene, del repositorio de la pantalla o de `repo` por nombre (cualquier workspace), sin cambiarse a él. Pide confirmación al usuario.",
      },
      aliases: {
        es: ["haz push", "push", "puch", "sube los cambios", "sube la rama", "publica la rama", "empuja los cambios"],
        en: ["push", "do a push", "push the changes", "publish the branch", "push the branch"],
      },
      params: params(repoParams),
      risk: "destructive",
      where: "any",
      frequent: true,
      run: async (args) => {
        const { project, open } = await target("push", args);
        if (!open) return answerOrTell(pushElsewhere(project), "push", project.name);
        const work = (async (): Promise<CodiOutcome> => {
          const head = headBranch();
          if (canPublishRepo()) {
            await useRepoStore.getState().push(true);
            const state = branchState();
            return { result: { ...state, published: true }, say: say("codi.say.published", { name: state.branch ?? "" }) };
          }
          if (head?.is_locked) throw new CodiError(`${head.name} is locked against pushes`, say("codi.say.branchLocked", { name: head.name }));
          if (!canPush(head)) return { result: { ...branchState(), pushed: false }, say: say("codi.say.nothingToPush") };
          await useRepoStore.getState().push(false);
          const state = branchState();
          if (state.ahead > 0) {
            throw new CodiError(`the push did not complete${state.error ? `: ${state.error}` : ""}`, say("codi.say.pushFailed"));
          }
          return { result: { ...state, pushed: true }, say: say("codi.say.pushed", { name: state.branch ?? "" }) };
        })();
        return answerOrTell(work, "push", project.name);
      },
    }),
    defineAction({
      id: "git.commit",
      title: {
        en: "Commit what is staged in the repository on screen, with this message. all stages every change first when nothing is staged. A `repo` that is not the one on screen is offered to be opened first — a commit is made where its changes can be seen.",
        es: "Hace commit de lo preparado en el repositorio de la pantalla, con este mensaje. all prepara todos los cambios antes si no hay nada preparado. Si `repo` no es el de la pantalla, ofrece abrirlo antes: un commit se hace donde se ven sus cambios.",
      },
      aliases: {
        es: ["haz commit", "commit", "comit", "haz un commit", "confirma los cambios", "guarda los cambios en git", "commitea", "comitea"],
        en: ["commit", "make a commit", "commit the changes", "commit this"],
      },
      params: params(
        { message: text("The commit message."), all: flag("Stage every change first when nothing is staged."), ...repoParams },
        ["message"],
      ),
      risk: "write",
      where: "any",
      frequent: true,
      run: async (args) => {
        const { project, open } = await target("commit", args);
        if (!open) {
          throw new CodiError(`${project.name} is not on screen — a commit is made with the repository open`, say("codi.say.commitOpenFirst", { name: project.name }), openOffer(project));
        }
        const { message, all } = args;
        const repo = useRepoStore.getState();
        let staged = repo.status?.staged.length ?? 0;
        if (staged === 0 && all === true) {
          await repo.stageAll();
          staged = useRepoStore.getState().status?.staged.length ?? 0;
        }
        if (staged === 0) {
          throw new CodiError(
            all === true ? "there is nothing to commit" : "nothing is staged — pass all: true to stage every change first",
            say("codi.say.nothingToCommit"),
          );
        }
        const landed = await useRepoStore.getState().commitChanges(String(message));
        if (!landed) {
          const error = useRepoStore.getState().error;
          throw new CodiError(`the commit did not go through${error ? `: ${error}` : ""}`, say("codi.say.commitFailed"));
        }
        return { result: { committed: staged, ...branchState() }, say: say("codi.say.committed") };
      },
    }),
  ];
}
