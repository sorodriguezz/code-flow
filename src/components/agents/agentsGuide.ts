/**
 * Static, read-only manual for the Agents view — what it does, how to work with it, and what it
 * cannot do. Not editable and not stored per workspace; it's orientation content, picked by the
 * app's language.
 *
 * The limits section is not a disclaimer to skim past. Everything in it is a real property of how
 * this feature is built, and each one is the answer to a question a user would otherwise have to
 * discover by being surprised.
 */

export const AGENTS_GUIDE_ES = `# Agentes — Manual

Esta vista tiene cuatro piezas: los **agentes** (quién trabaja), las **tareas** (un encargo), las **cadenas** (varios agentes uno detrás de otro) y el **realizador de historias** (una HU, varios repos, dos fases).

## 1. Agentes

Un agente es un **rol con su propio motor**: nombre, proveedor, modelo e instrucciones. Se define una vez y se reutiliza.

Ábrelos con el botón de personas de la cabecera. Es **una plantilla por espacio de trabajo**, y es la que usan las tres cosas de esta vista: las tareas, las cadenas y el realizador de historias. No hay dos listas que mantener.

Qué ganas frente a escribir el prompt cada vez:

- **Enrutado por rol.** El documentador en un modelo barato, el revisor en uno caro, sin tocar los ajustes globales.
- **Instrucciones fijas.** "Eres un revisor meticuloso, no reformatees lo que no toques" se escribe una vez.
- **Identidad.** Cada tarea lleva el nombre del agente que la ejecutó, así sabes quién hizo qué semanas después.

> Un agente **sin modelo no usa su motor**: la app cae al enrutado normal del chat y el agente respondería en un motor distinto al que dice. La vista lo marca en naranja; arréglalo antes de usarlo.

## 2. Tareas

Una tarea es **un objetivo dado a un agente, trabajado en un repositorio**. Sus turnos son una conversación normal: misma transcripción, mismo registro en vivo, mismo botón de parar.

Paso a paso:

1. **Nueva tarea** (o \`Ctrl/⌘+N\`): eliges agente, **repositorios** y objetivo.
2. Arranca sola. Vete a otra cosa — sigue corriendo aunque cambies de vista o de espacio de trabajo.
3. Vuelve cuando esté en **Te toca**: terminó un turno y espera tu respuesta.
4. Revisa lo que hizo con \`···\` → **Revisar cambios**, que te lleva al diff real de ese repositorio.
5. Sube de modelo cuando la cosa se ponga difícil: el chip del compositor lo cambia en cualquier turno.

**El agente queda fijado al crear la tarea; el modelo no.** Las instrucciones del agente ya están en el hilo y el motor ya tiene la sesión abierta — cambiarlo a mitad reescribiría en silencio quién escribió la mitad de la conversación.

### Más de un repositorio

Puedes marcar **de 1 a N repositorios** al crear la tarea. Con uno, el formulario es el de siempre. Con varios, se crea **una tarea por repositorio**: mismo agente, mismo objetivo, cada una en su copia de trabajo, y todas arrancan a la vez.

Son tareas hermanas, no una sola tarea repartida: un motor ve **un único directorio de trabajo**, así que no existe la tarea que lee dos repositorios. Cada una lleva su propio hilo, su propio diff y su propio botón de parar, y la lista las distingue por el nombre del repositorio. Corren de verdad en paralelo, porque el candado de "un agente a la vez" es **por repositorio** y estas están en repositorios distintos.

Si lo que quieres es que una respuesta alimente a la siguiente, eso es una **cadena**, no esto.

## 3. Cadenas

Una cadena pasa **la respuesta de un agente al siguiente**, en un mismo repositorio. Lo típico: Arquitecto → Implementador → Revisor.

1. **Nueva cadena** (el botón del eslabón): **repositorios**, objetivo y la lista de pasos, con una instrucción por paso.
2. Marca **"Revisar antes de ejecutar este paso"** en los pasos donde quieras entrar tú.
3. **Iniciar cadena.** El paso 1 corre como una tarea normal y, al responder, el paso 2 arranca solo con lo anterior dentro.
4. En una compuerta la cadena **para antes** de ejecutar y te enseña **el mensaje exacto** que va a enviar. Puedes editarlo — lo editado es lo que se manda.
5. Si un turno falla, **la cadena lo reintenta sola** — hasta 3 intentos por paso, y el paso dice en qué intento va. Solo cuando se agotan se detiene y espera: *Reintentar paso*, *Saltar paso* o *Abortar*.

Mientras corre, la cadena se ve moverse: el raíl entre dos pasos se ilumina cuando la respuesta de uno está entrando en el siguiente, y la barra bajo el título avanza con los pasos resueltos.

### Verificación y bucles

Cada paso puede llevar un **comando de verificación** — \`npm test\`, \`cargo build\`, lo que sea. Se ejecuta en el repositorio de ese paso cuando el agente termina, y **el código de salida es todo el veredicto**: nadie lee la salida para decidir. Es el único dato de la cadena que no escribió un agente.

Si falla, eliges a dónde va el plan:

- **Reintentar este paso** — vuelve a correr, y esta vez el mensaje lleva la salida del comando que lo rechazó.
- **Volver al paso N** — el bucle. El revisor devuelve el trabajo al implementador, y el paso al que aterriza recibe qué falló y qué había intentado el anterior. Todo lo que hay entre medias vuelve a correr.

Un paso que aprueba también puede saltar hacia adelante, y lo que se salta queda marcado como *saltado*.

Lo que evita que esto se vaya de las manos son dos números, no la forma del plan: **128 ejecuciones por cadena** y **3 ejecuciones por paso**. Un bucle da tres vueltas y se detiene solo.

Cada paso es su propia conversación, así que **puedes encadenar motores distintos** (Claude → Codex). El precio es que cada paso relee el repositorio desde cero.

### Varios repositorios

Puedes marcar **de 1 a N repositorios** al crear la cadena. Con uno solo, el diálogo es exactamente el de siempre. Con varios aparece un selector en cada paso:

- **Un repositorio concreto** — ese paso corre ahí.
- **Todos los repositorios** — ese paso se convierte, al crear la cadena, en **una ejecución por repositorio**, seguidas. El diálogo te dice a cuántas ejecuciones sale el plan antes de empezar.

Un motor solo ve **un directorio de trabajo**, así que no existe el paso que mira dos repos a la vez: lo que hay son varias pasadas. El contexto que recibe cada paso es la respuesta anterior **de su propio repositorio**, y solo si no hay ninguna cae a la del plan entero — que es justo lo que lleva un análisis común al repo que va a actuar sobre él.

## 4. Realizador de historias

Le das **una HU por enlace o por id**, marcas los repositorios que *podrían* estar implicados, y eliges dos agentes. Son dos fases, siempre:

1. **Análisis.** El primer agente se ejecuta **una vez por repositorio candidato**, sin escribir nada, y responde si ese repo hay que tocarlo y qué cambiaría.
2. **Tu decisión.** La ejecución **para** y te enseña las N respuestas juntas: veredicto, plan y el mensaje exacto que recibiría cada repo. Desmarcas los que no van, editas los que sí.
3. **Implementación.** El segundo agente corre **solo en los repositorios que aprobaste**, con el plan tal como lo dejaste.

Si desmarcas todos, la ejecución termina sin tocar nada — que es la respuesta honesta a "ninguno de estos hay que cambiarlo".

Por dentro es una cadena normal: se recupera igual si matan la app, se para en su compuerta igual y sus pasos son tareas que puedes abrir.

## Límites — léelos

**Los agentes editan tu copia de trabajo de verdad.** Cada turno toma un punto de restauración antes de empezar, pero no es una caja de arena: no hay aislamiento en contenedor ni en worktree.

**Un agente a la vez por repositorio.** No hay cola detrás: dos motores sobre la misma carpeta se pisarían los checkpoints. Para trabajar en paralelo, reparte por repositorios. Una cadena que se encuentra el repo ocupado **espera**, no falla.

**Nada arranca solo.** Ni al reiniciar la app, ni con la ventana cerrada en la bandeja. Si te mataron la app a mitad de un paso, al abrir verás la cadena *Pausada — interrumpida* y un botón de **Reanudar**. El trabajo del paso que sí llegó a terminar se conserva.

**Un paso sin verificación no sabe si salió bien.** Avanza porque el turno devolvió texto, no porque el resultado sea correcto: un revisor que escriba "esto está mal" cierra el paso en verde. Ponle un **comando de verificación** y eso deja de pasar — el código de salida decide, y nadie lee la prosa. Sin verificación, las compuertas siguen siendo la única respuesta real y necesitan que mires tú.

**Con bucles, pero contados.** Un paso puede volver a disparar a otro anterior, y por eso el tope ya no es el tamaño del plan sino el **presupuesto de ejecuciones**: 128 por cadena. Encima de eso, cada paso corre como mucho 3 veces — ya sea porque falló el turno o porque lo rechazaron — así que un bucle da 3 vueltas y para. Máximo 16 pasos escritos, 64 ejecuciones una vez expandidos y 16 repositorios.

**El traspaso entre pasos se corta a 60.000 caracteres.** Ya no es un límite de la línea de comandos — un mensaje largo viaja como datos, no como argumento — sino la ventana de contexto del siguiente agente. Aun así, para algo enorme el canal sigue siendo el propio repositorio: que un paso escriba \`docs/plan.md\` y el siguiente lo lea.

**El veredicto del análisis es una opinión, no una comprobación.** El realizador marca por ti los repos que el agente dijo que hay que tocar, y deja **sin marcar** todo lo que no supo leer. Marcar es tuyo, y es lo único que autoriza a escribir.

**Las plantillas no guardan repositorios.** Una plantilla se aplica en el espacio de trabajo en el que la abras, y un id de otro no significa nada ahí: rellena agentes e instrucciones, y los repos los eliges en la cadena.
`;

export const AGENTS_GUIDE_EN = `# Agents — Manual

This view has four pieces: **agents** (who does the work), **tasks** (one assignment), **chains** (several agents, one after another) and the **story realizer** (one work item, several repositories, two phases).

## 1. Agents

An agent is a **role with its own engine**: name, provider, model and instructions. Defined once, reused.

Open them with the people button in the header. It is **one roster per workspace**, and it is the one all three things in this view run as: tasks, chains and the story realizer. There are not two lists to keep in step.

What you gain over retyping the prompt every time:

- **Routing per role.** The documenter on a cheap model, the reviewer on an expensive one, without touching global settings.
- **Standing instructions.** "You are a meticulous reviewer, don't reformat what you don't touch" is written once.
- **Identity.** Every task carries the name of the agent that ran it, so you know who did what weeks later.

> An agent **with no model does not use its engine**: the app falls back to the normal chat routing, so it would answer on a different engine than the one it names. The view flags it in orange; fix it before using it.

## 2. Tasks

A task is **one goal handed to one agent, worked on in one repository**. Its turns are an ordinary conversation: same transcript, same live log, same stop button.

Step by step:

1. **New task** (or \`Ctrl/⌘+N\`): pick the agent, the **repositories** and the goal.
2. It starts on its own. Go do something else — it keeps running while you switch views or workspaces.
3. Come back when it says **Your turn**: it finished a turn and is waiting on you.
4. Review what it did with \`···\` → **Review changes**, which takes you to that repository's real diff.
5. Move up a model when it gets hard: the chip in the composer changes it on any turn.

**The agent is fixed when the task is created; the model is not.** Its instructions are already in the thread and the engine already holds the session — swapping it midway would silently rewrite who authored half the conversation.

### More than one repository

You can tick **1 to N repositories** when you create the task. With one, the form is what it always was. With several you get **one task per repository**: same agent, same goal, each in its own working copy, all started together.

They are sibling tasks, not one task spread thin: an engine sees **a single working directory**, so there is no such thing as a task that reads two repositories. Each has its own thread, its own diff and its own stop button, and the list tells them apart by repository name. They genuinely run at the same time, because the one-agent-at-a-time lock is **per repository** and these are in different ones.

If what you want is one answer feeding the next, that is a **chain**, not this.

## 3. Chains

A chain hands **one agent's answer to the next**, in one repository. The usual shape: Architect → Implementer → Reviewer.

1. **New chain** (the link button): **repositories**, objective, and the ordered steps with one instruction each.
2. Tick **"Review before running this step"** wherever you want to step in.
3. **Start chain.** Step 1 runs as an ordinary task and, when it answers, step 2 starts by itself with what came before folded in.
4. At a gate the chain **stops before running** and shows you **the exact message** it is about to send. You can edit it — what you edit is what gets sent.
5. If a turn fails, **the chain retries it by itself** — up to 3 attempts per step, and the step says which attempt it is on. Only once they are gone does it stop and wait: *Retry step*, *Skip step* or *Abort*.

While it runs you can watch it move: the rail between two steps lights up as one answer feeds the next, and the bar under the title fills with the steps that are resolved.

### Checks and loops

Any step can carry a **check command** — \`npm test\`, \`cargo build\`, whatever. It runs in that step's repository once the agent finishes, and **the exit code is the whole verdict**: nothing reads the output to decide. It is the one fact in a chain no agent wrote.

When it fails, you choose where the plan goes:

- **Try this step again** — it re-runs, and this time its message carries the output of the command that rejected it.
- **Go back to step N** — the loop. The reviewer hands the work back to the implementer, and the step it lands on is told what failed and what the last attempt tried. Everything in between runs again.

A step that passes can also jump forward, and whatever it steps over is marked *skipped*.

What keeps this from running away is two numbers rather than the shape of the plan: **128 runs per chain** and **3 runs per step**. A loop goes round three times and stops on its own.

Every step is its own conversation, so **you can chain different engines** (Claude → Codex). The price is that each step re-reads the repository from scratch.

### More than one repository

You can tick **1 to N repositories** when you create the chain. With one, the dialog is exactly what it always was. With several, each step gets a picker:

- **One named repository** — that step runs there.
- **Every repository** — that step becomes, at creation, **one run per repository**, back to back. The dialog tells you how many runs the plan comes to before you start it.

An engine only ever sees **one working directory**, so there is no such thing as a step that reads two repositories at once: what there is, is several passes. The context a step receives is the previous answer **from its own repository**, falling back to the plan-wide one only when there is none — which is exactly what carries a shared analysis into the repository about to act on it.

## 4. Story realizer

You give it **one work item, by link or by id**, tick the repositories that *might* be involved, and pick two agents. Two phases, always:

1. **Analysis.** The first agent runs **once per candidate repository**, writes nothing, and answers whether that repository has to change and what would change in it.
2. **Your call.** The run **stops** and shows you the N answers side by side: verdict, plan, and the exact message each repository would be sent. Untick the ones that are out, edit the ones that are in.
3. **Implementation.** The second agent runs **only on the repositories you approved**, with the plan as you left it.

Untick all of them and the run finishes having touched nothing — which is the honest answer to "none of these need to change".

Underneath it is an ordinary chain: it recovers from a kill the same way, parks at its gate the same way, and its steps are tasks you can open.

## Limits — read these

**Agents edit your real working copy.** Every turn takes a restore point first, but this is not a sandbox: there is no container or worktree isolation.

**One agent at a time per repository.** There is no queue behind it: two engines on one folder would take restore points over each other. To work in parallel, spread across repositories. A chain that finds the repository busy **waits**; it does not fail.

**Nothing starts on its own.** Not on app restart, not with the window closed to the tray. If the app was killed mid-step, you will find the chain *Paused — interrupted* with a **Resume** button. Work from a step that did finish is kept.

**A step with no check cannot tell whether it succeeded.** It advances because the turn returned text, not because the result is right: a reviewer that writes "this is wrong" finishes its step green. Give it a **check command** and that stops being true — the exit code decides and nobody reads the prose. Without one, gates are still the only real answer and they need you to look.

**Loops, but counted.** A step can re-trigger an earlier one, which is why the bound is no longer the size of the plan but the **run budget**: 128 per chain. On top of that any one step runs at most 3 times — whether that was a failed turn or a rejection — so a loop goes round three times and stops. At most 16 authored steps, 64 runs once they are expanded, and 16 repositories.

**The handoff between steps is cut at 60,000 characters.** No longer a command-line limit — a long message travels as data rather than as an argument — but the next agent's context window. Even so, for anything enormous the channel is still the repository itself: have one step write \`docs/plan.md\` and the next read it.

**The analysis verdict is an opinion, not a check.** The realizer pre-ticks the repositories the agent said have to change, and leaves **unticked** anything it could not read. Ticking is yours, and it is the only thing that authorises a write.

**Templates carry no repositories.** A template is applied in whatever workspace you open it in, and an id from another one means nothing there: it fills in agents and instructions, and you pick the repositories on the chain.
`;
