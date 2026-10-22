import { useRepoStore } from "../../../state/repoStore";
import { canPublishRepo, canPull, canPush, headBranch, restartAutoFetchCountdown } from "../../gitActions";
import { CodiError, type CodiAction } from "../registry";
import { defineAction, flag, params, requireProject, say, text } from "./shared";

/**
 * Fetch, pull, push and commit — on the repository of the window asked, through its own `repoStore`
 * (a repository island has its own; see `codeflow-satellite-windows`).
 *
 * The rules for when each is possible are `gitActions`' — the same ones that grey out the status
 * bar's buttons and silence the shortcuts — read here before acting, so Codi can *say* why nothing
 * happened ("there is nothing to pull") instead of reporting a success the shortcut's silent no-op
 * would have implied. The work itself is the store's, awaited: `fetchNow` and friends fire and
 * forget, which suits a keystroke and not an answer.
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

export function gitActions(): CodiAction[] {
  return [
    defineAction({
      id: "git.fetch",
      title: { en: "Fetch the open repository's remotes.", es: "Hace fetch de los remotos del repositorio abierto." },
      aliases: { es: ["haz fetch", "fetch", "trae del remoto", "actualiza del remoto", "busca cambios en el remoto", "sincroniza"], en: ["fetch", "do a fetch", "check the remote", "fetch the remote"] },
      params: params(),
      risk: "write",
      where: "any",
      frequent: true,
      run: async () => {
        const project = requireRepo();
        await useRepoStore.getState().fetch();
        restartAutoFetchCountdown();
        const state = branchState();
        return {
          result: state,
          say: state.behind > 0
            ? say("codi.say.fetchedBehind", { name: project.name, n: state.behind })
            : say("codi.say.fetched", { name: project.name }),
        };
      },
    }),
    defineAction({
      id: "git.pull",
      title: { en: "Pull the current branch from its upstream.", es: "Hace pull de la rama actual desde su upstream." },
      aliases: { es: ["haz pull", "pull", "baja los cambios", "trae los cambios", "actualiza la rama", "jala los cambios"], en: ["pull", "do a pull", "pull the changes", "update the branch"] },
      params: params(),
      risk: "write",
      where: "any",
      frequent: true,
      run: async () => {
        requireRepo();
        const head = headBranch();
        if (!head?.upstream) throw new CodiError("the current branch tracks no remote branch", say("codi.say.noUpstream"));
        if (!canPull(head)) return { result: { ...branchState(), pulled: false }, say: say("codi.say.nothingToPull") };
        await useRepoStore.getState().pull();
        const state = branchState();
        return { result: { ...state, pulled: true }, say: say("codi.say.pulled", { name: state.branch ?? "" }) };
      },
    }),
    defineAction({
      id: "git.push",
      title: {
        en: "Push the current branch to its upstream — or publish it when it has none. Asks the user first.",
        es: "Hace push de la rama actual a su upstream, o la publica si no tiene. Pide confirmación al usuario.",
      },
      aliases: { es: ["haz push", "push", "sube los cambios", "sube la rama", "publica la rama", "empuja los cambios"], en: ["push", "do a push", "push the changes", "publish the branch", "push the branch"] },
      params: params(),
      risk: "destructive",
      where: "any",
      frequent: true,
      run: async () => {
        requireRepo();
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
      },
    }),
    defineAction({
      id: "git.commit",
      title: {
        en: "Commit what is staged, with this message. all stages every change first when nothing is staged.",
        es: "Hace commit de lo preparado, con este mensaje. all prepara todos los cambios antes si no hay nada preparado.",
      },
      aliases: { es: ["haz commit", "commit", "haz un commit", "confirma los cambios", "guarda los cambios en git", "commitea"], en: ["commit", "make a commit", "commit the changes", "commit this"] },
      params: params(
        { message: text("The commit message."), all: flag("Stage every change first when nothing is staged.") },
        ["message"],
      ),
      risk: "write",
      where: "any",
      frequent: true,
      run: async ({ message, all }) => {
        requireRepo();
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
