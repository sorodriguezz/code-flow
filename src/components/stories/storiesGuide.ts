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

Esta vista trabaja en **tres direcciones**, una por pestaña.

- **Redactar** parte de documentación y produce un backlog nuevo, que puedes publicar en Azure Boards.
- **Revisar** parte de un work item que **ya existe** y te dice qué le falta. Lo que decidas subir vuelve al tablero desde la tercera columna.
- **Wiki** va al revés que las dos anteriores: lee el código y escribe la documentación técnica que las otras dan por hecho que alguien redactó.

Las tres comparten el espacio de trabajo, la conexión de Azure DevOps y los repositorios.

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

## Wiki

Documentación **técnica** generada leyendo el código, y publicable en una wiki de Azure DevOps.

Dos alcances, que responden preguntas distintas:

- **Repositorio** — cómo se levanta, se configura y se despliega *una* cosa: stack y arquitectura, **variables de entorno**, **desarrollo local**, **integraciones**, **base de datos**, build y despliegue. El repositorio queda fijado al crear el documento, para que regenerarlo describa lo mismo.
- **Workspace** — cómo encajan **varios** repositorios y qué resuelven como sistema: quién llama a quién, los contratos, el flujo de datos y los puntos de acoplamiento.

El documento del workspace no lee código: se escribe a partir de los documentos de repositorio, uno por cada repositorio que elijas. Es la única forma honesta de hacerlo — ninguna corrida ve dos repositorios a la vez — y por eso una integración que ningún documento menciona se reporta como dudosa en vez de inventarse.

Lo generado es Markdown editable. Cuando esté como lo quieres, eliges organización, proyecto, wiki y ruta de página, y publicas.

## Límites — léelos

**Revisar sí puede escribir en Azure DevOps, pero solo desde la tercera columna.** Leer y proponer no cambian nada. Lo único que sale de la app es lo que prepares en «Por publicar» y confirmes, paso a paso: descripción, criterios y tareas se publican por separado. Los criterios se **reemplazan** enteros, no se fusionan.

**Criterios y tareas se publican al revés, y el borrador lo refleja.** Los criterios de aceptación son **un solo campo** en Azure: publicarlos reescribe el campo entero. Por eso, la primera vez que mandas un criterio al borrador, la lista se **siembra con los que la HU ya tenía** — lo que ves ahí no es «lo nuevo», es cómo va a quedar el campo. La consecuencia: si borras del borrador un criterio que ya existía y publicas, **ese criterio desaparece del work item**. Una propuesta que dice reescribir el criterio 3 aterriza *sobre* el 3, en su sitio; una que no nombra ninguno se agrega al final.

Las **tareas** funcionan al contrario: se crean como work items **hijos**, así que el borrador solo lleva las nuevas. Quitar una de ahí significa que no se crea — no borra ninguna tarea que ya esté en el tablero.

Y como la sesión es una foto del momento en que la abriste: si alguien edita los criterios en Azure mientras la tienes abierta, publicar pisa ese cambio. Recargar el work item está a un clic.

**Las sesiones de revisión se guardan.** Cada etapa que produce algo guarda la sesión completa, y el **Historial** las lista. Una sesión guardada es una **foto**: no se sincroniza con el tablero, así que el work item puede haber cambiado desde entonces. La pantalla lo dice al abrir una, y volver a cargarlo desde Azure está a un clic.

**Ninguna corrida ve dos repositorios a la vez.** Con varios repositorios se hace una corrida por cada uno y los hallazgos se fusionan aquí, etiquetados con su repositorio. La consecuencia importante: una inconsistencia **entre** repos —el front llamando a un endpoint que el back no expone— no se detecta así.

**La IA lee el repositorio, nunca lo modifica.** Ni en Verificar ni en Revisar. Se toma el mismo candado que usan los agentes, así que un repositorio ocupado por un agente rechaza la revisión en vez de pisarse con él.

**Un bug guarda su texto en «Pasos para reproducir»**, no en la descripción — el formulario de bug de Azure no tiene caja de descripción. La revisión lee el campo correcto según el tipo.

**Publicar un conjunto es solo de ida.** Crea work items nuevos; no actualiza los que ya existen. Una historia ya publicada queda marcada y no se vuelve a publicar.

**Publicar una página de wiki sí sobrescribe.** Si la página existe, su contenido se reemplaza — salvo que alguien la haya editado desde que la leímos, en cuyo caso la escritura se rechaza en vez de pisar ese cambio.

**El modelo se equivoca.** La evidencia con archivo y línea está para que la compruebes, no para que te fíes. Un veredicto sin evidencia citable es una opinión.`;

export const STORIES_GUIDE_EN = `# User stories — Manual

This view works in **three directions**, one per tab.

- **Write** starts from documentation and produces a new backlog you can publish to Azure Boards.
- **Review** starts from a work item that **already exists** and tells you what it is missing. What you decide to send goes back to the board from the third column.
- **Wiki** runs the other way round from both: it reads the code and writes the technical documentation the other two assume somebody wrote.

All three share the workspace, the Azure DevOps connection and the repositories.

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

## Wiki

**Technical** documentation, generated by reading the code and publishable to an Azure DevOps wiki.

Two scopes, answering different questions:

- **Repository** — how *one* thing runs, is configured and is deployed: stack and architecture, **environment variables**, **local development**, **integrations**, **database**, build and deploy. The repository is fixed when the document is created, so regenerating describes the same thing.
- **Workspace** — how **several** repositories fit together and what they solve as a system: who calls whom, the contracts, the data flow and the coupling points.

The workspace document reads no code: it is written from the repository documents, one per repository you pick. That is the only honest way to do it — no run ever sees two repositories at once — which is also why an integration no document mentions is reported as unclear rather than invented.

What comes out is editable Markdown. When it says what you want, pick organisation, project, wiki and page path, and publish.

## Limits — read these

**Review can write to Azure DevOps, but only from the third column.** Reading and proposing change nothing. The only thing that leaves the app is what you stage in "To publish" and confirm, step by step: description, criteria and tasks publish separately. The criteria are **replaced** whole, never merged.

**Criteria and tasks publish in opposite ways, and the draft shows it.** Acceptance criteria are **one field** in Azure: publishing rewrites the whole of it. That is why the first criterion you stage **seeds the list with the ones the story already had** — what you see there is not "the new ones", it is what the field will look like. The consequence: delete an existing criterion from the draft and publish, and **that criterion is gone from the work item**. A proposal that says it rewrites criterion 3 lands *on* criterion 3, in place; one that names none is appended.

**Tasks** are the other way round: they are created as **child** work items, so the draft only ever holds the new ones. Removing one there means it is not created — nothing already on the board is touched.

And since the session is a snapshot of the moment you opened it: if somebody edits the criteria in Azure while you have it open, publishing tramples that edit. Reloading the work item is one click away.

**Review sessions are saved.** Every stage that produces something saves the whole session, and **History** lists them. A saved session is a **snapshot**: it is not reconciled with the board, so the work item may have changed since. The screen says so when you open one, and reloading from Azure is one click away.

**No run ever sees two repositories at once.** With several repositories there is one run per repository and the findings are merged here, tagged with where they came from. The consequence that matters: an inconsistency *between* repositories — the front calling an endpoint the back does not expose — cannot be found this way.

**The AI reads the repository, never edits it.** Neither in Verify nor in Review. It takes the same lease the agents take, so a repository an agent is working in refuses the review rather than colliding with it.

**A bug keeps its prose in "Steps to reproduce"**, not in the description — Azure's bug form has no description box. The review reads the right field for the type.

**Publishing a set is one-way.** It creates new work items; it does not update existing ones. A story that has been published is marked and will not be published twice.

**Publishing a wiki page does overwrite.** If the page exists its content is replaced — unless somebody edited it since we read it, in which case the write is refused rather than trampling that change.

**The model gets things wrong.** Evidence with file and line is there for you to check, not to trust. A verdict with no citable evidence is an opinion.`;
