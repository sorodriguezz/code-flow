# Hoja de ruta — los cuatro planes en uno

Pedido el 2026-10-27: unir en un solo plan las cuatro cosas planificadas, con énfasis en lo aprendido
de OpenBot.

| Plan de detalle | Qué es | Tamaño propio |
|---|---|---|
| [openbot-comparison.md](openbot-comparison.md) | Qué mejorar o agregar en CodeFlow tras analizar OpenBot (partes 1 y 2) | Varía por ítem |
| [agent-loop.md](agent-loop.md) | Revisor que devuelve trabajo; vueltas que convergen | ~2 semanas |
| [cli-updates.md](cli-updates.md) | Revisar y actualizar los CLIs de IA al abrir la app | ~1,5 semanas |
| [multi-repo-architecture.md](multi-repo-architecture.md) | Arquitectura completa de varios repos y flujos entre ellos | ~3–4 semanas |

Este documento no repite los detalles: dice **en qué orden**, **qué comparten** y **cuándo está hecho**
cada tramo. Los códigos (E1, U2, D1…) remiten a `openbot-comparison.md`.

Estado: **en construcción — ver «Estado de la implementación» al final.**

---

## 1. Por qué este orden

Al cruzar los cuatro planes aparecen **tres piezas compartidas**. Construirlas primero evita hacer tres
versiones distintas de lo mismo:

| Pieza común | La necesitan | Origen |
|---|---|---|
| **Tabla de capacidades por proveedor** (`ProviderCaps`): canal de instalación, si reporta uso, si admite steer, si fuerza solo lectura, paquete npm… | Actualización de CLIs (catálogo y canal), modelo de respaldo, revisor del loop (exige solo lectura), cliente ACP | OpenBot A2 |
| **Clasificador de errores general** con código de referencia copiable | Tarjetas de error de CLIs, aviso sobre el compositor, último error por proveedor, motivos de pausa de cadenas | OpenBot E4, E5 |
| **Modelo de "atención"**: un estado único y una precedencia (fallo > espera tu respuesta > espera aprobación > límite > trabajando > respondió) | Gate del loop al agotar vueltas, grupo «Te necesitan», mini-ventana, código de salida 3 de la CLI externa | OpenBot U2, U3 |

Después va lo que **más duele hoy** (agentes que se quedan parados por cuota o colgados) y lo que el
usuario pidió primero (CLIs). El agent loop se apoya en las tres piezas. El multi-repo es el más
independiente y el más largo, así que va cuando el resto está asentado, y al final puede usar el loop
para verificar cada conexión.

**Regla de paridad (vigente):** toda mejora para Claude va también a Codex, Gemini/agy, Grok,
OpenCode y Cline donde el CLI lo permita. Cada ola la cumple o dice explícitamente por qué un proveedor
queda fuera.

---

## 2. Las olas

Las olas son secuenciales salvo donde se indica. Las semanas son de trabajo efectivo, estimadas.

### Ola 0 — Verificar antes de construir (1–2 días)

Las filas "CodeFlow: falta / parcial" del análisis de OpenBot salieron de búsquedas, no de leer cada
módulo. Antes de cada ola se confirma contra el código lo que esa ola toca. En particular:

- Si el chat ya virtualiza el transcript, si `startTypewriter` adapta el ritmo, qué hace hoy
  `AssistantInbox`, si Ollama se detecta en `aiModelsStore`, si `codeflow://` está registrado.
- Si las cadenas ya reanudan solas en algún caso de cuota.
- Cerrar las decisiones pendientes de §4.

**Hecho cuando:** cada ítem de la ola siguiente tiene su estado confirmado en el código.

### Ola 1 — Cimientos (~2 semanas)

| Ítem | Qué | Código |
|---|---|---|
| 1.1 | `ProviderCaps`: una tabla en Rust con una fila por proveedor y test que falla si un proveedor nuevo no la completa | A2 |
| 1.2 | Clasificador general: red, permiso, disco, timeout, no encontrado, conflicto, servicio, desconocido. Con puerta contra salida técnica (trazas, rutas, `SQLITE_*`) y código de referencia con lista blanca (`errno/ECONNREFUSED`) | E4, E5 |
| 1.3 | Último error persistente por proveedor (con hora) + «Copiar diagnóstico» por CLI | E8, S7 |
| 1.4 | Registro global de secretos exactos que alimenta `applog::scrub` (Llavero + claves de proveedor, en crudo, JSON y URL) | E7 |
| 1.5 | Modelo de atención: estados nuevos (espera pregunta, espera aprobación, límite con hora de reset) y una sola función de precedencia, con test | U3 |

**Hecho cuando:** cualquier error que llega a un toast pasa por el clasificador y trae código copiable;
la fila de un proveedor muestra su último error; `agentStatus` devuelve los estados nuevos y fila,
cabecera y grupos usan la misma precedencia.

### Ola 2 — Continuidad ante cuotas y cuelgues (~2 semanas)

Lo que más duele con agentes trabajando solos. Todo se apoya en piezas que ya existen (el reset ya se
parsea, `classify_failure` ya clasifica cuota).

| Ítem | Qué | Código |
|---|---|---|
| 2.1 | **Reanudar en el reset**: una cuota retiene la cola de esa cuenta y modelo y la libera en reset + 30 s; si no hay hora, relee la cuota cada 15 min. La cadena pausada por cuota se reanuda sola | E1 |
| 2.2 | **Modelo de respaldo**: lista ordenada por tarea/paso; cambia ante cuota o sobrecarga, dice en el chat «Límite alcanzado, sigo con X», vuelve al original al terminar el límite; un modelo que falló se salta 10 min | E3 |
| 2.3 | **Vigilante de silencio**: un turno sin eventos 5 min, sin herramienta en curso ni pregunta pendiente, se corta con «{proveedor} dejó de responder» | E2 |
| 2.4 | **Aviso fijo sobre el compositor**: sesión caducada, CLI por actualizar, sin internet, proveedor en silencio, límite en espera (con «Enviar a {modelo}» y «Recordar mi elección») | D2 |
| 2.5 | Parar el auto-arranque del llama-server tras 3 inicios fallidos | E12 |

**Hecho cuando:** una cadena que choca con la cuota a las 14:00 sigue sola a las 14:30 sin tocar nada;
una tarea con respaldo configurado nunca se detiene por cuota; un CLI colgado se corta y lo dice.

### Ola 3 — Actualización de CLIs (~1,5 semanas)

El plan [cli-updates.md](cli-updates.md), ya corregido con el diseño de OpenBot:

- El catálogo de paquetes y el canal de instalación salen de `ProviderCaps` (1.1).
- Las clases de error de la tarjeta salen del clasificador (1.2), con «Mostrar detalles» y «Reparar».
- **Sin cancelar durante la instalación:** la × solo cierra la tarjeta.
- Estado «Esperando a que terminen los turnos» si el CLI está en uso.
- Se avisa de la **transición** a versión nueva; descartar se respeta hasta la siguiente.
- Decisiones ya tomadas: × oculta hasta la próxima apertura, existe «Omitir esta versión», solo se
  revisa al abrir (tope de 12 h).

Junto a esta ola, porque comparte la lógica de "esperar a que no haya runs":

- **Instalar la actualización de la app cuando no haya runs**, con la lista de lo que la bloquea
  (S10/E14).

**Hecho cuando:** al abrir la app aparecen las tarjetas arriba a la derecha, un clic instala por el
canal correcto, y cada clase de error tiene su mensaje y su acción.

### Ola 4 — Agent loop (~2 semanas)

El plan [agent-loop.md](agent-loop.md). Lo que aporta la comparación con OpenBot:

- **Es una ventaja propia:** OpenBot no tiene verificación por comando, ni revisor que devuelve trabajo,
  ni vueltas con convergencia. Sus loops retroceden sin límite. Conviene mantener esta diferencia.
- El revisor exige solo lectura: lo pide a `ProviderCaps` (1.1).
- El gate «Aceptar como está / Una vuelta más / Abortar» al agotar vueltas o detectar falta de progreso
  es un estado de atención (1.5), así que aparece solo en el grupo «Te necesitan» de la ola 5.
- Si una vuelta choca con la cuota, la ola 2 la reanuda en el reset sin gastar vuelta.
- Decisiones ya tomadas: selector «Exigencia» con «correcto» (solo `must`) por defecto; 3 vueltas por
  defecto, tope 8.

**Hecho cuando:** una cadena worker → revisor arregla un bug plantado en 1–3 vueltas, se detiene sola
si el worker no cambia nada, y nunca pasa de su tope.

### Ola 5 — Atención y control externo (~2,5 semanas)

| Ítem | Qué | Código |
|---|---|---|
| 5.1 | **Grupo «Te necesitan»** arriba del árbol de Tareas, con chips de acción (Responder, Revisar, Aprobar) | U2 |
| 5.2 | **Mini-ventana siempre visible**: aprobar, rechazar o responder sin traer la ventana principal. Reutiliza las ventanas satélite y `MorphToast` | U1 |
| 5.3 | **CLI externa** `codeflow run <proyecto\|tarea> --wait --json`: HTTP en loopback, token en archivo (nunca en argumentos), idempotente con `--id`, opt-in por proyecto. Códigos: 0 hecho, 1 falló, 2 uso, **3 necesita a una persona** (sale de 1.5), **4 timeout, el trabajo sigue**, 5 app no disponible | C1 |
| 5.4 | Esquema `codeflow://` para lanzar flujos y abrir tareas | C2 |
| 5.5 | **Borrar con Deshacer** (borrado lógico de 10 s) en tareas, cadenas y chats; «Marcar todo como leído»; `aria-live` al reordenar | U4, U5 |
| 5.6 | «Detener todos los agentes» en el menú nativo y la bandeja | S7 |

**Hecho cuando:** un agente que espera una aprobación se ve y se resuelve sin abrir la app; un script
lanza una tarea y sabe por el código de salida si terminó, falló o necesita a alguien.

### Ola 6 — Arquitectura multi-repo (~3–4 semanas; puede correr en paralelo con la 7)

El plan [multi-repo-architecture.md](multi-repo-architecture.md). Decisiones ya tomadas: el mapa general
vive en Arquitectura y cada flujo se dibuja con archify; la lectura de App Settings de Azure va siempre
con permiso previo.

Lo que se cruza con las otras olas:

- Su fase A6 («Re-verificar») usa el verificador del agent loop (ola 4) para comprobar cada conexión.
- Los runs por repo (A3) heredan el modelo de respaldo y la reanudación en el reset (ola 2).

**Hecho cuando:** con los repos de un sistema en el workspace, la arquitectura muestra cada repo con su
rol, cada conexión con su nivel de confianza y su evidencia, y las llamadas sin resolver aparte.

### Ola 7 — Chat y contenido (~3 semanas; en paralelo con la 6)

| Ítem | Qué | Código |
|---|---|---|
| 7.1 | **Mermaid, HTML y fórmulas en el chat** (los motores ya existen en Notas), con interruptor Vista previa/Código y zoom de diagramas | D1 |
| 7.2 | **Lista del plan** como bloque fijo en la ejecución, y **traza con barras de tiempo** (lo más lento primero) | D3 |
| 7.3 | **Contexto por categorías** y progreso de compactación | D4 |
| 7.4 | **Pantalla de Almacenamiento**: tamaño por categoría, chats más pesados, espacio libre, limpieza que dice cuánto libera | S1 |
| 7.5 | Barra de navegación del chat, píldora con cuenta de mensajes nuevos, divisor «NUEVO» | D5 |
| 7.6 | Visor de imágenes y vista previa lateral de archivos | D6 |
| 7.7 | **Tarjetas de acción** para lo que la IA crea (tarea, flujo, memoria, cadena) con Abrir y Deshacer | D7 |

**Hecho cuando:** un diagrama en una respuesta se ve dibujado; una ejecución larga muestra su plan y
dónde se fue el tiempo; Ajustes dice cuánto ocupa cada cosa y libera espacio con un clic.

### Ola 8 — Ampliaciones que requieren decisión (sin fecha)

Grandes, y cada una cambia qué tipo de producto es CodeFlow. Se deciden una a una:

| Ítem | Qué | Por qué espera | Código |
|---|---|---|---|
| 8.1 | **Cliente ACP genérico** | El de mayor alcance (Cursor, Copilot, Goose, Qwen sin driver propio), pero L. Se apoya en `ProviderCaps` | A1 |
| 8.2 | **Navegador que el agente maneja**, con toma de control y traspaso de secretos | Abre la puerta a que CodeFlow *actúe*; hoy solo lee | B1–B3 |
| 8.3 | **Computer use** con borde indicador y guía de permisos | El mayor riesgo de todos | B5 |
| 8.4 | Steer, cola persistente con motivo de espera, esperas durables | Cambian el modelo de ejecución del chat | A3, A4, A7 |
| 8.5 | Mensajería entre agentes, canales con líder, hilos paralelos por agente | Es otro producto: agentes persistentes que se hablan | O2, O3, A10 |
| 8.6 | Notificaciones push en el móvil | Requiere service worker y revisar privacidad | G |
| 8.7 | Proveedores propios con descubrimiento (Ollama, LM Studio, endpoints compatibles) y catálogo de apps MCP | M cada uno; dependen de cómo quede ACP | S4, S5 |

### Mejoras rápidas (se intercalan en cualquier ola)

Cada una es pequeña (S) y no depende de nada. Sirven para cerrar una ola con algo visible:

- **Chat:** atajo de envío ⌘/Ctrl+Enter; barra de selección con Explicar/Mejorar/Acortar; copiar tabla
  como Markdown o CSV; `ruta:línea` clicable en las respuestas; borde de error por mensaje.
- **Ajustes:** tamaño de interfaz (zoom global); destino de enlaces; botón «enviar prueba» de
  notificación; contador en las instrucciones; texto honesto por proveedor en cada nivel de acceso.
- **Flujos:** razón al rechazar una conexión de puertos; insignia «Bucle sin fin»; versión automática
  antes de cada ejecución; paginador de resultados por nodo; bloqueo de nodo.
- **Robustez:** estado `uncertain` para escrituras externas interrumpidas (comentarios de PR); abrir la
  BD en solo lectura si su esquema es más nuevo; motivo de salida y vigilante de cuelgue al cerrar.
- **Escritorio:** captura bajo petición con aprobación; pre-solicitud de permisos de Automation.

---

## 3. Calendario resumido

```
Semana   1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16
Ola 0    ▌
Ola 1    ████
Ola 2          ████
Ola 3                ███
Ola 4                   ████
Ola 5                         █████
Ola 6                              ████████
Ola 7                              ██████        (en paralelo con la 6)
Ola 8                                        → decisiones una a una
```

Unas **16 semanas** de trabajo efectivo hasta cerrar la ola 7. Las olas 1 a 5 (~10 semanas) entregan
casi todo el valor de la comparación con OpenBot más los planes de CLIs y del loop.

**Si hay que acortar:** ola 1 → ola 2 → ola 3 dan, en ~6 semanas, agentes que no se quedan parados,
errores uniformes y CLIs al día. Es el núcleo.

---

## 4. Decisiones pendientes (todas juntas)

Si no se dice otra cosa, se usa la propuesta.

| Plan | Pregunta | Propuesta |
|---|---|---|
| Agent loop | ¿El revisor puede usar el mismo modelo que el worker? | Se permite, con aviso en el modal |
| Agent loop | Si se para por falta de progreso y ya no quedan `must`, ¿qué hace? | Termina con lo que hay y deja los `should` en el reporte |
| Multi-repo | Export de un flujo multi-repo al CLI de archify | Repo de entrada como principal (compatible); en la app, todos |
| Multi-repo | Tope de repos por generación | 30 |
| CLI updates | Canal de instalación desconocido | Tarjeta sin botón, con el comando para copiar |
| OpenBot | ¿CodeFlow debe *actuar* en el computador (navegador, computer use)? | Decidir antes de la ola 8; hasta entonces solo lectura |
| OpenBot | ¿Cliente ACP genérico? | Sí, como primer ítem de la ola 8 |
| OpenBot | Telemetría | Ninguna (como hoy); a lo sumo un registro local exportable |
| Ola 2 | Modelo de respaldo: ¿automático o preguntar? | Preguntar la primera vez, con «Recordar mi elección» |

---

## 5. Cómo se ejecuta

- **Una ola, una rama.** Cada ola queda en su rama con sus pruebas; el usuario revisa y hace commit.
- **Sin sobrecargar agentes en paralelo:** el límite de sesión ya cortó 9 agentes Opus a la vez.
  Máximo 2–3 agentes por ola.
- **Verificar en la app real** (no solo tests) cada ola que cambia algo visible.
- **Licencia de OpenBot (PolyForm Noncommercial):** se toman ideas y diseño, nunca código.

---

## Estado de la implementación (2026-10-27)

Pedido del usuario: implementar todo salvo la ola 8 (CodeFlow sigue en solo lectura: nada de navegador del
agente ni computer use). Hecho en `main`, sin commit. Verificación: `cargo test --lib` 4072 pasan / 0 fallan;
`vitest` 3170 pasan; `tsc` limpio.

| Ola | Estado | Notas |
|---|---|---|
| 0 | hecha | Dos hallazgos: el vigilante de silencio **ya existía** (`ai_runs::gone_quiet`); la reanudación automática ya existía pero con consentimiento por pausa. |
| 1 | casi | `ProviderCaps`, clasificador general + códigos, último error por proveedor, registro de secretos: **hechos**. Modelo de atención como estados nuevos: parcial (ver ola 5). |
| 2 | parcial | Reanudar al renovarse la cuota (consentimiento permanente, ON por defecto) y modelos de respaldo: **hechos**. Vigilante de silencio: ya existía. **Falta:** aviso fijo sobre el compositor (2.4), tope de arranques del llama-server (2.5). |
| 3 | hecha | Tarjetas de actualización de CLIs. Cada CLI se actualiza con su propio subcomando (verificado con `--help`); sin cancelar durante la instalación. **Falta:** instalar la actualización de la app cuando no haya runs. La ruta de instalación **no se probó en vivo** contra un CLI real. |
| 4 | casi | Revisor con severidades, vueltas, paradas y «una vuelta más»: **hecho**. **Falta:** rutas protegidas (L4); las plantillas no guardan el revisor. |
| 5 | parcial | Cadenas detenidas (cuota, sesión, CLI, revisor) aparecen en la píldora de actividad. **Falta:** mini-ventana, CLI externa, `codeflow://`, borrar con Deshacer. |
| 6 | no | Arquitectura multi-repo. |
| 7 | no | Contenido del chat (Mermaid/HTML/fórmulas, plan, traza, almacenamiento…). |
| 8 | excluida | Por decisión del usuario. |

### Actualización (2026-10-28)

| Ola | Estado ahora |
|---|---|
| 2 | **hecha:** aviso sobre el compositor y tope de arranques del llama-server (3 fallos → pausa de 5 min). |
| 3 | **hecha:** también «Reiniciar cuando no haya nada en marcha» para la actualización de la app. |
| 5 | **casi:** CLI externa (`cf templates/run/status`, apagada por defecto, códigos 0–5), `codeflow://flow/<nombre>`, «Detener todos los agentes» (⌘⌥.), borrar con Deshacer. **Falta:** mini-ventana «Te necesitan». |
| 6 | **núcleo hecho:** fichas por repo + enlaces verificado/inferido/sin resolver, alimentando la generación. **Falta:** flujos trazados como secuencias de archify entre repos, y re-verificar tras un pull. |
| 7 | **parcial:** pantalla de Almacenamiento. **Falta:** Mermaid/HTML/fórmulas en el chat, lista del plan, traza con barras, contexto por categorías, visor de imágenes, tarjetas de acción. |

## Progress note 2026-10-28
- Reviewer protected paths (L4) built: `agent_chain_reviews.protected_paths/baseline`, baseline taken at chain creation, `chain_review::protected_*`, synthetic `must` findings in `settle_review`, input in NewChainModal.
- Still open: templates carrying the reviewer, A5/A6 (archify sequences, re-verify after pull), D4/D5/D7 chat polish.

## Progress note 2026-10-28 (2)
Built: templates carry the reviewer; A5 sequence (`architecture_sequence_from` + ConnectionsPreview in the source dialog); A6 `stale()` (backend only, no UI: no persisted map to compare); D3 step durations from arrival stamps (live runs only; persisted traces carry none); D4 `/context` bars (parser written against a guessed format — unverified on real output); D5 pill count + turn rail; D7 `agentcli:created` cards for `cf task` / `cf remember` (Open/Undo); D8 Explain/Improve/Shorten; D10 table copy, `path:line` links, error row border.
Not built: D9 (interactive visual), wave 8.
