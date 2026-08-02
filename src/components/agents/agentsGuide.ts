/**
 * Static, read-only manual for the Agents view — what it does, how to work with it, and what it
 * cannot do. Not editable and not stored per workspace; it's orientation content, picked by the
 * app's language, the same shape as the SDD section's guide.
 *
 * The limits section is not a disclaimer to skim past. Everything in it is a real property of how
 * this feature is built, and each one is the answer to a question a user would otherwise have to
 * discover by being surprised.
 */

export const AGENTS_GUIDE_ES = `# Agentes — Manual

Esta vista tiene tres piezas: los **agentes** (quién trabaja), las **tareas** (un encargo) y las **cadenas** (varios agentes uno detrás de otro).

## 1. Agentes

Un agente es un **rol con su propio motor**: nombre, proveedor, modelo e instrucciones. Se define una vez y se reutiliza.

Ábrelos con el botón de personas de la cabecera. Es **la misma plantilla** que Ajustes → SDD y que el selector de agente del chat de IA — no hay dos listas que mantener.

Qué ganas frente a escribir el prompt cada vez:

- **Enrutado por rol.** El documentador en un modelo barato, el revisor en uno caro, sin tocar los ajustes globales.
- **Instrucciones fijas.** "Eres un revisor meticuloso, no reformatees lo que no toques" se escribe una vez.
- **Identidad.** Puedes agrupar las tareas por agente y saber quién hizo qué semanas después.

> Un agente **sin modelo no usa su motor**: la app cae al enrutado normal del chat y el agente respondería en un motor distinto al que dice. La vista lo marca en naranja; arréglalo antes de usarlo.

## 2. Tareas

Una tarea es **un objetivo dado a un agente, trabajado en un repositorio**. Sus turnos son una conversación normal: misma transcripción, mismo registro en vivo, mismo botón de parar.

Paso a paso:

1. **Nueva tarea** (o \`Ctrl/⌘+N\`): eliges agente, repositorio y objetivo.
2. Arranca sola. Vete a otra cosa — sigue corriendo aunque cambies de vista o de espacio de trabajo.
3. Vuelve cuando esté en **Te toca**: terminó un turno y espera tu respuesta.
4. Revisa lo que hizo con \`···\` → **Revisar cambios**, que te lleva al diff real de ese repositorio.
5. Sube de modelo cuando la cosa se ponga difícil: el chip del compositor lo cambia en cualquier turno.

**El agente queda fijado al crear la tarea; el modelo no.** Las instrucciones del agente ya están en el hilo y el motor ya tiene la sesión abierta — cambiarlo a mitad reescribiría en silencio quién escribió la mitad de la conversación.

## 3. Cadenas

Una cadena pasa **la respuesta de un agente al siguiente**, en un mismo repositorio. Lo típico: Arquitecto → Implementador → Revisor.

1. **Nueva cadena** (el botón del eslabón): repositorio, objetivo y la lista de pasos, con una instrucción por paso.
2. Marca **"Revisar antes de ejecutar este paso"** en los pasos donde quieras entrar tú.
3. **Iniciar cadena.** El paso 1 corre como una tarea normal y, al responder, el paso 2 arranca solo con lo anterior dentro.
4. En una compuerta la cadena **para antes** de ejecutar y te enseña **el mensaje exacto** que va a enviar. Puedes editarlo — lo editado es lo que se manda.
5. Si algo falla, la cadena se detiene y espera: *Reintentar paso*, *Saltar paso* o *Abortar*.

Cada paso es su propia conversación, así que **puedes encadenar motores distintos** (Claude → Codex). El precio es que cada paso relee el repositorio desde cero.

## Límites — léelos

**Los agentes editan tu copia de trabajo de verdad.** Cada turno toma un punto de restauración antes de empezar, pero no es una caja de arena: no hay aislamiento en contenedor ni en worktree.

**Un agente a la vez por repositorio.** No hay cola detrás: dos motores sobre la misma carpeta se pisarían los checkpoints. Para trabajar en paralelo, reparte por repositorios. Una cadena que se encuentra el repo ocupado **espera**, no falla.

**Nada arranca solo.** Ni al reiniciar la app, ni con la ventana cerrada en la bandeja. Si te mataron la app a mitad de un paso, al abrir verás la cadena *Pausada — interrumpida* y un botón de **Reanudar**. El trabajo del paso que sí llegó a terminar se conserva.

**La cadena no sabe si un paso salió bien.** Avanza porque el turno devolvió texto, no porque el resultado sea correcto. Un revisor que escriba "esto está mal" cierra la cadena en verde. **Las compuertas son la única respuesta real, y necesitan que mires tú.**

**Sin bucles ni ramas.** Un revisor no puede volver a disparar al implementador. Máximo 8 pasos, 3 intentos por paso, y ningún reintento automático.

**El traspaso entre pasos se corta a 6.000 caracteres.** Es un límite de la línea de comandos en Windows, no un capricho. Para algo grande, el canal es el propio repositorio: que un paso escriba \`docs/plan.md\` y el siguiente lo lea.

**Una cadena no cruza repositorios**, porque lo que de verdad se traspasa es el árbol de trabajo.
`;

export const AGENTS_GUIDE_EN = `# Agents — Manual

This view has three pieces: **agents** (who does the work), **tasks** (one assignment) and **chains** (several agents, one after another).

## 1. Agents

An agent is a **role with its own engine**: name, provider, model and instructions. Defined once, reused.

Open them with the people button in the header. It is **the same roster** as Settings → SDD and the AI chat's agent picker — there are not two lists to keep in step.

What you gain over retyping the prompt every time:

- **Routing per role.** The documenter on a cheap model, the reviewer on an expensive one, without touching global settings.
- **Standing instructions.** "You are a meticulous reviewer, don't reformat what you don't touch" is written once.
- **Identity.** Group tasks by agent and know who did what weeks later.

> An agent **with no model does not use its engine**: the app falls back to the normal chat routing, so it would answer on a different engine than the one it names. The view flags it in orange; fix it before using it.

## 2. Tasks

A task is **one goal handed to one agent, worked on in one repository**. Its turns are an ordinary conversation: same transcript, same live log, same stop button.

Step by step:

1. **New task** (or \`Ctrl/⌘+N\`): pick the agent, the repository and the goal.
2. It starts on its own. Go do something else — it keeps running while you switch views or workspaces.
3. Come back when it says **Your turn**: it finished a turn and is waiting on you.
4. Review what it did with \`···\` → **Review changes**, which takes you to that repository's real diff.
5. Move up a model when it gets hard: the chip in the composer changes it on any turn.

**The agent is fixed when the task is created; the model is not.** Its instructions are already in the thread and the engine already holds the session — swapping it midway would silently rewrite who authored half the conversation.

## 3. Chains

A chain hands **one agent's answer to the next**, in one repository. The usual shape: Architect → Implementer → Reviewer.

1. **New chain** (the link button): repository, objective, and the ordered steps with one instruction each.
2. Tick **"Review before running this step"** wherever you want to step in.
3. **Start chain.** Step 1 runs as an ordinary task and, when it answers, step 2 starts by itself with what came before folded in.
4. At a gate the chain **stops before running** and shows you **the exact message** it is about to send. You can edit it — what you edit is what gets sent.
5. If something fails the chain stops and waits: *Retry step*, *Skip step* or *Abort*.

Every step is its own conversation, so **you can chain different engines** (Claude → Codex). The price is that each step re-reads the repository from scratch.

## Limits — read these

**Agents edit your real working copy.** Every turn takes a restore point first, but this is not a sandbox: there is no container or worktree isolation.

**One agent at a time per repository.** There is no queue behind it: two engines on one folder would take restore points over each other. To work in parallel, spread across repositories. A chain that finds the repository busy **waits**; it does not fail.

**Nothing starts on its own.** Not on app restart, not with the window closed to the tray. If the app was killed mid-step, you will find the chain *Paused — interrupted* with a **Resume** button. Work from a step that did finish is kept.

**A chain cannot tell whether a step succeeded.** It advances because the turn returned text, not because the result is right. A reviewer that writes "this is wrong" finishes the chain green. **Gates are the only real answer, and they need you to look.**

**No loops, no branches.** A reviewer cannot re-trigger the implementer. At most 8 steps, 3 attempts each, and nothing retries by itself.

**The handoff between steps is cut at 6,000 characters.** That is a Windows command-line limit, not a preference. For anything large the channel is the repository itself: have one step write \`docs/plan.md\` and the next read it.

**A chain does not cross repositories**, because what really gets handed over is the working tree.
`;
