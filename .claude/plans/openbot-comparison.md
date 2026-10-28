# OpenBot vs CodeFlow — comparación

Pedido el 2026-10-27: hacer ingeniería inversa de la app instalada **OpenBot** (v0.52.1) y ver qué
mejorar en CodeFlow y qué falta, sobre todo en agentes, manejo de errores y orquestación.

## Método y límites

- **Análisis estático.** No se ejecutó OpenBot. Se leyó su `app.asar` con un parser propio (sin
  descargar nada) y se extrajeron sus contratos TypeScript (`@openbot/contracts`, `user-errors`,
  `logging`, `telemetry`) y partes del bundle del proceso principal (18 MB, minificado).
- **OBSERVADO** = leído en un contrato o en el bundle. **INFERIDO** = deducido de nombres o
  constantes. No se leyó el renderer (la interfaz de tarjetas y toasts es inferida).
- **Licencia: PolyForm Noncommercial.** El repo es público (`nightly-labs/openbot`), pero esta
  licencia no permite uso comercial. Sirve para aprender *qué hace* y *cómo lo diseña*. No se debe
  copiar su código a CodeFlow si CodeFlow se usa comercialmente.
- **Lo que dice cada "CodeFlow:" viene de un grep de los agentes de análisis**, no de leer cada
  módulo. Antes de construir algo, verificar contra el código.
- No se llegaron a leer: importadores de agentes (Grok/Hermes), conectores 1Password/Bitwarden, vault
  e instance-transfer. Y el estado de la sección de actualización de CLIs dentro del plan
  `cli-updates.md`.

## Qué es OpenBot

Espacio de trabajo multiagente local para Codex, Claude y Grok, con 13 proveedores (codex, claude,
grok, opencode, antigravity, cursor, cline, pi, muse, inception, deepseek, openrouter, y ACP
genérico). Un agente es un perfil (proveedor, modelo, esfuerzo, cuenta, acceso, workspace) con un
chat principal y hasta 4 tareas paralelas propias. Todo lo que recibe (usuario, otro agente, rutina)
entra a un buzón y un planificador lo drena por carril.

## Lo que CodeFlow ya hace mejor o igual

| Área | Detalle |
|---|---|
| Cadenas con verificación | OpenBot no tiene `check_command`, ni saltos por exit code, ni bucle supervisor/trabajador. Sus loops de workflow son retroceso sin límite de pasadas. CodeFlow tiene `on_pass`/`on_fail`, gates y topes (`MAX_CHAIN_DISPATCHES`). |
| Flujos | El grafo de workflows de OpenBot es pequeño (trigger, agent, llm, condition, approval, output) y varios nodos declarados no se pueden ejecutar. Flujos es mucho más amplio. |
| Secretos | `cf secret` limpia la salida y nunca entrega el valor. |
| Subagentes | CodeFlow dibuja carriles para 5 proveedores; OpenBot mapea 2 (Claude y Codex). |
| Memoria | Recuperación, anclas a código y revisión de contradicciones son más ricas. |
| Cuentas y cuota | Múltiples cuentas, medidor de cuota y de uso están a la par. |
| Reanudación tras reinicio | `recover_after_restart` + 3 intentos por step es mejor para cadenas. |
| Errores en la interfaz | `ErrorBoundary`, `MorphToast`, motivos de pausa de cadenas. |
| Presupuesto | OpenBot, según sus contratos, no tiene tope de gasto ni kill-switch (INFERIDO). |

## Lo que falta o está a medias en CodeFlow

### Errores y recuperación

| # | Capacidad de OpenBot | Estado en CodeFlow | Tamaño |
|---|---|---|---|
| E1 | **Reanudar solo cuando se renueva la cuota.** Un límite de uso retiene *toda* la cola de esa cuenta y modelo hasta el reset + 30 s (o relectura de uso cada 15 min). | Parcial: la cadena queda pausada hasta que el usuario pulsa «Reanudar». El reset ya se parsea. | M |
| E2 | **Watchdog de silencio.** Un turno sin actividad 5 min y sin herramienta ni pregunta pendiente se cancela con «dejó de responder». | Falta en runs de CLI de IA. | M |
| E3 | **Modelo de respaldo** ordenado (hasta 8); cambia solo ante límite o error del proveedor, vuelve al original cuando termina el límite; el que falló se salta 10 min. | Falta. | M–L |
| E4 | **Un clasificador de errores general** (red, permiso, disco, timeout, no encontrado, conflicto…) con puerta contra salida técnica (trazas, rutas, `SQLITE_*`). | Parcial: solo `AiFailureKind` para IA. | M |
| E5 | **Códigos de referencia copiables** (`errno/ECONNREFUSED`, `http/403/…`) con lista blanca estricta. | Falta. | S |
| E6 | **Estado `uncertain`** para una escritura externa que se interrumpió a medias; claves de idempotencia (24 h) en envíos. | Falta. Relevante para comentarios de PR y mensajes remotos. | S |
| E7 | **Redacción con registro de secretos exactos** (crudo, JSON-escapado y URL-codificado) alimentado por las claves guardadas. | Parcial: `applog::scrub` y `register_secrets` por flujo, sin registro global. | S–M |
| E8 | **Último error persistente por proveedor** (con hora) que sobrevive al toast. | Falta. | S |
| E9 | **Tarjeta «La actualización de X falló»** con Reintentar y Mostrar detalles; bloquea actualizar si el CLI está ocupado o iniciando sesión. | Parcial. Ya hay plan en `cli-updates.md`. | S |
| E10 | **Motivo de salida y vigilante de cuelgue al cerrar** (SIGKILL tras un plazo). | Parcial: `quit_guard`, `shutdown`, hook de pánico. Falta lo otro. | S |
| E11 | **No sobrescribir estado más nuevo o corrupto** (abrir la BD en solo lectura si su esquema es más nuevo que la app). | Falta una regla general. | S |
| E12 | **Parar el auto-arranque tras 3 inicios fallidos** (nació de un bucle que llenó un disco). | Revisar el llama-server local. | S |
| E13 | **Políticas de rutina:** qué hacer si estaba cerrada (omitir / ejecutar una vez) y si el plan está agotado (esperar / omitir). | Parcial: ya recupera con una ejecución; falta la política de plan agotado. | M |
| E14 | Actualizar la app solo si no hay runs activos. | Falta. | S |
| E15 | Reportes de fallo opt-in solo con enums, sin texto libre. | Falta, y puede ser deliberado (CodeFlow no tiene telemetría). Sugerencia: un registro local exportable. | S |

### Agentes

| # | Capacidad de OpenBot | Estado en CodeFlow | Tamaño |
|---|---|---|---|
| A1 | **Cliente ACP genérico** (Agent Client Protocol): cualquier comando que hable ACP queda como agente, con modelos, plan, aprobaciones y ajustes de sesión. | Falta (cada CLI tiene su driver). Sumaría Cursor, Copilot, Goose, Qwen y otros. Es lo de mayor palanca. | L |
| A2 | **Tabla única de capacidades por proveedor** (steer, turnos concurrentes, reporta uso, enforcement de workspace…). | Parcial: la regla de paridad existe, las flags están dispersas. | M |
| A3 | **Steer:** mandar un mensaje a un turno en curso, con cola como alternativa. | Falta. | M |
| A4 | **Cola persistente** con estado por mensaje, reordenar, editar, y motivo visible de espera (límite de tareas, de uso, compactación…). | Parcial: cola en cliente. | M |
| A5 | **Plan persistido por turno** (TodoWrite / update_plan normalizado). | Parcial: se renderizan pasos, no se guarda un bloque de plan. | S–M |
| A6 | **Contexto por categorías** (prompt, memoria, herramientas, skills, resultados, mensajes) y progreso de compactación. | Parcial: hay medidor y `/compact`. | S–M |
| A7 | **Espera durable de un agente** (`await_event`): el agente termina su turno y un evento de una rutina lo despierta. | Parcial: `cf wait` espera servicios; falta la fila «despertar esta petición». | M |
| A8 | **Pregunta lateral** que no escribe en el chat. | Falta. Se apoya en «ramificar chat». | S–M |
| A9 | **Compromiso diferido de memoria** (los cambios se confirman solo si el turno termina). | Falta. | S |
| A10 | **Tareas paralelas por agente persistente** (4 hilos con sesión propia). | Parcial: runs paralelos por repo, no hilos de un agente. | L |
| A11 | **Admisión global de turnos** por memoria, con prioridad al usuario. | Parcial: tope manual y ahorro de energía. | M |
| A12 | **Confinamiento del workspace a nivel de SO** (sandbox por proveedor). | Solo flags por CLI. | L |
| A13 | **Tres niveles de permiso** con aviso al ampliarlos; aprobaciones estructuradas (comando, archivo, permisos). | Parcial. | M |
| A14 | Agentes ocultos que conservan datos pero no ejecutan rutinas. | Falta. | S |
| A15 | Plantillas de agente por enlace, con comprobación de «cambió desde que lo revisaste». | Parcial (hay plantillas de tareas y flujos). | S |
| A16 | TTL de la caché de prompt (5 min / 1 h) para Claude Code. | Falta. Verificar la bandera exacta antes. | S |
| A17 | Catálogo de herramientas perezoso (`tool_search` / `tool_describe` / `tool_call`). | Parcial. | S |
| A18 | Reinicio de contexto iniciado por el agente (con interruptor por agente). | Parcial: `/clear` lo inicia el usuario. | S |

### Orquestación

| # | Capacidad de OpenBot | Estado en CodeFlow | Tamaño |
|---|---|---|---|
| O1 | **CLI desde fuera** (`openbot-cli`): `list`, `run --wait`, `status`, `agent set-*`. Códigos de salida 0–5, incluido «necesita a una persona» y «timeout». | Parcial: `cf` solo funciona dentro de un terminal de agente. Útil para CI y scripts. | M |
| O2 | **Mensajería entre agentes** (`send_message` con `expectsReply`, `list_agents`, `read_agent`, `interrupt_agent`). Las respuestas llegan como entregas nuevas, nunca como llamadas bloqueantes (evita deadlocks). | Falta. | L |
| O3 | **Canal con agente líder** que enruta cada mensaje: a un miembro, a una tarea existente, o pregunta. Delegación con `assign` / `transfer` / `result`, dependencias entre tareas y bloqueos de recursos (2 paralelas, 8 asignaciones). | Parcial: hay presencia de runs paralelos, sin bloqueos declarados. | L |
| O4 | **Agentes que crean rutinas, webhooks, agentes y tareas** por herramienta. Regla útil: solo el usuario puede ampliar permisos. | `cf` no tiene verbos de flujos ni rutinas. | M |
| O5 | Regla en el prompt: **prohibir los planificadores del proveedor** (`/schedule`, cron), para que todo sea visible y detenible en la app. | No verificado. | S |
| O6 | Tablas compartidas entre agentes. | Falta. | M |
| O7 | Rutinas publicadas como **feed iCalendar**. | Falta. | S |
| O8 | Resultado «sin novedades» que no notifica (`quiet turn`). | Falta. | S |
| O9 | Cola de entrega con estado `uncertain` para resultados de rutinas. | Falta. | M |

## Prioridad sugerida

1. **E1 + E3 + E2**: continuidad ante cuotas y cuelgues (reanudar solo en el reset, modelo de respaldo, watchdog). Es lo que más duele cuando un agente trabaja sin supervisión, y se apoya en piezas que ya existen (reset parseado, `classify_failure`, pausas de cadena).
2. **E4 + E5 + E8 + E7**: un clasificador general con códigos de referencia, error persistente por proveedor y registro global de secretos. Cada uno es pequeño y juntos dan un manejo de errores uniforme.
3. **O1**: CLI desde fuera, con códigos de salida. Abre CI y automatización.
4. **A2 → A1**: primero la tabla de capacidades por proveedor; sobre ella, el cliente ACP.
5. **A3 + A4 + A7**: steer, cola persistente y esperas durables.
6. **E6 + E13**: estado `uncertain` y políticas de rutina.
7. **O2 / O3 / A10**: solo si el objetivo es agentes persistentes que se hablan entre sí, que es otro producto distinto al actual de cadenas verificadas.

## Relación con los otros planes

- `.claude/plans/agent-loop.md`: lo que OpenBot **no** tiene (revisor con severidades, vueltas con
  convergencia, rutas protegidas) es justo lo que ese plan agrega. Es una ventaja diferencial de
  CodeFlow que conviene mantener.
- `.claude/plans/cli-updates.md`: cubre E9. Conviene sumarle el bloqueo «no actualizar si el CLI está
  ocupado o iniciando sesión» y la distinción entre CLI instalado por el usuario (se actualiza solo)
  y uno gestionado por la app.
- `.claude/plans/multi-repo-architecture.md`: sin relación directa.

---

# Parte 2 — Interfaz, sistema y CLI (segunda pasada)

La primera pasada solo leyó contratos y el proceso principal. Esta lee lo que faltaba: el código fuente
de la interfaz (`@openbot/ui`, 286 componentes por funcionalidad), el catálogo de textos en inglés
(~1.400 claves), la CLI completa (`openbot-cli.mjs`, 15,8 KB), los importadores, los permisos y la
firma del sistema, y el host de base de datos. Cuatro lecturas independientes; cada una comprobó contra
tu código antes de decir que algo falta. Mismos límites: estático, sin ejecutar la app; no se leyeron
todos los componentes, así que las filas «parcial» se apoyan en búsquedas.

## Lo que la primera parte subestimaba

OpenBot es bastante más que un gestor de agentes. Tiene, además: **un navegador integrado que los
agentes manejan** (con toma de control del usuario y traspaso de secretos), **computer use** con un
driver de escritorio, una **isla dinámica** sobre el notch, **voz** (dictado local y en nube, síntesis),
**servidores** como unidad de colaboración (roles, invitaciones, nube de pago), **app móvil** con
notificaciones push, **marketplace** de agentes, skills y apps, **importadores** desde otras apps de
agentes, una **BD compartida** entre agentes, **plugins** con catálogo, y una **CLI externa** con API
local. Gran parte no aplica a CodeFlow (nube de pago, roles, facturación), pero hay ideas valiosas.

## Dónde CodeFlow ya va por delante (confirmado en esta pasada)

| Área | Detalle |
|---|---|
| Voz | Más motores (Parakeet, Canary, whisper.cpp, Kokoro, Piper, clonación), VAD con despertar por voz, y pulsar-para-hablar global. OpenBot no tiene atajo global. |
| Ajustes y apariencia | 24 temas de editor, atajos reconfigurables con paleta de comandos, sonidos por origen, medidor de batería, ahorro de energía por niveles, tres niveles de movimiento. |
| Flujos | 14 módulos de disparadores, 4 vistas extra (ejecuciones, fallos, programación, pruebas), plantillas de usuario, ~173 nodos. |
| Diagramas | Mapa del repo, archify, DBML, Excalidraw, draw.io. OpenBot solo tiene un lienzo de rutinas. |
| Vault | Llavero cifra en dos niveles, con TOTP y biometría; `cf secret` nunca devuelve el valor. |
| Actualización de la app | Vía Rust que sigue funcionando aunque el frontend no cargue. |
| Móvil | Cliente completo con QR, código y dispositivos revocables. |

## Ideas a copiar, por área y por impacto

### A. Superficie de atención (lo más visible)

| # | Idea | Detalle | Tamaño |
|---|---|---|---|
| U1 | **Mini-ventana siempre visible «Te necesitan»** | Aprobar, rechazar o responder desde fuera de la ventana principal (la isla dinámica de OpenBot: 7 modos, respuesta corta con opciones, detener, abrir chat). Aprovecha las ventanas satélite y `MorphToast`. | M–L |
| U2 | **Grupo «Te necesitan» en el árbol de Tareas** con chips de acción | Estados nuevos: espera pregunta, espera aprobación, límite con hora de reset («Límite · reinicia 14:30»). | S–M |
| U3 | **Una sola precedencia de estado** (fallo > espera > trabajo > respuesta) | Para que fila, cabecera y grupos nunca se contradigan; con test. | S |
| U4 | **Borrar con Deshacer** (borrado lógico de 10 s) | En tareas, cadenas y chats, en vez de diálogos de confirmación. | M |
| U5 | «Marcar todo como leído» y **aria-live** al reordenar | Accesibilidad barata del árbol. | S |

### B. Navegador, computer use y escritorio

| # | Idea | Detalle | Tamaño |
|---|---|---|---|
| B1 | **Navegador del agente con pestañas atribuidas** | Cada pestaña dice qué agente la controla («haciendo clic…»). Herramientas con referencias que llevan revisión (detecta una referencia vieja) y 5 formas de apuntar (ref, rol, texto, css, punto). Perfiles con nombre, emulación de pantalla y grabación. Hoy CodeFlow solo tiene el nodo de Flujos sin ventana. | L |
| B2 | **Toma de control del usuario** | El usuario toma la pestaña; las llamadas del agente esperan y, al soltar, le avisan «la página pudo cambiar». No se puede tomar durante una petición de secreto. | M |
| B3 | **Tarjeta «dame este secreto»** | El valor no entra al chat, se envía una vez al origen (solo https) y se puede guardar en el vault. Con Llavero ya existente es una pieza pequeña. | S |
| B4 | **Resultado de acción que dice si ocurrió** | `refused`, `suspected_noop`, `unverifiable`, y si robó el foco. Aplica ya a `cf ui`. | S |
| B5 | **Computer use con contención visible** | Borde sobre la ventana controlada («trabajando en {título}»), interruptor por agente, guía de permisos con «arrastra la app a la lista» y verificación. Decide antes si quieres abrir la puerta de *actuar*: hoy `desktop/` solo lee. | L |
| B6 | Captura de pantalla bajo petición | `cf screenshot` con una aprobación por captura. | S |
| B7 | Pre-solicitud de permisos de Automation de macOS | Mostrar los avisos del sistema antes de un flujo que use Mail o Calendario; añadir las descripciones de uso al `Info.plist`. | S |

### C. CLI externa y automatización

OpenBot habla con su app por **HTTP en loopback**, con un token en un archivo (nunca en argumentos),
idempotencia por `--id`, y relee la conexión si recibe 401. Solo ve los agentes que tienen activado
«Local scripts». Comandos: `list`, `run <agente> <tarea|-> [--wait] [--timeout]`, `status`,
`agent set-account|set-model|new-chat`. Códigos de salida: 0 hecho, 1 falló, 2 uso incorrecto,
**3 espera a una persona**, **4 timeout (el trabajo sigue)**, 5 app no disponible o agente no habilitado.

| # | Idea | Tamaño |
|---|---|---|
| C1 | **`codeflow run <proyecto|tarea> --wait --json`** con esos códigos de salida, token en archivo y opt-in por proyecto. Abre CI y scripts. | M |
| C2 | Esquema **`codeflow://`** para lanzar flujos y abrir tareas desde Atajos o Raycast. El nodo `trigger.link` ya lo anuncia pero no se encontró el registro (verificar). | S |
| C3 | Base de datos compartida entre agentes con **autorizador de SQLite** (deniega `ATTACH`, `PRAGMA`, `load_extension`; protege tablas ajenas; 256 MB). Solo si se construye «tablas compartidas». | M |
| C4 | Importador por skill de exportación (zip estricto que rechaza `.env`, claves, `.git`, zips anidados) con vista previa de recuentos y «nombre ya usado». | M |
| C5 | Catálogo local de plugins con hash y diálogo de desinstalación que lista lo que se quita. | M |

### D. Chat y contenido

| # | Idea | Detalle | Tamaño |
|---|---|---|---|
| D1 | **Mermaid, HTML y fórmulas en el chat** | Los motores ya existen en Notas; falta cablearlos. Bloque de código con interruptor Vista previa/Código; diagramas con zoom y desplazamiento. | M |
| D2 | **Aviso fijo sobre el compositor** | Sesión caducada, CLI por actualizar, sin internet, proveedor en silencio, límite en espera — con su botón. | M |
| D3 | **Lista de tareas del plan** como bloque fijo al final de la ejecución, y **traza con barras de tiempo** (lo más lento primero). | S–M / M |
| D4 | **Contexto por categorías** (prompt, memoria, herramientas, skills, resultados, mensajes) con progreso de compactación. | M |
| D5 | **Barra lateral de navegación del chat** (una marca por turno), píldora de mensajes nuevos con cuenta y divisor «NUEVO». | M |
| D6 | **Visor de imágenes** con zoom y **vista previa lateral** de archivos (código, markdown, hoja de cálculo, media) al pulsar un chip. | M |
| D7 | **Tarjetas de acción** para lo que la IA crea (tarea, flujo, memoria, cadena), con «Abrir» y «Deshacer», en vez de avisos. | M |
| D8 | Barra de selección con Explicar/Mejorar/Acortar, respuesta enlazada a un mensaje (con salto y vuelta), atajo de envío ⌘/Ctrl+Enter. | S cada una |
| D9 | **Visual interactivo publicado por el agente** (HTML en iframe aislado, con tema de la app y puente «enviar al compositor»). La idea más distintiva y la más grande; exige revisar CSP. | L |
| D10 | Copiar tabla como Markdown o CSV; enlazar `ruta:línea` dentro de las respuestas para abrir el editor; borde de error por fila de mensaje. | S |

### E. Ajustes, agentes y proveedores

| # | Idea | Detalle | Tamaño |
|---|---|---|---|
| S1 | **Superficie de Almacenamiento** | Tamaño por categoría, chats más pesados, espacio libre, «Limpiar» con confirmación que dice cuánto libera. Resuelve un dolor real (`target/` de 45 GB, modelos GGUF, clones de referencia). | M |
| S2 | **Matriz «seguir el ajuste general»** por agente, con «aplicar a todos». | M |
| S3 | Ficha del agente o tarea con **contadores** (memorias, skills, rutinas, uso). | M |
| S4 | **Proveedores propios con descubrimiento**: escanear Ollama y LM Studio, formulario compatible con OpenAI con «Buscar modelos», y «probar antes de guardar» con aviso de que el comando corre en tu equipo. | M |
| S5 | **Catálogo de apps MCP** con eslogan, 3 prompts de ejemplo, categorías y conexión en un clic. | M |
| S6 | **Mapa de calor de actividad** y rachas, sobre los datos de uso que ya tienes. | M |
| S7 | Tamaño de interfaz (zoom global de la webview), destino de enlaces (integrado, predeterminado u otra app), botón «enviar prueba» de notificación con diagnóstico, «Copiar diagnóstico» por CLI. | S cada una |
| S8 | Texto honesto por proveedor en cada nivel de acceso («un comando que escriba fuera pregunta», «sandbox de todo el proceso, solo macOS») y plan con cuenta atrás para arrancar solo. | S |
| S9 | Instrucciones con contador y tope; plantillas rápidas en chips; «qué falta para continuar» bajo el botón deshabilitado del onboarding. | S |
| S10 | **Instalar la actualización cuando no haya runs**, con la lista de bloqueos («esperando: turno de agente, rutina, entrega en cola…»). | S–M |

### F. Flujos (editor)

Sobre todo detalles baratos de OpenBot que Flujos no muestra: razón de rechazo al conectar puertos
(«Admite texto, no imagen»), insignia «Bucle sin fin» cuando no hay condición dentro del cuerpo, versión
automática «antes de cada ejecución», paginador de resultados por nodo, bloqueo de nodo, modo
solo lectura para especificaciones de una versión más nueva, y cajón del móvil «N te necesitan».
Todo **S** cada uno.

### G. Móvil y remoto

Notificaciones push web para aprobaciones y fallos (el cliente móvil solo sirve con la pestaña abierta),
escalera de pasos de conexión con tiempo transcurrido, comprobación previa de VNC/RDP con prueba en
vivo (imagen, ratón, teclado), PIN y huella para la PWA, y «compartir hacia el agente» desde el menú
del teléfono. **S–M** cada uno.

## Lo que no conviene copiar

Servidores en la nube de pago, roles e invitaciones con límite de miembros, facturación y licencia,
conectores de Bitwarden y 1Password (salvo un puente de solo lectura al vault externo), el widget del
notch de macOS como producto, Sunshine/Moonlight para streaming, avatares con caras generadas (choca con
tu regla «ThinkingOrb = IA»), y la telemetría (CodeFlow no tiene, y es decisión tuya).

## Prioridad global sugerida (primera y segunda parte juntas)

1. **Continuidad ante cuotas y cuelgues:** reanudar en el reset, modelo de respaldo, vigilante de silencio (E1, E3, E2). Es lo que más duele con agentes sin supervisión.
2. **«Te necesitan»:** mini-ventana accionable + grupo en el árbol + estados nuevos (U1, U2, U3). Es lo más visible y se apoya en piezas existentes.
3. **Errores uniformes:** clasificador general con códigos de referencia, error persistente por proveedor, registro de secretos, aviso fijo sobre el compositor (E4, E5, E8, E7, D2).
4. **CLI externa** con códigos de salida 0–5 y esquema `codeflow://` (C1, C2).
5. **Almacenamiento** (S1) y **borrar con Deshacer** (U4): dolores reales y diseño simple.
6. **Mermaid, HTML y fórmulas en el chat** + lista de plan + traza con barras (D1, D3).
7. **Navegador del agente** (B1–B3), solo cuando decidas si quieres que CodeFlow *actúe*.
8. **Cliente ACP genérico** (A1), el de mayor alcance en proveedores.

## Correcciones al plan de actualización de CLIs (`cli-updates.md`)

OpenBot ya resolvió este mismo problema, y su diseño corrige tres cosas del plan:

- **Sin «Cancelar» durante la instalación.** Dura segundos y cancelar dejaría el runtime a medias. La × solo cierra la tarjeta y no detiene nada. (El plan decía que la × cancelaba.)
- **Nuevo estado «Esperando a que terminen los turnos»** cuando el CLI está en uso, más «No actualizar si está iniciando sesión».
- **Se anuncia la transición a «hay versión nueva», no el estado.** Una versión posterior es otra transición, así que descartar una tarjeta se respeta hasta que salga otra. La fila de ajustes solo dice «Actualización disponible»; las dos versiones van en la notificación.
- Botón **«Copiar diagnóstico»** por CLI (proveedor, estado, versión, origen, último error con hora, sin datos personales).
