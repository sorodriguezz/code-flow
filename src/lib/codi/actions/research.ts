import { useWorkspaceStore } from "../../../state/workspaceStore";
import { CodiError, type CodiAction } from "../registry";
import { defineAction, findProject, flag, optionalText, params, pickByName, requireWorkspace, say, text, workspaceName } from "./shared";

/**
 * Questions about what the app knows, answered in the background without touching the screen — a
 * repository's code («¿qué base de datos ocupa api-pagos?», «¿qué hace el endpoint de reembolsos del
 * repositorio X del workspace Y?») and a workspace's notes, meetings, documents and stories («¿qué
 * decidimos sobre el login?») (user, 2026-10-22).
 *
 * **Fast first** (user: «que la busque súper rápido y sin gastar tantos tokens»): the knowledge index
 * the app keeps anyway — words, local vectors, the code map — gives six passages in milliseconds to
 * a few seconds, and one short text-only turn answers from them (`codi::research::know`). Only when
 * that does not answer it is the deep research offered: an agent reading the repository with its map,
 * slower and dearer (`deep`).
 */
/** Spaces, dots, dashes and case aside — how a name said aloud is compared with one written down. */
const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * A reference repository the workspace on screen has switched on, by the name said — and only when
 * no repository of the workspace goes by that name too, which wins: a reference repository is not
 * a project, and «explícame Template.Node.Nest» about one is answered from the workspace's knowledge,
 * which searches it (Settings › Repositorios de referencia).
 */
async function referenceNamed(name: unknown): Promise<{ name: string; workspaceId: string } | null> {
  if (typeof name !== "string" || !name.trim()) return null;
  const { activeWorkspaceId, projectsByWorkspace } = useWorkspaceStore.getState();
  if (!activeWorkspaceId) return null;
  const said = nameKey(name);
  if ((projectsByWorkspace[activeWorkspaceId] ?? []).some((p) => nameKey(p.name) === said)) return null;
  const { referenceReposForWorkspace } = await import("../../tauri/refreposCommands");
  const references = (await referenceReposForWorkspace(activeWorkspaceId).catch(() => null)) ?? [];
  const found = references.find((r) => r.enabled && nameKey(r.name) === said);
  return found ? { name: found.name, workspaceId: activeWorkspaceId } : null;
}

export function researchActions(): CodiAction[] {
  return [
    defineAction({
      id: "repo.ask",
      title: {
        en: "Answer a question about a repository's code, or explain the repository — what the project is and is about, how something works, which database or external services it uses, what an endpoint or class does — first from what the app has indexed (fast, cheap), then, if that does not answer it and the user agrees, by researching the code in depth; the answer is said when ready. Nothing on screen changes. `repo` and `workspace` by name, as said (any workspace; a near name is asked about); left out, the open repository. `question`: the user's request, whole.",
        es: "Responde una pregunta sobre el código de un repositorio, o lo explica —qué es y de qué trata el proyecto, cómo funciona algo, qué base de datos o servicios externos usa, qué hace un endpoint o una clase—: primero con lo que la app tiene indexado (rápido y barato) y, si eso no lo responde y el usuario acepta, investigando el código a fondo; la respuesta se dice cuando está. No cambia nada en pantalla. `repo` y `workspace` por nombre, tal como se dijo (cualquier workspace; si se parece a otro, se pregunta); sin ellos, el repositorio abierto. `question`: la petición del usuario, entera.",
      },
      aliases: {
        es: ["investiga en el repositorio", "investiga en el repo", "revisa en el codigo", "busca en el codigo", "averigua en el repositorio"],
        en: ["research in the repository", "look into the code", "find out in the repo", "search the code for"],
      },
      params: params(
        {
          question: text("The user's question, whole, as they asked it."),
          repo: optionalText("The repository, as said; left out, the open one."),
          workspace: optionalText("The workspace it is in, when said."),
          deep: flag("Research the code in depth with an agent instead of answering from the index — only when the user asked for it, or said yes to it."),
        },
        ["question"],
      ),
      risk: "read",
      where: "main",
      frequent: true,
      run: async ({ question, repo, workspace, deep }) => {
        // A reference repository is answered from what the app indexed of it — it has no project to
        // research in depth.
        const reference = workspace ? null : await referenceNamed(repo);
        if (reference) {
          const { codiKnow } = await import("../../tauri/codiCommands");
          const looked = await codiKnow(null, reference.workspaceId, reference.name, String(question), null).catch((error: unknown) => {
            throw new CodiError(`could not search what the app knows of ${reference.name}: ${String(error)}`, say("codi.say.researchFailed", { name: reference.name }));
          });
          if (looked.found === 0) throw new CodiError(`the index has nothing on it in ${reference.name}`, say("codi.say.notKnown", { name: reference.name }));
          return { result: { answering: reference.name, reference: true, passages: looked.found, ms: looked.ms }, say: say("codi.say.looking") };
        }
        // «Explícame el proyecto No CLI» is noah-cli, asked first (user report, 2026-10-22).
        const project = await findProject(repo, workspace, (p) => ({
          action: "repo.ask",
          params: { question, repo: p.name, workspace: workspaceName(p.workspace_id), ...(deep === true ? { deep } : {}) },
        }));
        const where = workspaceName(project.workspace_id);
        const elsewhere = project.workspace_id !== useWorkspaceStore.getState().activeWorkspaceId;
        const deeply = { action: "repo.ask", params: { question, repo: project.name, workspace: where, deep: true } };
        const { codiKnow, codiResearch } = await import("../../tauri/codiCommands");
        if (deep !== true) {
          const looked = await codiKnow(project.local_path, project.workspace_id, project.name, String(question), deeply).catch((error: unknown) => {
            throw new CodiError(`could not search what the app knows of ${project.name}: ${String(error)}`, say("codi.say.researchFailed", { name: project.name }));
          });
          if (looked.found === 0) {
            throw new CodiError(
              `the index has nothing on it in ${project.name} — offer the deep research`,
              say("codi.say.notIndexedOffer", { name: project.name }),
              deeply,
            );
          }
          return { result: { answering: project.name, passages: looked.found, ms: looked.ms, ...(looked.partial.length ? { partial: looked.partial } : {}) }, say: say("codi.say.looking") };
        }
        try {
          await codiResearch(project.local_path, project.name, String(question));
        } catch (error) {
          throw new CodiError(`could not research ${project.name}: ${String(error)}`, say("codi.say.researchFailed", { name: project.name }));
        }
        return {
          result: { researching: project.name, ...(elsewhere ? { workspace: where } : {}) },
          say: elsewhere ? say("codi.say.researchingElsewhere", { name: project.name, workspace: where }) : say("codi.say.researching", { name: project.name }),
        };
      },
    }),
    defineAction({
      id: "knowledge.ask",
      title: {
        en: "Answer a question from what the app knows of a workspace — its notes and meeting transcripts, generated documentation, story drafts, PR review findings, document folders and repositories — searched in the local index and answered in a few sentences, in the background. Nothing on screen changes. For «what did we decide about…», «what do my notes say about…», «where is … documented». `question`: the user's request, whole; `workspace` by name, left out the one on screen.",
        es: "Responde una pregunta con lo que la app sabe de un workspace —sus notas y transcripciones de reuniones, la documentación generada, los borradores de historias, los hallazgos de revisiones de PR, las carpetas de documentos y los repositorios—, buscado en el índice local y respondido en pocas frases, en segundo plano. No cambia nada en pantalla. Para «¿qué decidimos sobre…?», «¿qué dicen mis notas de…?», «¿dónde está documentado…?». `question`: la petición del usuario, entera; `workspace` por nombre, sin él el de la pantalla.",
      },
      aliases: {
        es: ["busca en mis notas", "busca en las notas", "busca en la documentacion", "busca en el conocimiento", "busca en el workspace", "busca informacion sobre"],
        en: ["search my notes", "search the notes", "search the docs", "search the knowledge", "search the workspace", "look up"],
      },
      questions: {
        es: [
          "que sabes de", "que sabes sobre", "que dicen mis notas", "que dicen las notas", "que se decidio", "que decidimos", "que hablamos", "que dijimos",
          "en que reunion", "donde esta documentado", "donde documentamos", "hay algo documentado sobre",
        ],
        en: ["what do you know about", "what do my notes say", "what did we decide", "what did we say about", "in which meeting", "where is it documented", "is there anything documented about"],
      },
      params: params(
        {
          question: text("The user's request, whole, as they asked it."),
          workspace: optionalText("The workspace, as said; left out, the one on screen."),
        },
        ["question"],
      ),
      risk: "read",
      where: "main",
      frequent: true,
      run: async ({ question, workspace }) => {
        const target = typeof workspace === "string" && workspace.trim()
          ? pickByName(useWorkspaceStore.getState().workspaces, workspace, (w) => w.name, "workspace")
          : requireWorkspace();
        const { codiKnow } = await import("../../tauri/codiCommands");
        const looked = await codiKnow(null, target.id, target.name, String(question), null).catch((error: unknown) => {
          throw new CodiError(`could not search what the app knows of ${target.name}: ${String(error)}`, say("codi.say.researchFailed", { name: target.name }));
        });
        if (looked.found === 0) throw new CodiError(`the index has nothing on it in ${target.name}`, say("codi.say.notKnown", { name: target.name }));
        return { result: { answering: target.name, passages: looked.found, ms: looked.ms, ...(looked.partial.length ? { partial: looked.partial } : {}) }, say: say("codi.say.looking") };
      },
    }),
  ];
}
