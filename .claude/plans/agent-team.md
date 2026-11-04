# Equipo de agentes — plan

Pedido (2026-11-03): un equipo virtual configurable. Le doy **una tarea** y el equipo reacciona:
me pregunta, se reparte el trabajo, trabaja **en paralelo**, itera entre sus miembros y deja **todo
en la rama que yo elija**, en **1 o N repositorios**. Tiene que verse **cómo trabajan y se comunican**.
Es configurable **cuándo pide permiso** y **si hace commit o no**. Vive dentro de **Tareas**.
Requisito transversal: **extremadamente flexible**.

---

## 0. Qué existe hoy (revisión de la app Agentes, 2026-11-03)

| Pieza | Estado | Dónde |
|---|---|---|
| Roster de agentes (rol, proveedor, modelo, effort, cuenta, prompt) | ✅ (effort desde hoy) | `AgentEditorModal`, `workspace_agents` |
| Tareas (1 repo, worktree opcional, turnos headless) | ✅ | `agentsStore.runTurn` → `send_chat_message` |
| Cadenas: pasos en orden, compuertas, check, `on_pass/on_fail`, revisor con vueltas | ✅ lineal | `queries::claim_next_chain_step`, `chainStore.pump` |
| Multi-repo en cadenas (≤16 repos, `"*"` expande por repo) | ✅ secuencial | `expand_steps`, `agent_chain_repos` |
| Memoria compartida de la cadena | ✅ | `chain_memory.rs` → `.codeflow/memory/<id>/` |
| Carreras (N agentes, mismo objetivo, worktree cada uno) | ✅ 1 repo, sin merge | `batch_id`, `RacePanel` |
| Paralelismo visible | ✅ parcial | `WorktreeGrid` (tarjeta + `AiRunLog` por agente) |
| `cf ask/choose/done/notify` | ✅ **solo en terminales** | `agentcli.rs`; headless no tiene `CODEFLOW_PORT/TOKEN` |
| Helpers git (merge, ff, cherry-pick, commit, worktree, conflictos) | ✅ | `git/merge.rs`, `git/history.rs`, `git/worktree.rs` |
| Grafo en vivo | ❌ (hay `@xyflow/react` en Flujos/Contenedores/Arquitectura) | `TopologyCanvas.tsx` es la plantilla más simple |

**Huecos que este plan tiene que cerrar:**
1. Una cadena ejecuta **un paso a la vez** y en **lista fija** (sin DAG, sin fan-out/fan-in). Un paso solo recibe **un** output anterior.
2. Los pasos de cadena **no usan worktrees**: editan la copia principal, serializados por repo.
3. **Nada hace commit, merge o push**, y no existe la "rama destino". Los worktrees salen del HEAD actual: no se puede elegir la base.
4. **Nadie planifica de forma dinámica**: ningún agente puede crear trabajo nuevo. Solo el plan híbrido arma ítems, y en serie.
5. **No existe el mensaje como objeto**: no queda registro de "A le pasó X a B" ni de "QA le preguntó a Dev".
6. Las preguntas no llegan al usuario: los pasos de cadena no reciben `QUESTION_RULES` y `QuestionCard` es de solo lectura en tareas.
7. Los permisos son binarios (`acceptEdits` o solo lectura) y **no hay política de commit**.
8. `cf done` no cambia el estado de la tarea. El comentario de `agentsStore.ts:519` sobre el lease ya no es cierto.

---

## 1. Modelo

```
Equipo (plantilla reutilizable)            Corrida de equipo (una tarea concreta)
├─ miembros: agentes del roster + rol      ├─ objetivo + repos (1..N) + rama destino por repo
├─ líder (un miembro, o "plan fijo")       ├─ política efectiva (la del equipo, editable por corrida)
├─ política (permisos, commit, merge…)     ├─ grafo de trabajo (DAG de ítems) ← lo escribe/revisa el líder
└─ reglas de ruteo (opcional)              ├─ rama de integración por repo
                                           └─ canal: mensajes tipados entre miembros y contigo
```

### 1.1 Equipo (`agent_teams`, `agent_team_members`)
- **Miembro** = agente del roster + `role_tag` libre (`arquitecto`, `dev`, `qa`, `docs`, …) + capacidades:
  `edits` (escribe / solo lectura), `max_parallel` (cuántos ítems a la vez, 1 por defecto),
  `repos` (todos o una lista), `escalate_to` (otro miembro o modelo, para cuando falla dos veces).
  El modelo, el effort y la cuenta salen del agente: no hay segunda configuración que se desfase.
- **Líder**: un miembro (con modelo barato por defecto) **o** `plan fijo`, donde el usuario dibuja el DAG
  y no planifica nadie. Este segundo modo es una cadena con paralelismo y cubre a quien no quiere un líder.
- **Reglas de ruteo** (opcionales y deterministas, se evalúan antes que el líder):
  "toca `**/*.sql` → `dba`", "etiqueta `security` → `qa` con effort high". El líder ve qué reglas aplicaron.

### 1.2 Política (JSON versionado, presets + override por corrida)
| Campo | Valores | Defecto |
|---|---|---|
| `approve_plan` | sí / no | sí |
| `approve_before_code` | nunca / primer ítem / cada ítem que escribe | nunca |
| `approve_merge` | nunca / por repo / al final | al final |
| `approve_risky` | `cf ask` para lo destructivo (siempre activo) | siempre |
| `questions` | el líder puede preguntarme / solo al planificar / nunca (decide solo y lo anota) | puede |
| `commit` | ninguno (dejar cambios sin commit) / un commit por ítem / squash por repo al integrar | por ítem |
| `commit_style` | libre / conventional / plantilla | conventional |
| `integrate` | dejar rama de integración / merge a rama destino / squash / rebase / abrir PR | dejar rama |
| `push` | no / sí (solo si `integrate` lo necesita) | no |
| `conflicts` | un miembro los resuelve (cuál) / preguntarme | miembro integrador |
| `checks` | comandos por repo (`pnpm test && pnpm build`) y cuándo (por ítem / al integrar) | al integrar |
| `review` | quién revisa a quién, exigencia (correcto/pulido), vueltas | qa revisa lo que escribe dev, 3 vueltas |
| `budget` | máx. ítems en paralelo, rondas del líder, despachos, costo USD, tiempo | 3 / 6 / 64 / — / — |
| `escalation` | escalera de modelos al fallar (haiku → sonnet → opus) | off |

Presets: **Autónomo** (aprueba solo el merge), **Supervisado** (plan + merge), **Paso a paso** (cada ítem).
El usuario elige uno y toca lo que quiera. Cada corrida guarda una copia de la política, igual que las tareas copian el agente.

### 1.3 Grafo de trabajo (`agent_team_items`)
Ítem = `{member, repo, kind, instruction, depends_on[], status, task_id, worktree, branch, commit, output}`.
`kind` ∈ `work` (escribe) · `investigate` (solo lectura) · `review` (revisor existente, `chain_review.rs`) ·
`check` (comando) · `integrate` (merge a la rama de integración) · `ask` (pregunta al usuario).
- **Fan-in real**: un ítem recibe los outputs de **todas** sus dependencias, no solo del anterior.
- **El líder replanifica** con un tope (`budget.rounds`). Lo llaman al terminar el plan inicial, cuando un ítem
  falla o es rechazado y cuando llega una pregunta que no sabe contestar. Responde con un bloque
  ```` ```equipo ```` validado: `add_items`, `cancel_items`, `ask_user`, `message`, `finish`.
  Lo que no valida se descarta y queda anotado, como `ground_archify_answer`.
- **Sin ciclos libres**: "QA rechaza → Dev corrige" no es una arista hacia atrás. Es un ítem nuevo con la
  retroalimentación como entrada, y lo cuentan las vueltas del revisor. El grafo sigue siendo un DAG y el bucle tiene techo.

### 1.4 Canal (`agent_team_messages`)
Cada interacción queda como un mensaje tipado con remitente, destinatario y momento:
`handoff` (output → dependiente), `question` (miembro → líder/usuario), `answer`, `finding` (revisor → autor),
`decision` (el líder explica un cambio de plan), `status` (empezó/terminó/falló), `merge` (integró, hubo conflicto).
Los miembros pueden escribirse **explícitamente** con un bloque ```` ```equipo {"para":"qa","tipo":"pregunta",…} ````
en su respuesta. Si es para otro miembro, se le entrega en su próximo ítem (o como turno nuevo si el ítem sigue vivo).
Si es para el usuario, aparece en la bandeja con `QuestionCard` y se puede responder.

---

## 2. Ramas y repositorios

Por cada repo de la corrida:
1. **Base** = la rama destino elegida (`main`, `develop`, …; por defecto la actual).
   Hay que extender `git::worktree::add` con `start` = punto de partida. Hoy siempre es `None`.
2. **Rama de integración** `codeflow/team/<slug>` en un **worktree de integración** propio.
   Nunca se toca la copia del usuario.
3. Cada ítem `work` corre en **su worktree** `codeflow/team/<slug>/<item>`, ramificado desde la integración
   **en el momento de empezar**, así ve lo que ya integraron sus dependencias.
4. Al aprobarse (check + revisor si los hay): commit según política, luego merge o cherry-pick a integración
   (`git/merge.rs`, con `git::write_lock`). Si hay conflicto, se crea un ítem `integrate` para el miembro
   integrador con las versiones (`conflict_versions`) o se te pregunta.
5. Al final, por repo, se aplica `integrate`: dejar la rama, merge/squash/rebase a destino, o PR por el proveedor VCS
   que ya usa la app. Cada paso pasa por `approve_merge`.
6. Limpieza: los worktrees de ítem se borran al integrar (solo si están limpios, como hoy). Las ramas se conservan
   hasta que integras o descartas la corrida.

Un ítem es de **un** repo y puede leer los demás con `--add-dir`, como ya hacen los híbridos.
Con `commit = ninguno`, la integración aplica el diff sin commit y la rama destino queda con los cambios sin
commit para que los revises. Se avisa de que, en ese modo, el paralelismo entre ítems del mismo repo se serializa
al integrar.

---

## 3. Ejecución

- **El backend decide, el frontend ejecuta**, igual que las cadenas: `claim_ready_team_items(run, n)`
  devuelve **todos** los ítems listos (dependencias hechas, bajo `max_parallel` global y por miembro)
  y `complete_team_item` cierra uno y desbloquea a otros. Así el paralelismo sale de la consulta, no de un `pump` por paso.
- Cada ítem es una **tarea de agente normal** (`create_agent_task_with_id` con worktree y `batch_id` = corrida).
  Hereda historial, costo, `AiRunLog`, cuentas, respaldos por cuota y recuperación tras reinicio.
- **`cf` en turnos headless**: inyectar `CODEFLOW_PORT/TOKEN` con un token de alcance limitado a la corrida.
  Así `cf ask` respeta `approve_risky` y `cf done` cierra el ítem también fuera de las terminales.
  Es lo que más riesgo tiene del plan y va detrás de su propia bandera.
- **Miembros en terminal**: un ítem puede correr en el CLI interactivo (layout Worktrees, `startAgentCli` con
  modelo y effort, ya hecho hoy). Lo cierra `cf done`. Sirve para quien quiere *ver* a Claude Code trabajando.
- Reinicio: misma regla que las cadenas. Se recoge lo que terminó, lo demás se marca `interrupted`
  y la corrida queda `paused`. Nunca se reanuda sola.

---

## 4. Interfaz (dentro de Tareas)

- **Árbol**: nueva sección **EQUIPOS** (plantillas) y las corridas como un grupo más, igual que `ChainGroup`
  (una regla: cada ítem en una sola sección). «Nueva tarea ▾» gana **«Nueva tarea de equipo»**.
- **Configurar equipo** (modal): miembros (del roster, con rol y capacidades), líder, preset + política
  en pestañas (Permisos · Git · Revisión · Presupuesto), reglas de ruteo. Se guarda como plantilla.
- **Lanzar**: objetivo, equipo, repos (1..N) con **rama destino por repo** y override de la política.
- **Vista de corrida** (columna central), tres vistas del mismo estado:
  1. **Grafo en vivo** (`@xyflow/react`, layout por profundidad de `lib/flows/spec.ts:autoLayout`):
     nodos = ítems agrupados por miembro (color/glifo del proveedor, `ThinkingOrb` mientras piensa),
     aristas = dependencias. Un handoff anima la arista y una pregunta pulsa el nodo.
     Clic en un nodo abre su tarea (transcripción + diff).
  2. **Canal**: los mensajes en orden ("Arquitecto → Dev: contrato listo", "QA → Dev: 2 hallazgos must",
     "Líder: añado ítem de migración"). Las preguntas para ti se responden ahí mismo.
  3. **Carriles**: una columna por miembro con su `AiRunLog` en vivo (como `WorktreeGrid`), para ver el paralelismo.
  Arriba: estado, progreso por repo, presupuesto consumido, ramas (integración → destino) y botones
  Pausar / Aprobar / Integrar / Abortar.
- **Bandeja de atención**: las preguntas y aprobaciones de equipo entran en `AgentActivity` / «Te necesitan»
  y en el teléfono (`remotectl`), como las compuertas.

---

## 5. Fases

| Fase | Qué | Días |
|---|---|---|
| **T0 — Cimientos** | `worktree::add` con base; `QuestionCard` contestable en tareas; `cf done` cierra la tarea; corregir el comentario del lease | 1–2 |
| **T1 — Equipo y política** | tablas `agent_teams`/`members`, política JSON + presets, modal Configurar, sección EQUIPOS | 3 |
| **T2 — Grafo con plan fijo** | `agent_team_runs`/`items`, `claim_ready_team_items` paralelo, fan-in, ítems como tareas con worktree, lanzar con N repos | 4–5 |
| **T3 — Ramas** | integración por repo, commit por política, merge/conflictos→ítem `integrate`, aplicar a destino/PR, limpieza | 4 |
| **T4 — Líder** | bloque ```` ```equipo ````, validación, replanificación con tope, ruteo determinista, escalera de modelos | 4 |
| **T5 — Canal y preguntas** | `agent_team_messages`, mensajes entre miembros, bandeja, aprobaciones según política, teléfono | 3 |
| **T6 — Vista** | grafo en vivo + canal + carriles + barra de corrida | 4 |
| **T7 — `cf` headless** | token por corrida, `cf ask`/`done` en turnos headless, detrás de bandera | 2 |
| **T8 — Pruebas** | Rust: claim paralelo, fan-in, presupuestos, integración con conflicto (repo temporal), validación del bloque del líder; vitest: política, grafo, canal | continuo |

Orden: T0 → T1 → T2 → T3 → T5 → T4 → T6 → T7. Con el plan fijo y las ramas (T2–T3) ya hay algo útil antes de que exista el líder.

---

## 6. Decisiones del usuario (2026-11-03)
1. **Integración**: el resultado queda **en la rama destino** (por defecto `main`): merge desde la rama de
   integración tras `approve_merge`. La rama de integración sigue existiendo como paso intermedio.
2. **PR**: después (no en T3).
3. **Líder**: totalmente configurable por equipo — cualquier miembro, cualquier modelo/effort, o plan fijo.
   El usuario arma el equipo como quiera; no hay roles impuestos.
4. **`cf` en headless**: sí (T7).
5. **Miembros en terminal**: sí, en la primera versión (ítem con `run_in = terminal`).

---

## 7. Estado (2026-11-03, sin commit en main)

Construido: T0 (base de worktree, `cf done` cierra el ítem en terminal), T1–T7.
- Backend: `src-tauri/src/team/{mod,protocol,gitops}.rs` y `commands/team_cmd.rs`. Tablas `agent_teams`,
  `agent_team_runs`, `agent_team_repos`, `agent_team_items`, `agent_team_messages`.
- Frontend: `types/team.ts`, `lib/tauri/teamCommands.ts`, `state/teamStore.ts`, `components/agents/team/*`
  (editor, lanzador, sección EQUIPOS, detalle con grafo/canal/miembros).
- Probado: tests de protocolo, planificador y git, más dos tests de punta a punta del motor sin IA.

Pendiente o sin verificar:
- No se probó en la app real ni visualmente.
- `QuestionCard` contestable en tareas normales: no se hizo (las preguntas del equipo se contestan en el canal).
- PR: descartado por ahora.
- Teléfono / «Te necesitan»: las compuertas de equipo no aparecen ahí todavía.
- Revisor con rutas protegidas: no.
- Ítem `investigate` sin `--add-dir` a los otros repos: solo se le dan las rutas en el mensaje.
