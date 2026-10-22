# Codi — plan

Asistente de voz para CodeFlow tipo «Jarvis». Lo pidió el usuario el 2026-10-21. Tiene dos partes:

- **A.** Primero, motores de voz nuevos para «Lectura en voz alta» y para transcribir.
- **B.** Después, Codi: una ventana flotante con micrófono y sonido, que maneja **toda** la interfaz (apps del rail, paneles, islas, repos, texto) y hace trabajo en segundo plano avisando cuando termina.

Estado: **F0 medido y F1–F8 construidos el 2026-10-21** (sin commit, en main); ver «Estado de la implementación» al final. Las decisiones del usuario están al final.

---

## 0. Qué ya existe y qué falta

**Ya está (≈60 % de las piezas):**

- Micrófono nativo con cpal (`dictation/capture.rs`), con permiso macOS y selector de dispositivo.
- whisper.cpp b5454 por FFI, con slots por función (`dictation/engine.rs:263`) y VAD Silero (`engine.rs:445`).
- Cortador de frases en vivo: `meetings/vad.rs:63`, 700 ms de silencio.
- sherpa-onnx 1.13.8 build *full* (`meetings/mod.rs:269`). Hoy solo se usan 15 símbolos: TTS VITS y embeddings CAM++.
- Lectura en voz alta: cola, «Callar» por contador de generación, `speech:state` con envolvente (`speech/mod.rs`).
- Máscara de eco `OwnSpeech` (`meetings/pipeline.rs:288`) y `drop_echo_words`.
- `ThinkingOrb` con fase `speak` y `voiceLevel()` (`lib/thinking/voice.ts`).
- Ventana siempre-encima sin marco: `open_quick_ask` (`windows.rs:697`). Es la plantilla de la ventana de Codi.
- `cf` con unos 25 verbos, y los mismos verbos como herramientas MCP en Claude, Codex, opencode y Cline (`codemap/mcp.rs:633`).
- Motor local con bucle de herramientas (`local_agent/`): Qwen3 4B, 7/7 herramientas, ~30 tok/s en el M4.
- Registro de atajos: 90 comandos (`lib/shortcuts.ts:339`); 19 abren vistas y 7 cambian de workspace, repo o rama.
- Notificaciones con `onNotificationPushed` (`notificationStore.ts:259`). Las notificaciones habladas ya existen.

**Falta (y es lo grande):**

1. **Una capa de acciones de interfaz.** Desde fuera de la webview hoy solo se puede: abrir un archivo (`agentcli:open`), abrir una revisión, cambiar de vista (`flows:open`, sin validar el destino), correr un comando en la terminal y notificar. No hay forma de cambiar workspace o repo, abrir paneles o ajustes, sacar o devolver islas, ni escribir en un campo.
2. **Un «estado de pantalla» que un modelo pueda leer.** Hoy solo existe `cf status` = `{workspace, project, task}`.
3. **Audio full-duplex:**
   - La síntesis no hace streaming: `piper.rs` genera todo y después `player.rs` lo reproduce.
   - No hay *barge-in* (cortarle la palabra a Codi).
   - No hay eco en vivo.
   - El micrófono tiene un solo consumidor: el `RECORDING` de `dictation_cmd.rs:176` corta la grabación anterior.
4. **Latencia.** Solo Claude y el motor local transmiten texto parcial. `converse` (los turnos con herramientas del motor local) no hace streaming. `text_only` (el camino rápido) quita MCP en Claude y opencode.

---

## Parte A — Motores de voz

### Lo que hay que corregir de la lista pedida

| Pedido | Realidad | Propuesta |
|---|---|---|
| **Kokoro-82M** | Apache-2.0. sherpa 1.13.8 lo soporta: struct `kokoro` con campo `lang` y generación por fragmentos (`SherpaOnnxOfflineTtsGenerateWithConfig`). Los paquetes de sherpa solo traen léxicos zh/en, pero Kokoro v1.0 sí tiene voces españolas (`ef_dora`, `em_alex`, `em_santa`). | Medirlo primero (F0): `kokoro-multi-lang-v1_0` con `lang="es"` + espeak-ng. Si el español no convence, Kokoro queda para inglés y el español sigue con Piper. |
| **XTTS v2** | Licencia **CPML, solo uso no comercial**. Coqui cerró y no hay a quién comprar licencia comercial. Requiere Python + PyTorch, y en Mac anda lento (MPS parcial). | Ofrecerlo como descarga opcional que pide aceptar la licencia. Recomendar **Chatterbox Multilingual** (MIT, 23 idiomas con español, clona voz) como clonador por defecto, en el mismo paquete Python. |
| **faster-whisper large-v3** | faster-whisper es un *framework* (CTranslate2) **sin Metal**: en el M4 el mismo large-v3 corre más lento que en whisper.cpp. | Agregar el *modelo* `large-v3` (q5_0, ≈1,08 GB) a whisper.cpp. Es la máxima precisión y traduce (solo hacia inglés). |
| **WhisperX** | Python: faster-whisper + alineación wav2vec2 + pyannote. pyannote es *gated* en HF (pide token y aceptar términos). Reuniones ya hace whisper + palabras + CAM++ + clustering + eco. | Mejorar lo nativo con la segmentación pyannote-3.0 en ONNX vía sherpa, medida con `meetings/bench.rs`. WhisperX real solo si lo nativo no alcanza (decisión 2). |
| **Large-v3-Turbo** | **Ya está en el catálogo** (`turbo`, q5_0, 574 MB). Ojo: turbo no se entrenó para traducir. | Dejarlo y aclararlo en la UI: «rápido; para traducir usa large-v3 o Canary». |
| **Parakeet / Canary (NeMo)** | NeMo es Python + CUDA y orientado a Linux. sherpa 1.13.8 ya tiene `sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` (25 idiomas europeos, con puntuación) y `sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8` (traduce es↔en/de/fr). «Servidores con tráfico masivo» no aplica a una app de escritorio. | Los dos vía sherpa, sin NeMo. Parakeet es el candidato natural para Codi y los subtítulos en vivo, porque es muy rápido en CPU. |

Nota: sherpa 1.13.8 también trae clonación nativa sin Python, pero solo en inglés/chino (Pocket TTS, ZipVoice). Sirve de respaldo si no se quiere Python para inglés.

### A1. Catálogo de voces común

Hoy el motor se elige con un `match` de strings (`speech/mod.rs:165`, valores permitidos en `:152`). `piper::VOICES` es el único catálogo, y la UI tiene `params`/`tier`/RAM escritos a mano (`SpeechSettings.tsx:460`).

- Agregar un campo `engine` al spec: `piper` | `kokoro` | `py:xtts` | `py:chatterbox` | `cloned`.
- Las otras propiedades (params, RAM, tier, licencia + link, sample rate, género) salen de los datos.
- `speech_local_voice_{es,en}` se mantiene: el id de la voz implica el motor.
- `SpeechEngine` (TS) sigue siendo `system|local|cloud`. «Local» pasa a abarcar Piper, Kokoro y Python.

### A2. Kokoro-82M (nativo, sherpa)

- Medir los offsets del sub-struct `kokoro` dentro de `SherpaOnnxOfflineTtsModelConfig` con una sonda C `offsetof` contra el `c-api.h` de 1.13.8, igual que los de VITS en `piper.rs:290`.
- Paquete `kokoro-multi-lang-v1_0`: `model.onnx` 310 MB + `voices.bin` 26 MB, 24 kHz. La voz se elige por `sid`.
- Voces con género: es `ef_dora` F, `em_alex` M, `em_santa` M; en `af_heart` F, `af_bella` F, `am_michael` M, `bf_emma` F, `bm_george` M.
- Una sola carga del modelo sirve para todas las voces (a diferencia de Piper, que carga un modelo por voz).
- Medir: tiempo de carga, RTF en el M4 y comparación de oído con Piper es_MX.

### A3. Síntesis en streaming (lo necesita Codi; mejora la lectura también)

- Generar por oraciones o con el callback de `GenerateWithConfig`.
- `player.rs` acepta muestras que se van agregando: un solo stream cpal por locución, con un cursor que crece.
- `speech:state` manda la envolvente por tramos y `voice.ts` la concatena.
- Meta: **primer audio < 400 ms** desde que llega la primera oración.

### A4. Paquete Python de voz (opcional)

- Reusar `learning/env.rs`: `install_standalone` (CPython 3.12 pineado) y `system_python`.
- Parametrizar la raíz de `venv_dir`/`python`/`prepare`/`run_logged`, que hoy están atados a `training/venv`. La voz va en `models/voice-python/`.
- Un proceso Python **de larga vida** (`voice_server.py` vía `include_str!`, `python -I`, `prepare_command`, `kill_on_drop`) que carga el modelo una vez y responde PCM por stdin/stdout en líneas JSON.
- Dispositivo: MPS en Apple Silicon, CUDA en NVIDIA, CPU como último recurso, con aviso de que es lento.
- Tamaño: PyTorch ≈1–2 GB + XTTS ≈1,9 GB o Chatterbox ≈2 GB (a confirmar).
- **«Clonar voz»:**
  - Grabar 10–15 s con el micrófono, reusando la captura y `MicCheck`.
  - Casilla de consentimiento: «es mi voz o tengo permiso».
  - Se guarda como voz local en `voices/cloned/<id>/ref.wav`.
  - XTTS exige aceptar la CPML antes de descargar.

### A5. Catálogo de transcripción común

Hoy agregar un modelo whisper toca 5 lugares: `MODELS` en `dictation/mod.rs:100`, la unión TS en `dictationCommands.ts:6`, `SPEC` en `VoiceSettings.tsx:38`, la i18n y `meetings::pick_model`. Pasa a ser un solo spec:

`SttModel { id, engine: whisper|sherpa_transducer|sherpa_canary, files[], size, sha256, langs, translate, licence }`

Modelos nuevos:

- `large-v3` (whisper q5_0)
- `parakeet-v3` (sherpa transducer int8, ≈0,6 GB a confirmar, CC-BY-4.0)
- `canary-180m` (sherpa canary int8, con `src_lang`/`tgt_lang`)

FFI nueva `asr.rs` (mismo patrón que `speaker.rs`):

- Funciones: `SherpaOnnxCreateOfflineRecognizer`, `CreateOfflineStream`, `AcceptWaveformOffline`, `DecodeOfflineStream`, `GetOfflineStreamResultAsJson`, más sus destroy.
- `SherpaOnnxOfflineRecognizerConfig` es grande, así que sus offsets se miden con la sonda.

Cada función elige su modelo, con el mismo patrón que el select de «Dictado»:

- Dictado
- Reuniones (en vivo y final)
- Codi
- Flujos (`ai.transcribe`)

### A6. Diarización «estilo WhisperX» (Reuniones)

- Agregar la segmentación pyannote-3.0 (ONNX, MIT) para detectar cambios de turno y solapes. Se mantienen CAM++ y el clustering.
- Ojo: el diarizador offline de sherpa pide todo el canal en RAM, por eso hoy se usan ventanas. Hay que aplicarlo por tramos.
- Medir el DER antes y después con las reuniones sintéticas de `bench.rs` (Mónica/Eddy/Grandpa) más una grabación real.

### A7. Banco «Probar motores» (Ajustes › Voz y sonido › Modelos)

- El mismo clip pasa por cada modelo de transcripción instalado y muestra tiempo + texto.
- Cada voz muestra el tiempo al primer audio.
- Así se elige según el hardware: «velocidad en hardware limitado» se responde con números, no con una tabla.

---

## Parte B — Codi

### B0. Invariantes

1. **El runtime de Codi vive en Rust**, como reuniones y la lectura en voz alta. La ventana es una vista. Cerrarla apaga Codi; minimizarla no.
2. **Nunca escucha sin que se vea.** Con el micrófono abierto hay un indicador en la barra de estado de la ventana principal (`CodiActivity`, igual que `SpeechActivity`), aunque la ventana de Codi esté oculta.
3. **Toda acción de interfaz pasa por un catálogo tipado** (B3). Ese mismo catálogo se expone como verbos `cf`, herramientas MCP, herramientas del motor local y un nodo de Flujos. Nada se hace por píxeles.
4. **Riesgo por acción:** `read` · `navigate` · `write` · `destructive`.
   - Las `destructive` piden confirmación visible en la ventana y un «sí» hablado: push, merge, borrar, enviar, correr comandos, escribir en BD.
   - La regla de secretos de `cf` no cambia: aprobar → usar → limpiar la salida. Nunca se leen ni se dictan.
5. **Solo la voz del micrófono da órdenes.** Son datos, nunca instrucciones: el audio del sistema (reunión, video), el texto de la pantalla y los resultados de herramientas.
6. **Paridad de proveedores**, según la regla del usuario:
   - El cerebro se elige con `ChatModelPicker` (tarea nueva `codi`).
   - Los CLIs reciben las herramientas por MCP y el motor local las recibe nativas.
   - Límites reales: agy y Grok reciben MCP por archivo y solo consultas, así que no podrán actuar (se dice en la UI). Cline filtra a `codeflow_map` (`cline.rs:263`) y hay que abrir el filtro.
7. **Las acciones apuntan a una ventana:** la principal, o la isla que tiene esa app.

### B1. Audio en vivo

- **Captura propia** (hilo estilo `meetings/recorder.rs`), no el `RECORDING` del dictado. Bloques de 16 kHz.
- **Fin de frase:** Silero VAD + `Cutter` con silencio ajustable (≈500–600 ms para Codi).
- **Transcripción:** el modelo elegido para Codi, por defecto Parakeet v3 si F0 lo confirma, o whisper small. Con prompt de vocabulario: nombres de repos, apps y «Codi».
- **Modo de escucha:** ver decisión 3. Los tres modos se pueden construir; la decisión es cuál va por defecto.
  - **Palabra clave:** se transcribe *localmente* cada frase y solo se actúa si empieza con «Codi» (con tolerancia a «Cody», «Kodi», «Coti»). No necesita otro modelo.
  - **Conversación:** todo es para Codi.
  - **Pulsar para hablar:** con un atajo.
- **Silencios automáticos:** con el dictado activo Codi se pausa. Mientras se graba una reunión Codi se pausa también, o queda solo en palabra clave y nunca escucha el canal del sistema.
- **Eco y barge-in (fase 1):**
  - Mientras Codi habla, se conoce exactamente lo que suena. Sus niveles alimentan en vivo una máscara tipo `OwnSpeech`, y `drop_echo_words` descarta palabras que coincidan con lo que Codi está diciendo.
  - Voz real por encima del umbral → `stop_all` en ≈150 ms.
  - Con audífonos funciona desde el día 1.
- **AEC nativo (fase 2, solo si F5 lo pide):** macOS VoiceProcessingIO; Windows en modo comunicaciones.
- **Botón 🔊 Sonido apagado:** Codi deja de hablar. Las respuestas quedan como texto en la ventana y los avisos pasan a ser toasts.
- **Botón 🎤 apagado:** cierra el stream. El indicador del sistema operativo se apaga.

### B2. Ventana, botón y ajustes

- **`SatelliteKind::Codi`** con builder propio copiando `open_quick_ask`:
  - Siempre encima, sin marco, en todos los Spaces.
  - No cuenta para el límite de islas (`counted()`).
  - Tiene rama propia en `SatelliteApp.tsx`, como `quick` (`:586`).
  - No requiere una entrada Vite nueva.
- **Contenido:**
  - Orbe (`ThinkingOrb` con una fase nueva `listen` alimentada por el nivel del micrófono, más `think` y `speak`).
  - Los dos interruptores grandes: 🎤 y 🔊.
  - Lo que escuchó y su respuesta corta.
  - Registro de acciones («Abrí Flujos», «Cambié al repo api»), con ↩ cuando se puede deshacer.
  - Tarjeta de confirmación pendiente.
  - Trabajos en segundo plano.
  - Modo compacto (orbe + 2 interruptores) y modo expandido.
- **El rostro de Codi** (pedido del usuario, 2026-10-21): la ventana muestra el diseño de pensamiento elegido (los 20 de `lib/thinkingDesigns.ts`), con animaciones de escucha y habla más marcadas que en el resto de la app.
  - **Tamaño propio** `hero` (≈160–240 px) en `ORB_PX`. Hoy el máximo es `lg` 44 px, y a ese tamaño los gestos que en 32 px eran sutiles se ven de verdad.
  - **Fase nueva `listen`** en `lib/thinking/activity.ts`, alimentada por el nivel del micrófono de Codi (`codi:level`, como `dictation:level`). Regla igual a la de `speak`: **cada diseño necesita su propio estado de escucha**, no reusar otro.
    - **Personajes** (gato, fantasma, cangrejo, chispa, nube, bombilla, marciano, píxeles, bot, gota): orejas o antena se paran, ojos más abiertos mirando al centro (al usuario), se inclinan hacia adelante (`pointer.ts lean`), y una onda o pulso sigue tu voz.
    - **Abstractos** (esfera, orbe, halo, onda, red, plasma, líquido, cristal, átomo, luna): la superficie se mueve con el nivel del micrófono **hacia adentro** (escucha). Al hablar se mueve **hacia afuera**, así se distingue sin leer nada.
  - **Habla más pronunciada:** una ganancia `--cf-orb-voice-gain` (≈2–2,5×) solo en esta ventana. Escala, `lipSync()` con la boca más abierta y la señal propia de cada mascota más fuerte (llama, arcos de sonido, rayos).
  - **Estados de la ventana:**
    - reposo (`quiet`, dormido)
    - **«me llamaste»:** al oír «Codi», un respingo corto y mira al usuario
    - escuchando
    - pensando (`think`)
    - actuando (`work`/`edit` mientras corre `ui_act`)
    - hablando
    - esperando confirmación (mira y espera)
    - terminado (verde) · error (rojo)
    - 🎤 apagado: el rostro se atenúa. 🔊 apagado: la boca se mueve sin las ondas.
  - **Movimiento reducido:** cuadro fijo, como siempre.
  - Ajustes › Diseño del pensamiento: la vista previa suma el estado «Escuchando».
- **Botón:** en el hueco libre de la barra de título principal (`TitleBar.tsx:169`). Atajos para abrir Codi y para pulsar-para-hablar (tecleables, no reservados por el SO).
- **Ajustes:** pestaña «Codi» en Voz y sonido, con:
  - modo de escucha
  - voz (cualquiera de la lectura, incluidas Kokoro y las clonadas)
  - modelo de transcripción
  - cerebro (`ChatModelPicker`, tarea `codi`)
  - nivel de confirmación
  - idioma
  - «Solo local»

### B3. Capa de acciones de interfaz (el corazón)

**Registro** en `src/lib/codi/actions/`:

```
registerAction({ id, title:{es,en}, aliases:{es,en}, params: JSONSchema,
                 risk, where: "main"|"any"|"app:<key>", run(params, ctx) → result })
```

El catálogo se alimenta de:

1. **Los `SHORTCUT_COMMANDS` que tienen `run`**, registrados automáticamente. `git.push` queda como `destructive`.
2. **Los ítems de la paleta**, extraídos de `CommandPalette.tsx:182-436` a `lib/paletteItems.ts`: workspaces, proyectos, ramas, vistas, acciones y secciones de ajustes. La paleta y Codi comparten una sola fuente.
3. **Acciones tipadas por área**, en dos olas:

| Área | Acciones (primera ola) |
|---|---|
| Navegación | `app.open`, `view.open`, `settings.open(section, tab)`, `panel.ai(open/close/tab)`, `dock.show(terminal/services/containers)`, `sidebar.toggle`, `nav.back/forward` |
| Contexto | `workspace.switch(nombre)`, `repo.switch(nombre)` (difuso; `focusProject`), `branch.checkout` (write) |
| Islas | `island.detach(app/repo)`, `island.return(label)`, `island.focus`, `island.list`. Hoy devolver una isla es solo frontend (`SatelliteTitleBar.tsx:185`), así que hace falta un camino `island-return` por `windowBus`. |
| Texto | `text.type(texto, campo?)` (`insertDictation` para inputs React; Monaco vía `editorCommandStore`), `text.submit` (`registerDictationSend`), `chat.ask(texto, enviar?)` (`askInRepoChat` / app Chat), `editor.open/insert/save` |
| Git | fetch, pull, push (destructive), stage, commit con mensaje (write; el mensaje IA ya existe) |
| Ejecutar | `terminal.run` (pasa por `shell_rules`), `service.start/stop/restart`, `flow.run`, `agent.task`, `review.pr` |
| Lectura | `notifications.list`, `service.logs`, `runs.status` |

Segunda ola, por app: Notas, API, BD (las lecturas se aprueban como en `cf db`), Diagramas, Flujos, Reuniones, Remoto, Contenedores, Pipelines y Arquitectura. Del Llavero solo `lock`: nunca leer.

**Bus pedido/respuesta:**

- Rust `codi::ui::act(label, action, params)` emite `codi:act {id, …}` a la ventana destino.
- La ventana ejecuta la acción y responde con `codi_act_result(id, ok, result)`.
- Timeout de 10 s.
- Es el mismo patrón `PENDING` + oneshot que `agentcli::ask_user` (`agentcli.rs:196`).

**`ui_state`** (instantánea compacta, ~1–2k tokens, por ventana):

- workspace, repo, rama
- vista activa (`MainView`)
- panel IA (abierto y pestaña), dock, ajustes (sección), modales abiertos
- editor: ruta, cursor, selección, sucio
- campo enfocado (`data-ai-input`, etiqueta)
- islas abiertas (`list_satellites`)
- runs, cadenas y servicios en curso
- notificaciones sin leer

**Exposición, con solo 3 herramientas genéricas** (no 200):

- Herramientas: `ui_state`, `ui_actions(área?)`, `ui_act(id, params)`.
- Las 3 se exponen como:
  - verbos `cf ui state|list|<acción>`
  - MCP en `codeflow_map` cuando `acts`
  - herramientas del motor local
  - nodo de Flujos `app.ui` «Acción de interfaz»
- Los modelos chicos rinden mejor con pocas herramientas.
- **Esta capa vale sola, sin voz:** los chats y agentes también podrán manejar la interfaz.

**Respaldo genérico «toda la interfaz»** (F9):

- `ui_controls(ventana)` lista los controles visibles: rol, nombre accesible, ref.
- `ui_press(ref)` y `ui_fill(ref, texto)` actúan sobre ellos.
- Nunca dentro de `[data-codi-private]` (Llavero, campos de secreto) ni en `input[type=password]`.
- Un botón cuyo texto suene destructivo («Eliminar», «Borrar», «Push», «Enviar», «Merge», «Forzar») pide confirmación.
- Las acciones tipadas siguen siendo las preferidas, porque no se rompen al cambiar la UI.

**Deshacer:** las acciones de navegación guardan el estado anterior (vista, workspace, repo). «Codi, vuelve» lo restaura.

### B4. Cerebro

Router en 3 niveles (decisión 4):

1. **Directo, sin IA (< 50 ms):** alias de las acciones + entidades de `ui_state` (apps, vistas, repos, workspaces, ramas), en es/en. Ejemplos: «abre Flujos», «cambia al repo api», «para», «silencio».
2. **Local:** modelo local con las 3 herramientas, para pedidos de varios pasos.
3. **Proveedor elegido** (Claude/Codex/…): lo abierto o pesado («revisa este PR», «arregla el test que falla») se lanza como **trabajo en segundo plano** (B5).

Más detalles:

- **Presupuesto de latencia** (niveles 1–2), del fin del habla al primer audio ≤ 1,5 s:
  - VAD ~500 ms
  - transcripción 150–600 ms
  - router/local 50–800 ms
  - primera oración TTS ~200 ms
- **Tarea nueva `codi`:**
  - Rust: variante en `AiTask` + key + `ALL` (`claude_cmd.rs:79/202/235`).
  - TS: fila en `aiTasks.ts`.
  - Con eso funciona `ChatModelPicker`.
- **Conversación propia** con `/clear`. Cada turno lleva un `ui_state` fresco más los últimos N turnos.
- **Prompt:** respuestas habladas de 1–2 oraciones (el detalle va a la ventana), en el idioma del usuario. Nunca dicta código (`speakable.ts`). Confirma lo destructivo.
- **Brechas medidas en el código, a resolver o aceptar:**
  - `converse` no hace streaming → transmitir el último turno de texto.
  - Codex, agy, Grok y Cline entregan todo al final → aceptable en el nivel 3 porque es un trabajo de fondo.
  - Codi necesita MCP, así que no puede usar `text_only` → con Claude cuesta ~26k tokens por turno sin recortes. Usar una sesión reanudada y el recorte de plugins de los chats, y medirlo en F0.

### B5. Segundo plano y avisos

- Codi lanza trabajos con lo que ya existe: cadenas (`chainStore`, solo en la principal), tareas de Agentes, Flujos, revisiones de PR, servicios y chats.
- Guarda `{origen, ids}` en su lista de trabajos.
- **Escucha:** `onNotificationPushed`, `ai:done`, `services:runtime`, `flows:*`, `terminal:agent`.
- **Al terminar:**
  - Dice una oración, con la tarea `spoken_summary` (ej.: «Terminé la revisión del PR 42: dos comentarios, nada bloqueante»).
  - Agrega una fila con un botón que lleva al resultado (`followTarget`).
- **Con Codi encendido**, las notificaciones habladas pasan por la cola de Codi, para que no hablen dos voces a la vez.

### B6. Seguridad y privacidad

- Indicador siempre visible. Pausa con la pantalla bloqueada.
- No se graba audio a disco. La conversación queda como texto, como un chat.
- La transcripción es **siempre local**. Con un cerebro en la nube, el texto + `ui_state` salen al proveedor. «Solo local» fuerza el motor local.
- Cada acción queda auditada (reusar el log de `tool_gateway`).

---

## Fases

| Fase | Contenido | Se cierra cuando |
|---|---|---|
| **F0** | Mediciones: Kokoro en español; WER de Parakeet v3 / Canary / small / large-v3 con clips `say` (Paulina, Mónica) + una grabación real; primer token de `claude -p` con MCP | Los números deciden el modelo por defecto de Codi y el router |
| **F1** | A1 catálogo de voces · A2 Kokoro · A3 TTS streaming · A5 catálogo STT + large-v3 + Parakeet + Canary · A7 banco | Cada motor con test vivo `#[ignore]` (`CODEFLOW_TEST_*`) |
| **F2** | A4 paquete Python + clonación (según decisión 1) | Voz clonada en español en el M4, con su RTF anotado |
| **F3** | A6 segmentación pyannote | DER medido mejor que el actual |
| **F4** | B3 capa de acciones: registro, bus, `ui_state`, `cf ui`, MCP, motor local, nodo Flujos | Un chat de Claude y el motor local cambian repo, abren una app y sacan/devuelven una isla |
| **F5** | B1 runtime de audio: captura, VAD, palabra clave, TTS streaming, barge-in + eco | Con parlantes del laptop, Codi no se escucha a sí mismo; con audífonos, barge-in < 200 ms |
| **F6** | B2 ventana + botón + ajustes + indicador | Probe en navegador + app viva |
| **F7** | B4 cerebro: router, tarea `codi`, conversación, confirmación hablada | «Abre Flujos» < 1,5 s; un push pide confirmación |
| **F8** | B5 trabajos de fondo + avisos | «Revisa el PR N» → aviso hablado al terminar |
| **F9** | Respaldo genérico de controles + acciones por app (segunda ola) | Cubre una app sin acciones tipadas |
| **F10** | AEC nativo y/o palabra clave dedicada (sherpa KWS), solo si F5/F7 lo piden | — |

**En paralelo:** F1 (Rust `speech/`, `dictation/`, `meetings/`) y F4 (frontend + `agentcli`) no comparten archivos. Pueden ir en dos sesiones a la vez.

## Resultados F0 (medido 2026-10-21 en el M4 16 GB)

Los programas de medición cargan las mismas librerías que la app: whisper.cpp b5454 y sherpa-onnx 1.13.8. Los encabezados dan los mismos tamaños de struct que mide la app (304/48/448). Scripts y datos: `scratchpad/f0/` de la sesión. Los clips son voces de `say` (Paulina, Mónica), Kokoro y Piper, limpias y con ruido de 20 dB + eco de cuarto. No hay grabación real todavía.

**Voz (TTS):**

| Voz | Carga | 5–6 s de audio | RAM | Se entiende (errores al transcribirla) |
|---|---|---|---|---|
| Piper es_MX | 0,35 s | 0,15–0,19 s | 0,33 GB | 14–16 % |
| Kokoro es (dora/alex/santa), 4 núcleos | 0,41 s | 1,1–1,4 s (1ª oración 0,5–0,6 s) | 0,7 GB | 13–15 % |
| Kokoro es, 2 núcleos | — | 1,8–2,1 s | 0,7 GB | — |

- Kokoro en español **funciona con `lang="es"` y sin léxico**. El inglés pide `lexicon-us-en.txt`.
- Offsets medidos para F1: `kokoro` en +128 (model 128, voices 136, tokens 144, data_dir 152, length_scale 160, lexicon 176, lang 184). `SherpaOnnxGenerationConfig` mide 56 (silence 0, speed 4, sid 8).
- Ids de voz: ef_dora 28, em_alex 29, em_santa 53, af_heart 3, am_michael 16.

**Transcripción** (voces naturales; limpio / con ruido):

| Motor | «Codi» detectado | Términos clave | Errores dictado | Por orden | RAM |
|---|---|---|---|---|---|
| **Parakeet v3** CPU 4 núcleos | 95 / 92 % | 77 / 79 % | 1,1 % | **85–91 ms** | 1,2 GB |
| Parakeet v3 CPU 2 núcleos | igual | igual | igual | ~100 ms | 1,2 GB |
| Canary 180M | 92 / 80 % | 68 / 60 % | 5,8 % | ~120 ms | 0,5 GB |
| whisper small + vocabulario, GPU | 89 / 79 % | 79 % | 1,7 % | ~330 ms | 0,4 GB |
| whisper small, CPU 4 núcleos | 80 % | 81 % | 2,8 % | 0,4–0,75 s | 0,6 GB |
| whisper turbo + vocabulario, GPU | 89 / 77 % | **87 / 86 %** | **0,3 %** | 1,6 s | 0,8 GB |
| whisper turbo, CPU 4 núcleos | — | — | 1,7 % | **4,1 s** | — |

Notas:

- whisper rinde 30 s de audio aunque el clip dure 2 s.
- **Recortar `audio_ctx` está descartado:** turbo y large-v3 alucinan y repiten (WER 80–230 %).
- El vocabulario en `initial_prompt` sube la detección de «Codi» de 45 a 83–89 % en whisper.
- Las voces Eloquence de macOS (Eddy, Grandpa) no sirven como prueba: ningún motor las entiende.

**Cerebro local** (16 órdenes de Codi, `llama-server` b10587 de la app):

| Modelo | Correctas | Acción (mediana, en caliente) | En frío (1er turno) | RAM servidor |
|---|---|---|---|---|
| Qwen3 0.6B | 1/16 | — | — | 1,4–1,8 GB |
| Qwen3 1.7B GPU / CPU4 / CPU2 | 13/16 | 0,40 / 0,79 / 1,2 s | 2,4 / 9,9 / 15 s | 2,0–3,1 GB |
| **Qwen3 4B Instruct GPU / CPU4 / CPU2** | **16/16** | **0,93 / 1,65 / 2,6 s** | 6,5 / 26 / 39 s | 3,6–4,3 GB |

- **0.6B** escribe la llamada como texto en vez de llamar a la herramienta.
- **1.7B** falla en las órdenes compuestas (hace una de las dos) y, ante una pregunta, *actúa* (`branch.checkout` al preguntar «en qué rama estoy»).
- **Una herramienta por acción vs `ui_act` genérico (4B GPU):** 16/16 en 0,93 s frente a 14/16 en 2,3 s. La llamada genérica gasta 60–70 tokens; la tipada, ~20.
- **El frío es el prompt del sistema** (1.686 tokens con las herramientas tipadas). Se procesa una vez y queda en caché: CPU 4 núcleos 72 tok/s, 2 núcleos 45 tok/s.
- **Decodificación en CPU:** 4B a 16 tok/s con 4 núcleos ≈ 40 GB/s efectivos. Es lo mismo que logra un portátil Windows con DDR4/DDR5 en doble canal, así que CPU4 sirve de referencia para un PC decente y CPU2 para uno modesto.

**Claude** (`claude -p`, una orden compuesta):

| Forma | Acción ejecutada | Primer texto | Tokens | Costo |
|---|---|---|---|---|
| **Liviana + MCP de Codi, Haiku** | 1,2–1,7 s | 2,3–3,3 s | ~4,2k | USD 0,0003 |
| Liviana + MCP, Sonnet | 1,4–1,6 s | 3,4 s | ~4,2k | USD 0,006–0,011 |
| Liviana sin herramientas, Haiku | — | 1,2 s | ~1,5k | USD 0,0002 |
| Agente por defecto | — | 4,4 s | **41,6k** | **USD 0,15** |

La forma liviana es `--tools "" --strict-mcp-config --disable-slash-commands --system-prompt-file` + `--mcp-config` (solo la de Codi) + `--allowedTools mcp__codi__*`. Así `text_only` no es obstáculo: se mantiene el camino liviano con un MCP propio.

### Lo que F0 decide

1. **Transcripción de Codi = Parakeet v3** (CPU, sin GPU). Whisper turbo queda para dictado y la pasada final de Reuniones (máxima precisión), y Canary para traducir.
2. **Voz de Codi:** Kokoro donde haya CPU de sobra; Piper en equipos modestos (7× más rápido).
3. **Herramientas tipadas para modelos locales.** Las ~30 acciones frecuentes van como herramientas propias, con `enum` en los parámetros. `ui_act` genérico queda solo para el resto.
   - El estado de pantalla y la orden van **al final** del prompt, para que el prefijo (sistema + herramientas) siga en caché. El estado se manda compacto (repo, rama, vista, islas: ~40 tokens).
4. **Precalentar** el modelo al encender Codi: cargarlo y pasar el prompt del sistema una vez.
5. **La respuesta hablada la arma Codi** con el título de la acción («Listo, abrí Flujos»). No se espera un segundo turno del modelo. Ahorra 0,5–1 s y evita respuestas inventadas («la abrí dos veces»).
6. **Router:**
   - **Nivel 1:** sin modelo, todas las órdenes de un solo verbo.
   - **Nivel 2 = 4B:** el 1.7B solo como modo «equipo modesto», y con dos límites: una pregunta nunca dispara una acción `write`/`destructive` sin confirmar, y una orden compuesta se parte en el nivel 1 si se puede.
   - **Nivel 3 = Haiku liviano** (o el proveedor elegido), que no depende del PC.

### Codi según el equipo (estimado a partir de lo medido; Windows no medido)

| Equipo | Transcripción | Voz | Cerebro local | Respuesta típica tras callarte* |
|---|---|---|---|---|
| Mac Apple Silicon 16 GB | Parakeet | Kokoro | 4B en GPU | ~1,6 s (0,6 VAD + 0,1 + 0,9) |
| Windows sin GPU, 16 GB, CPU moderna | Parakeet | Kokoro o Piper | 4B CPU | ~2,4 s (0,6 + 0,15 + 1,65) |
| Windows sin GPU, 8 GB o CPU vieja | Parakeet | Piper | sin local: nivel 1 + Haiku | ~1,8–2,3 s (nivel 3) · nivel 1 ~0,8 s |
| Cualquiera, «Solo local» y 8 GB | Parakeet | Piper | 1.7B CPU (modesto) | ~2 s, 13/16 |

\* Hasta que se ejecuta la acción; la voz empieza 0,1 s (Piper) o 0,5–1,8 s (Kokoro) después.

RAM total de Codi, sin contar la app:

- Parakeet 1,2 GB + Piper 0,33 / Kokoro 0,7 GB
- \+ 4B 3,6–4,3 GB (≈5,5–6 GB en total) o 1.7B 2–3 GB (≈3,5–4,5 GB)

La GPU integrada de Windows (build Vulkan que ya trae la app) podría acortar el frío, pero no está medido.

**Codi debe elegir su configuración solo**, con la medición de hardware que ya existe (`hybrid/hardware.rs`: ancho de banda por memmove, VRAM por DXGI o Metal). Los ajustes muestran la elección y dejan cambiarla.

## Riesgos honestos

- **Eco con parlantes del laptop:** el barge-in sin AEC es lo más difícil del proyecto.
- **Kokoro en español:** la calidad no está garantizada (F0).
- **XTTS/Chatterbox en Mac:** MPS es parcial y en CPU es lento. No hay un ONNX robusto de XTTS.
- **Coste por turno de Claude con MCP:** el router de 3 niveles existe para que lo común no llegue ahí.
- **Descargas grandes:** large-v3 1,1 GB · Parakeet ≈0,6 GB · Kokoro 0,34 GB · paquete Python 3–4 GB. Todo es opcional y bajo demanda, nada preinstalado.

## Decisiones (usuario, 2026-10-21)

1. **Clonación:** Chatterbox Multilingual (MIT) es el clonador por defecto. XTTS v2 es una descarga opcional que pide aceptar la CPML. Los dos van en el paquete Python opcional (A4).
2. **Frameworks Python:** **nativo**. Se usan los mismos modelos con whisper.cpp y sherpa, sin faster-whisper, WhisperX ni NeMo. La diarización mejora con la segmentación pyannote en ONNX (A6). El paquete Python queda solo para la voz.
3. **Escucha por defecto:** **palabra clave «Codi»** (transcripción local de cada frase) más un atajo para hablar sin decirla. El modo conversación queda como opción en la ventana.
4. **Cerebro:** **3 niveles**: directo sin IA → modelo local → proveedor elegido en segundo plano, con aviso al terminar.


## Estado de la implementación (2026-10-21, sin commit)

**Motores (F1).**

- `src-tauri/src/asr/`: Parakeet v3 y Canary 180M por el reconocedor offline de sherpa, con offsets medidos. Usados en Dictado, Codi, Reuniones en vivo y Flujos; la pasada final de Reuniones sigue con whisper.
- `dictation`: suma `large` (v3 q5_0) y una lista única de modelos para escuchar (`Listener`, `features`).
- `speech/`:
  - `sherpa.rs`: FFI común con `GenerateWithConfig` por oración.
  - `kokoro.rs`: 9 voces, un solo paquete; los datos de espeak se comparten con Piper.
  - `player::play_stream`: la voz suena mientras se escribe la oración siguiente.
  - `SpeechState.append` + `appendVoice`.
- `voice_fit.rs`: clase del equipo, estimaciones de F0, recomendación por función, medición real tras cada descarga y con «Medir».
- UI de Ajustes › Voz y sonido › Modelos: `MachineCard`, `ListenDetails`/`SpeakDetails`, fila de Kokoro, `MeasureButton`.

**Clonación (F2).**

- `speech/clone/`: Chatterbox 0.1.7 (por defecto) y coqui-tts 0.28 (XTTS v2, detrás de aceptar la CPML), en un venv por motor y con `voice_server.py` de larga vida.
- Grabación de referencia con consentimiento, de 6 a 20 s.
- `VoiceCloneBlock.tsx`.
- **No probado de verdad:** pide ~4 GB por motor.

**Capa de acciones (F4).**

- Frontend en `src/lib/codi/`: 45 acciones de la primera ola, más la segunda ola por app.
- Rust en `codi/ui.rs`: catálogo por ventana, bus `codi:act`, confirmación de lo destructivo (tarjeta de Codi, o el diálogo de aprobación para agentes), `ui_state`.
- Expuesta como `cf ui`, MCP (`ui_state`/`ui_actions`/`ui_act` en toda ejecución que actúa; solo esas tres para Codi) y el nodo de Flujos `app.ui`.

**Runtime de Codi (F5/F7/F8).**

- `codi/`:
  - `listen` (micrófono continuo, VAD de sherpa)
  - `wake` (nombre por sonido, sí/no)
  - `router` (nivel 1)
  - `brain` (local con herramientas tipadas → proveedor liviano, `AiInvocation::lean`)
  - confirmaciones habladas
  - anuncios
- `AiTask::Codi`. Ventana `SatelliteKind::Codi`: cerrarla apaga el micrófono.

**Ventana, botón, ajustes y rostro (F6).**

- Rostro: `hero`, `listen`, `gain`, cues `wake`/`ask` en los 20 diseños.
- Ventana, botón en la barra de título, indicador en la barra de estado, pestaña «Codi», atajo, anuncios.

**Probado en vivo con los modelos reales:**

- Parakeet, Canary, Kokoro (es/en, por oración), Piper por oración, reproductor en streaming.
- VAD.
- El oído completo con un clip («Cody, revisa el pull request 42…» → orden sin el nombre), limpio y con ruido.
- El enrutador contra el catálogo real (12/12).

**No probado:** la app corriendo de punta a punta (micrófono real, ventana viva), Windows, la clonación, el nivel local dentro de la app y el proveedor dentro de la app.
