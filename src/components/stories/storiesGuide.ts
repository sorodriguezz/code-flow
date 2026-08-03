/**
 * Static, read-only manual for the user-stories workspace — what it does, how to work with it, and
 * what it cannot do. Same shape as the Agents guide: not editable, not stored per workspace, picked
 * by the app's language.
 *
 * The limits section is the part worth the space. "The review never writes to Azure", "no run ever
 * sees two repositories at once" and "the session is not saved" are three answers to the same
 * question — what is this actually responsible for — and a user who meets them one surprise at a
 * time never assembles the picture.
 */

export const STORIES_GUIDE_ES = `# Historias de usuario — Manual

Esta vista trabaja en **dos direcciones**, una por pestaña.

- **Redactar** parte de documentación y produce un backlog nuevo, que puedes publicar en Azure Boards.
- **Revisar** parte de un work item que **ya existe** y te dice qué le falta. No publica nada.

Las dos comparten el espacio de trabajo, la conexión de Azure DevOps y los repositorios. Se pasa de una a otra dentro de una misma refinación.

## Redactar

1. **Nuevo conjunto** (o \`Ctrl/⌘+N\`): eliges de dónde sale el material — una wiki de Azure DevOps, archivos Markdown locales o texto pegado — y añades instrucciones extra si quieres.
2. **Generar**. Salen historias con su narrativa, sus criterios en Gherkin y sus preguntas abiertas.
3. Edita lo que haga falta. Cada historia se guarda al salir del campo, sin botón de guardar.
4. **Verificar** comprueba los criterios **contra el código** de un repositorio: cada criterio recibe un veredicto (\`cumple\`, \`no cumple\`, \`parcial\`, \`no se sabe\`) con evidencia citando archivo y línea.
5. **Publicar** crea un work item por historia en el proyecto de Azure Boards que elijas en el panel derecho.

El **puntaje** de cada historia es una comprobación local, sin modelo: mide cosas verificables sobre el texto — que la narrativa tenga las tres partes, que un escenario no tenga dos «Cuando», que haya criterios. No es una opinión de la IA.

Puedes exportar los criterios como **archivo \`.feature\`** de Cucumber dentro del repositorio, para que QA los ejecute en vez de leerlos.

## Revisar

Para historias, bugs o cualquier work item que ya esté escrito en el tablero.

1. Elige la **organización** (sale de Ajustes → Azure DevOps) y pega el **enlace** del work item o su número.
2. Elige **uno o más repositorios**. Es lo que ancla la revisión al código que existe hoy.
3. Las tres etapas van en orden, y las lanzas tú:
   - **Analizar** — qué le falta a la historia. INVEST, BDD y testabilidad Gherkin. Para un **bug** la vara es otra: reproducible, esperado, obtenido, contexto, alcance y verificable.
   - **Criterios** — escenarios Gherkin que faltan, escritos sobre la historia *tal como la tengas en ese momento*.
   - **Tareas** — el desglose en \`[DEV]\` y \`[QA]\`, mirando las tareas que ya tiene para no repetirlas.
4. Cada propuesta trae **Insertar** (la mete en tu copia local) o **Copiar**. Nada se aplica solo.

Se lanzan por separado a propósito: la etapa 2 lee lo que dejaste después de la 1. Pedir las tres de golpe sería proponer tareas para una historia que aún no has aceptado.

## Límites — léelos

**Revisar no escribe nada en Azure DevOps.** Ni la historia, ni sus criterios, ni sus tareas. Lo que te lleves sale por tus manos: insertado en la copia local o copiado al portapapeles. Esto es lo que hace seguro lanzarlo sobre un tablero donde trabaja más gente.

**La sesión de revisión no se guarda.** Si cierras la app o cargas otro work item, se pierde lo que no hayas copiado. La copia local nunca fue una segunda fuente de verdad.

**Ninguna corrida ve dos repositorios a la vez.** Con varios repositorios se hace una corrida por cada uno y los hallazgos se fusionan aquí, etiquetados con su repositorio. La consecuencia importante: una inconsistencia **entre** repos —el front llamando a un endpoint que el back no expone— no se detecta así.

**La IA lee el repositorio, nunca lo modifica.** Ni en Verificar ni en Revisar. Se toma el mismo candado que usan los agentes, así que un repositorio ocupado por un agente rechaza la revisión en vez de pisarse con él.

**Un bug guarda su texto en «Pasos para reproducir»**, no en la descripción — el formulario de bug de Azure no tiene caja de descripción. La revisión lee el campo correcto según el tipo.

**Publicar es solo de ida.** Crea work items nuevos; no actualiza los que ya existen. Una historia ya publicada queda marcada y no se vuelve a publicar.

**El modelo se equivoca.** La evidencia con archivo y línea está para que la compruebes, no para que te fíes. Un veredicto sin evidencia citable es una opinión.`;

export const STORIES_GUIDE_EN = `# User stories — Manual

This view works in **two directions**, one per tab.

- **Write** starts from documentation and produces a new backlog you can publish to Azure Boards.
- **Review** starts from a work item that **already exists** and tells you what it is missing. It publishes nothing.

Both share the workspace, the Azure DevOps connection and the repositories. You move between them within one refinement session.

## Write

1. **New set** (or \`Ctrl/⌘+N\`): pick where the material comes from — an Azure DevOps wiki, local Markdown files, or pasted text — and add extra instructions if you want.
2. **Generate**. You get stories with their narrative, their Gherkin criteria and their open questions.
3. Edit what needs it. Each story saves on blur; there is no save button.
4. **Verify** checks the criteria **against the code** of a repository: every criterion gets a verdict (\`pass\`, \`fail\`, \`partial\`, \`unknown\`) with evidence citing file and line.
5. **Publish** creates one work item per story in the Azure Boards project you pick in the right rail.

Each story's **score** is a local check with no model involved: it measures verifiable things about the text — that the narrative has its three parts, that a scenario does not carry two "When" steps, that criteria exist at all. It is not the AI's opinion.

You can export the criteria as a Cucumber **\`.feature\` file** inside the repository, so QA runs them instead of reading them.

## Review

For stories, bugs, or any work item already written on the board.

1. Pick the **organisation** (it comes from Settings → Azure DevOps) and paste the work item **link** or its number.
2. Pick **one or more repositories**. That is what grounds the review in the code that exists today.
3. The three stages run in order, and you start each one:
   - **Analyse** — what the story is missing. INVEST, BDD and Gherkin testability. A **bug** is measured differently: reproducible, expected, actual, context, scope and verifiable.
   - **Criteria** — the Gherkin scenarios that are missing, written against the story *as you have it at that moment*.
   - **Tasks** — the breakdown into \`[DEV]\` and \`[QA]\`, reading the tasks it already has so it does not propose them twice.
4. Every proposal offers **Insert** (into your local copy) or **Copy**. Nothing applies itself.

They are separate on purpose: stage 2 reads what you left after stage 1. Asking for all three at once would be proposing tasks for a story nobody has agreed to yet.

## Limits — read these

**Review writes nothing to Azure DevOps.** Not the story, not its criteria, not its tasks. Whatever you take leaves through your own hands: inserted into the local copy, or copied to the clipboard. That is what makes it safe to run against a board other people are working from.

**The review session is not saved.** Close the app or load another work item and whatever you did not copy is gone. The local copy was never meant to be a second source of truth.

**No run ever sees two repositories at once.** With several repositories there is one run per repository and the findings are merged here, tagged with where they came from. The consequence that matters: an inconsistency *between* repositories — the front calling an endpoint the back does not expose — cannot be found this way.

**The AI reads the repository, never edits it.** Neither in Verify nor in Review. It takes the same lease the agents take, so a repository an agent is working in refuses the review rather than colliding with it.

**A bug keeps its prose in "Steps to reproduce"**, not in the description — Azure's bug form has no description box. The review reads the right field for the type.

**Publishing is one-way.** It creates new work items; it does not update existing ones. A story that has been published is marked and will not be published twice.

**The model gets things wrong.** Evidence with file and line is there for you to check, not to trust. A verdict with no citable evidence is an opinion.`;
