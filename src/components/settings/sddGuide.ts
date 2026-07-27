/**
 * Static, read-only manual for the SDD / Harness section — a wiki that explains what SDD and a
 * harness are, what this section lets you do, and how to configure it. Not editable and not stored
 * per workspace; it's orientation content, picked by the app's language.
 */

export const SDD_GUIDE_ES = `# SDD y Harness — Manual

Esta es una guía de lectura para entender qué son **SDD** y **harness**, qué puedes hacer con esta sección y cómo configurarla. No es un proceso obligatorio ni algo para imponer a un equipo — es orientación.

## ¿Qué es SDD?

**SDD (Spec-Driven Development)** = "desarrollo guiado por especificaciones". La idea: **antes de programar, escribes una especificación (spec)** de lo que se va a hacer. Luego el código **implementa** esa spec y la revisión **valida** contra ella.

En vez de "programar y ver qué sale", defines primero *qué* se resuelve y *cómo se verifica*, y recién después ejecutas. Reduce retrabajo y ambigüedad.

## ¿Qué es un harness?

Un **harness** (arnés) es el conjunto de **roles + reglas + etapas** que orquesta *cómo* se trabaja, de forma repetible. Hace explícito el proceso: en lugar de depender de la memoria de cada quien, el flujo queda escrito y es reproducible.

Un harness típico combina:
- **Roles/agentes** — quién hace qué (y con qué modelo de IA).
- **Etapas** — por qué fases pasa el trabajo.
- **Reglas** — invariantes que no se rompen.

## ¿Para qué sirve esta sección?

Aquí **defines tu propio SDD/harness** en la app: los **agentes** (roles con su modelo y su prompt) y las **etapas** de tu flujo. Todo lo configuras tú — **nada viene prearmado**.

Tiene dos pestañas de configuración:

### 🧑‍💻 Agentes
Cada agente es un **rol** de tu proceso, con:
- **Nombre** (p. ej. \`spec-author\`, \`implementer\`, \`reviewer\`).
- **Rol** — una línea de qué hace.
- **Modelo** — qué modelo de IA usa ese rol.
- **Prompt** — instrucciones propias del rol (opcional).
- **On/off** — para activarlo o no.

Consejo: **asigna el modelo según cuánto razonamiento pide el rol.** Diseñar una spec pide un modelo fuerte; mover estados o tareas mecánicas, uno más liviano y barato.

### 🔀 Etapas
Las **fases** por las que pasa una tarea, una por línea. Por ejemplo:

\`\`\`
Intake
Spec
Implementar
Review
Done
\`\`\`

Definen el "pipeline" de tu flujo.

## Cómo configurarlo (paso a paso)

1. Ve a la pestaña **Agentes** y agrega los roles de tu proceso. A cada uno ponle su **modelo** y, si quieres, un **prompt**.
2. Ve a **Etapas** y escribe las fases de tu flujo, **una por línea**.
3. Listo: esa es tu definición de SDD/harness para este workspace.

## Buenas prácticas (breve)

- **Specs claras:** objetivo, alcance (y fuera de alcance), criterios de aceptación e invariantes.
- **Revisa con otro rol:** quien implementa no se auto-aprueba.
- **Ante la duda, pregunta:** no asumas requisitos ambiguos.
- **Modelo acorde al rol:** razonamiento alto → modelo capaz; mecánico → modelo liviano.
- **Un solo lugar de verdad** para el estado de cada tarea, y muévelo apenas cambia la realidad.

## Nota sobre el estado actual

Por ahora esta sección es **configuración y orientación**: guardas tus agentes y etapas. La parte **operativa** —un tablero de tareas por etapa y ejecutar el flujo— es una fase siguiente. Es decir, definir agentes/etapas aún **no cambia** lo que hace la IA en las otras funciones; es tu plano del proceso.
`;

export const SDD_GUIDE_EN = `# SDD & Harness — Manual

A read-only guide to understand what **SDD** and a **harness** are, what this section lets you do, and how to configure it. It's orientation, not a mandatory process.

## What is SDD?

**SDD (Spec-Driven Development)** means: **before writing code, you write a specification (spec)** of what will be done. Then the code **implements** that spec and the review **validates** against it.

Instead of "code and see what happens", you first define *what* is being solved and *how it's verified*, then execute. Less rework, less ambiguity.

## What is a harness?

A **harness** is the set of **roles + rules + stages** that orchestrates *how* work happens, repeatably. It makes the process explicit: instead of relying on everyone's memory, the flow is written down and reproducible.

A typical harness combines:
- **Roles/agents** — who does what (and with which AI model).
- **Stages** — the phases work moves through.
- **Rules** — invariants that don't get broken.

## What is this section for?

Here you **define your own SDD/harness** in the app: the **agents** (roles with their model and prompt) and the **stages** of your flow. You configure everything — **nothing is preset**.

It has two configuration tabs:

### 🧑‍💻 Agents
Each agent is a **role** in your process, with:
- **Name** (e.g. \`spec-author\`, \`implementer\`, \`reviewer\`).
- **Role** — a one-liner on what it does.
- **Model** — which AI model that role uses.
- **Prompt** — its own instructions (optional).
- **On/off** — enable it or not.

Tip: **pick the model by how much reasoning the role needs.** Designing a spec wants a strong model; moving statuses or mechanical work, a lighter, cheaper one.

### 🔀 Stages
The **phases** a task moves through, one per line. For example:

\`\`\`
Intake
Spec
Implement
Review
Done
\`\`\`

They define your flow's "pipeline".

## How to configure it (step by step)

1. Go to the **Agents** tab and add your process's roles. Give each its **model** and, if you want, a **prompt**.
2. Go to **Stages** and write your flow's phases, **one per line**.
3. Done: that's your SDD/harness definition for this workspace.

## Best practices (brief)

- **Clear specs:** goal, scope (and out-of-scope), acceptance criteria, invariants.
- **A different role reviews:** whoever implements doesn't self-approve.
- **When in doubt, ask:** don't assume ambiguous requirements.
- **Model to match the role:** high reasoning → capable model; mechanical → light model.
- **One source of truth** for each task's status, moved as soon as reality changes.

## Note on the current state

For now this section is **configuration and orientation**: you save your agents and stages. The **operational** part — a task board by stage and running the flow — is a next phase. So defining agents/stages doesn't yet **change** what the AI does elsewhere; it's your blueprint of the process.
`;
