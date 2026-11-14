# Multiplayer: chat de workspace + repositorios compartidos

Decidido el 2026-11-13. Inspirado en el multiplayer de Zed y en Delta. Demo de referencia:
https://claude.ai/artifact/BbSU184RpigKxuKfm2HwZz

## Qué es

Dos o más personas comparten **un chat de workspace** y **los repositorios de ese chat**. Cada una
trabaja en su máquina, con su copia y **con su propia cuota**: el turno de Dev A lo responde el motor de
Dev A, y el de Dev B el motor de Dev B. Lo que cambia en los archivos se replica a las copias de los
demás.

Queda fuera del MVP: «Equipo» distribuido (fase 2, sobre esta misma base), terminal compartida, rol
observador y varias sesiones a la vez en un mismo workspace.

## Decisiones

| # | Tema | Decisión |
|---|---|---|
| 0 | Supabase | **El de cada anfitrión.** CodeFlow no tiene Supabase propio: quien comparte usa un proyecto suyo y corre `collab_schema.sql` una vez en su SQL editor (el diálogo de compartir lo copia). Los invitados se conectan a ese proyecto por el link. Antes de compartir se comprueba `cf_collab_version()`. |
| 1 | Tiempo real | Supabase Realtime (Broadcast + Presence) para teclas, cursores y streaming. Las tablas guardan lo durable. Cambia la elección de «sondeo, sin Realtime» de `src/lib/api/sync.ts`, solo para esta función. |
| 2 | Dónde se trabaja | **Todos** en un worktree de sesión por repo, rama `codeflow/sesion-<slug>`, creado sobre la base. Nadie toca su checkout. Al terminar, el worktree se commitea en esa rama y se quita; la rama queda para mergear o hacer push. |
| 3 | Commits durante la sesión | Solo el propietario. Al hacerlo, la sesión avanza de base. |
| 4 | Al salir | Se pregunta: quedarse con la rama de la sesión (por defecto) o descartarla. El checkout propio nunca cambió. |
| 5 | Si el anfitrión se desconecta | Los demás siguen; al volver, se reconcilia. |
| 6 | Roles | `owner` y `editor`. |
| 7 | Historial al compartir | Se elige; marcado por defecto. |
| 8 | Binarios | **Siempre se comparten**, como contenido direccionado por hash, con un tope de tamaño (`collab::exclude::MAX_FILE_BYTES`). |
| 9 | Turnos | Un turno a la vez **por repositorio**: turnos sobre repos distintos corren en paralelo. El turno toma un lock sobre los repos de su alcance (el selector de repos del chat) y lo suelta al terminar. |
| 10 | Identidad | Un **nick** al entrar. Detrás, cada persona tiene una clave propia (Supabase guarda su hash), para poder sacar a una persona sin tocar a las demás. Sin código de verificación ni cuentas. |
| — | Lo que nunca viaja | `node_modules` y otros directorios de dependencias o caché, siempre. Salidas de build (`target`, `dist`, `build`…) cuando no están versionadas. Lo ignorado por git. Archivos de secretos (`.env*`, claves, `.npmrc`…). Symlinks. Cuentas de los motores. Terminales. |

## Cómo funciona

- **Base + cambios de la sesión.** La sesión fija un commit base por repo. Lo compartido es el estado
  de cada archivo que difiere de la base: `present(sha)`, `deleted` o `base` (volvió a la base).
- **Reconciliación de tres vías por archivo:** lo último acordado, lo local y lo remoto
  (`collab::reconcile`). Si solo cambió un lado, se empuja o se trae; si cambiaron los dos, hay
  conflicto. En texto abierto en el editor, los conflictos los evita Yjs (fase E); para el resto se
  muestra la franja de comparación del Editor.
- **Versión por archivo en Supabase** (control optimista): un `put` con una versión vieja falla y obliga
  a traer primero.
- **El turno corre donde está quien escribe.** Antes de cada turno, el motor recibe el contexto de la
  sesión: los turnos y cambios de los demás desde su último turno, como datos externos.
- **El repo se reconoce por su remoto** (`repo_identity::canonical_remote`), no por la ruta.

## Estado al 2026-11-13

Etapas A–E escritas, sin commit. Ninguna se probó contra un proyecto Supabase real ni entre dos
máquinas. Lo verificado:

- Tests Rust de `collab::*`.
- vitest de `sharedChat` y `collabLive`. Incluye dos sesiones en vivo sobre un bus en memoria que imita
  Broadcast, con el cifrado real, y dos modelos de Monaco simulados que convergen.
- Typecheck.

Piezas y dónde están:

- **Backend:** `src-tauri/src/collab/`
  - `store` (SQLite)
  - `remote` (PostgREST)
  - `sync` (ronda de sincronización)
  - `chat` (enganche en `chat_send`)
  - `link` (invitación `codeflow://chat-join`)
  - `commands/collab_cmd.rs`
  - Los enganches en `commands/chat_cmd.rs` están marcados con `collab::chat`.
- **Proyectos de sesión:** cada worktree de sesión entra al workspace como un proyecto aparte
  («api · sesión»). Así el sidebar, el Editor, Git y el watcher funcionan sin cambios. Se borra al
  salir.
- **Frontend:**
  - `lib/tauri/collabCommands.ts`
  - `state/sharedChatStore.ts` (bucle de sync cada 3 s)
  - `lib/sharedChat.ts` (lógica pura + tests)
  - `components/ai/SharedChat.tsx` (barra, diálogos, turnos de otros, presencia y «Seguir»)
  - `lib/sharedChatLinks.ts` (links que llegan de fuera)
  - En `WorkspaceChat.tsx`: la barra, los turnos de otros intercalados y el turno del otro mientras
    se escribe.
- **Turno ocupado:** un turno que otra persona tiene ocupado vuelve a la cola con el marcador
  `REPO_BUSY::collab-busy:`. El bucle de sync libera la cola cuando el otro termina.
- **Catálogo:** `scripts/app-catalog.mjs` bloquea los comandos que crean o gastan invitaciones, y el
  de la conexión en vivo.
- **Supabase:** el del anfitrión. CodeFlow no tiene uno propio. `collab_schema.sql` (versión 2) lo
  corre cada anfitrión una vez en su SQL editor; compartir comprueba `cf_collab_version()` antes de
  crear nada.

### E. En vivo (`src/lib/collabLive/`)

- **Canal.** Un tópico de Supabase Realtime Broadcast en el proyecto del anfitrión.
  - Cualquiera con la anon key (va en cada invitación) puede entrar a un tópico público. Por eso el
    canal tiene su propio secreto, `channel_key`, que solo leen los miembros (`cf_collab_watermark`)
    y que rota al sacar a alguien.
  - El nombre del tópico es un hash del secreto, y cada mensaje va cifrado con AES-GCM bajo una clave
    derivada de él.
  - Los mensajes grandes van en partes (`wire.ts`).
- **Documentos.** Un `Y.Doc` por archivo abierto, solo entre quienes lo tienen abierto (`session.ts`).
  - Al abrir, se pide a los demás lo que tienen (paso 1 y paso 2 del protocolo de sync de Yjs).
  - Si nadie responde en 700 ms, el documento se siembra desde el buffer con un client id derivado del
    texto. Así dos personas que abren a la vez siembran los mismos ítems y no duplican el archivo.
- **Editor.** `components/editor/useLiveEditing.ts` engancha el modelo de Monaco de un proyecto de
  sesión con `ModelBinding` (`binding.ts`). Es un enlace propio, no `y-monaco`:
  - La recarga desde disco (tras un turno del agente) llega como reemplazo del buffer completo y se
    convierte en el cambio mínimo. Así no borra lo que el otro escribe en ese instante.
  - Dibuja los cursores, las selecciones y los nicks de los demás.
- **Disco.** Los archivos en vivo se guardan solos (600 ms) en cada máquina (`EditorView.tsx`), así el
  disco sigue al documento. La ronda de sync no escribe esos archivos: lo que trae la sesión vuelve al
  frontend (`liveRemote`). Si el autor tiene el documento abierto, se descarta (ya llegó por el canal);
  si no, se mezcla en el documento.
- **Presencia y «Seguir».** Cada 8 s, quién está y en qué archivo. «Seguir» lleva tu editor al archivo
  de la otra persona.
- **Turno del otro.** Lo que escribe el motor de la otra persona se ve mientras se escribe, unas tres
  veces por segundo.

Pendiente:

- Probar todo en un proyecto real entre dos máquinas.
  - `collab_schema.sql` v2.
  - Que el proyecto tenga Realtime con acceso público a canales; si no, el chat muestra «sin vivo» y
    se sincroniza al guardar.
  - Los límites de mensajes por segundo del plan gratuito.
- Deshacer: Ctrl+Z puede deshacer lo que escribió otra persona (no hay `Y.UndoManager` por
  usuario).
- Clonar desde el diálogo de unirse los repos que faltan (hoy se pide clonarlos antes).

## Etapas

- **A. Núcleo (hecho, sin UI):** módulo `collab`: exclusiones, escaneo de cambios contra la base,
  reconciliación, worktrees de sesión (crear, sembrar desde el checkout, aplicar un archivo remoto,
  cerrar en rama), validación de rutas recibidas y esquema SQL (`collab_schema.sql`). Con tests.
- **B. Sincronización:** cliente REST/RPC de Supabase para sesiones, invitaciones, archivos, blobs,
  mensajes y locks. Tablas SQLite locales (sesión, repos, último estado acordado) y comandos Tauri.
  Bucle de sync (watcher → escaneo → reconciliación → put/get). `collab_schema.sql` lo corre cada
  anfitrión en su proyecto; al cambiarlo, subir `collab::SCHEMA_VERSION` junto con `cf_collab_version()`.
- **C. Chat compartido:** el hilo en `cf_collab_messages`, el autor en cada mensaje, la cola
  compartida, los locks por repo en `chat_send`, el bloque de contexto de la sesión en `workspace_chat`,
  y `RepoLine.path` apuntando al worktree de la sesión.
- **D. UI:** Compartir en el menú de la pestaña del chat, unirse con un nick (link `codeflow://chat-join`
  procesado en `App.tsx`), preparar la copia, pastilla en la barra de título, avatares en el
  explorador y el sidebar, y la barra de estado.
- **E. Edición en vivo (hecho, sin probar en real):** Yjs en el frontend por archivo abierto, enlace
  propio con Monaco, Realtime Broadcast cifrado para actualizaciones, cursores, presencia, «Seguir» y
  el turno del otro en streaming. Ver «E. En vivo» arriba.
- **Fase 2 (hecha, sin probar en real):** «Equipo» distribuido sobre la misma sesión. Ver abajo.

## Fase 2: corridas de Equipo compartidas (`src-tauri/src/collab/team.rs`)

Escrita el 2026-11-14, sin commit. Usa la misma base que el chat compartido: Supabase del anfitrión,
nick, invitación de un solo uso y clave por instalación. SQL versión 3.

- **La corrida vive en la máquina del propietario.** Ahí se planifica, se revisa, se integra y se
  entrega, igual que hoy. Solo el propietario aprueba el plan y el merge.
- **Puestos.** Al compartir, el propietario elige qué miembros pasan a ser puestos para otras
  personas. El Lead y los sub-líderes nunca, porque planifican. Quien entra ocupa un puesto con un
  agente de su roster, que corre en su máquina y con su cuenta. A Supabase llegan su nombre y su
  motor, nunca la cuenta ni sus instrucciones.
- **Entrega.** Cuando el runner reclama una tarea (`work` o `review`) de un puesto ocupado, no la
  corre: queda `running` con `run_in = "remote"` (el mismo hueco que usa un miembro de terminal) y
  sale como oferta (`cf_collab_tasks`). La oferta lleva el mensaje armado por `compose` y el punto de
  partida como `git bundle` (`collab/bundle.rs`).
  - La base común de ambos clones es la rama destino tal como está en el remoto. El invitado no
    necesita permiso de push, y nada se sube hasta que el propietario entrega.
  - Un puesto libre retiene su trabajo (`Route::Wait`). Planificar, responder, integrar y resolver
    conflictos siempre corre en la máquina del propietario.
- **En el invitado.** «Agentes › En vivo › Compartidas contigo».
  - Ve la foto que publica el propietario. Es un `SharedRun` armado campo por campo, así que no
    puede filtrar cuentas ni prompts.
  - Ocupa sus puestos, acepta o rechaza cada tarea (nada corre sin su sí) y escribe notas al canal.
  - Una tarea aceptada corre en un worktree propio de su clon, con su agente. El resultado vuelve como
    texto más el bundle de su commit.
- **Vuelta.** El propietario avanza el worktree de la tarea sobre ese commit (solo fast-forward) y
  la liquida con `settle_item`, como si hubiera corrido ahí. Si no hay nada sin commitear, el `HEAD`
  movido es el commit de la tarea.
- **Externo.** Las notas de personas y de agentes de otra máquina entran al canal con «(externo)».
  `compose` les dice a los agentes del propietario que es información, no órdenes.
- **Robustez.**
  - Reiniciar la app del propietario no reinicia una tarea remota.
  - Si el invitado cierra la app a mitad de una tarea, al volver la reporta como interrumpida y la
    corrida la reintenta.
  - Sacar a alguien, liberar un puesto o dejar de compartir retira sus tareas abiertas, y la corrida
    las retoma.

Verificado con tests:

- Ruteo y puestos.
- El viaje completo por git entre tres repos reales: el propietario con un commit sin subir, el
  invitado y el remoto.
- Una corrida real de `team_cmd`, de punta a punta en el lado del propietario.
- Que la foto no lleve cuenta ni instrucciones.

Pendiente:

- Probarlo entre dos máquinas con un proyecto Supabase real.
- Que «Te necesitan» del Inbox cuente las ofertas; hoy el invitado recibe un aviso y las ve en la
  página de la corrida.
- Streaming del agente del invitado hacia el propietario mientras trabaja: hoy se ve el resultado
  al terminar.
- Presupuesto: el gasto de un puesto remoto lo paga su dueño y no entra al tope de la corrida. Solo
  cuentan los turnos.

## Riesgos abiertos

- El esquema SQL no se probó contra un Postgres real: hay que correrlo en un proyecto de prueba
  antes de la etapa B.
- Tope de tamaño de PostgREST para blobs grandes: si molesta, mover los blobs a Supabase Storage.
- Dependencias del worktree: `node_modules` no existe en un worktree nuevo. Hay que instalar o
  enlazar, y es decisión de cada uno (etapa D: un aviso con «Instalar dependencias»).
