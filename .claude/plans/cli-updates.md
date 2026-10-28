# Actualización de CLIs al abrir — plan

Lo pidió el usuario el 2026-10-27, con una captura de referencia. Al abrir CodeFlow, la app revisa
si los CLIs de IA instalados tienen versión nueva. Si la hay, muestra una tarjeta por CLI arriba a
la derecha, con un botón **Instalar** de un clic, barra de progreso y ×. Cada tarjeta se puede
cerrar.

Estado: **construido (ola 3 del roadmap).** Cambio de diseño al implementar: **no se detecta el canal de
instalación**. Cada CLI se actualiza con **su propio subcomando** (`claude update`, `codex update`,
`grok update`, `cline update`, `opencode upgrade`), que sabe cómo se instaló; el registro de npm solo dice cuál
es la última versión. `agy` no tiene comando verificado ni paquete, así que no es actualizable. La tabla de
canales de abajo queda como historial del plan.

```
┌────────────────────────────────────────┐
│ [logo] Actualizar OpenCode          ×  │   ← antes de instalar: «Instalar» / «Omitir versión»
│        v1.18.35 → v2.2.0               │
│        ▬▬──────────────────────  4 %   │   ← durante: barra + %; el × solo cierra la tarjeta
└────────────────────────────────────────┘
  (una por CLI, apiladas, color del logo en la barra como Claude en la captura)
```

---

## 0. Qué ya existe y qué falta

**Ya está:**

- **Los CLIs que se revisarían.** `ai::engine_for` da los motores: claude, codex (sale como
  «ChatGPT»), gemini (`agy`), grok, opencode y cline. Cada uno tiene su `default_binary()` y el
  binario configurado en settings.
- **La versión instalada.** `ai::engine_version(binary)` corre `--version` sobre **el binario
  configurado** y la saca con `parse_version`. Tiene caché por proceso, y habrá que poder invalidarla
  después de actualizar.
- **La versión publicada en npm.** `npm.rs`: `npm_latest_versions(names)` consulta el registry con
  timeout corto y valida el nombre.
- **Las tarjetas arriba a la derecha.** `layout/NotificationPopups.tsx` (MorphToast, `align="right"`)
  ya pinta en esa esquina.
- **Saber si una ejecución usa un CLI.** `ai_runs::active()` y `live_processes()`.
- **Windows y el reemplazo de `claude.exe`.** `mid_update_fallback` ya cubre el caso de un
  `claude.exe` a medio reemplazar.
- **La actualización de la propia app** (`UpdateSection`, `UpdateNotesModal`). Es otro flujo y no
  se mezcla con este.

**Qué falta:** saber **cómo se instaló** cada CLI, conocer su última versión según ese canal,
ejecutar la actualización con progreso, y la tarjeta con botón.

---

## 1. Diseño

### Cómo se instaló cada CLI (el punto delicado)

Actualizar con el instalador equivocado deja **dos copias** del CLI, y la del PATH sigue siendo la
vieja. Por eso primero se averigua el canal, leyendo **la ruta real del binario configurado** (con
`which` y siguiendo symlinks). No se ejecuta nada para esto:

| Ruta resuelta | Canal | Actualizar con | Última versión desde |
|---|---|---|---|
| dentro de `npm prefix -g`, o un shim de npm en Windows | npm | `npm i -g <pkg>@latest` | registry npm (`npm.rs`) |
| `…/Cellar/…` o `/opt/homebrew/…` | Homebrew | `brew upgrade <formula>` | `brew info --json=v2 <formula>` |
| `~/.local/bin/claude` → `~/.local/share/claude/…` | instalador nativo de Claude | `claude update` | registry npm de `@anthropic-ai/claude-code` (mismo número) |
| `~/.opencode/bin/opencode` | instalador de OpenCode | `opencode upgrade` | registry npm de `opencode-ai` |
| cualquier otra | desconocido | **no hay botón**: la tarjeta muestra el comando sugerido y «Copiar» | — |

- **Tabla de paquetes por CLI** (`cli_updates/catalog.rs`), editable sin tocar la lógica: claude →
  `@anthropic-ai/claude-code`, codex → `@openai/codex` / brew `codex`, opencode → `opencode-ai` /
  brew `opencode`, cline → `cline`, gemini/agy y grok → según cómo se distribuyan **cuando se
  construya**. Hay que verificarlo en ese momento; no se adivina hoy.
- **Solo se toca el binario que la app ya usa.** Nunca se ejecuta otro binario encontrado en disco
  para leer su versión (ver la memoria *never-run-found-binaries*: XProtect puso en cuarentena el
  codex de una extensión de VS Code).

### Cuándo se revisa

- Unos 20 s después de abrir la app, en segundo plano, sin frenar el arranque. No se revisa en modo
  ahorro de batería nivel ≥2 (`power.rs`).
- Como máximo una vez cada 12 h (`cli_updates_last_check`). Un botón «Buscar ahora» en Ajustes
  fuerza la revisión.
- En paralelo, con timeout de 5 s por CLI. Si falla la red, no se muestra nada: **nunca** aparece una
  tarjeta de error en el arranque.
- Las comparaciones usan semver. Las versiones pre-release solo se ofrecen si la instalada ya es
  pre-release.

### Qué hace el botón Instalar

- **Si hay una ejecución usando ese CLI** (`ai_runs`), la tarjeta dice «Se instalará cuando termine
  la tarea en curso» y espera a que termine. Sobre todo en Windows, reemplazar un CLI en uso rompe la
  ejecución y el propio update.
- El comando corre con el `PATH` aumentado de la app (`proc`), sin shell interactiva y sin `sudo`.
  Si npm global necesita permisos (`EACCES`), la tarjeta lo explica y ofrece copiar el comando para
  la terminal. Nunca se pide contraseña.
- **Progreso honesto:**
  - Ni npm ni brew dan un porcentaje real, así que la barra avanza por **etapas**: resolviendo →
    descargando → instalando → verificando. Durante la descarga se usa el total de bytes cuando
    npm/brew lo informa en el log (`--loglevel http`, por ejemplo). Si no, la barra se mueve dentro
    de la etapa sin inventar un número.
  - El % solo se muestra cuando está respaldado por bytes reales. En los demás casos se muestra la
    etapa («Instalando…»).
- **Verificación:** se invalida la caché de `engine_version`, se vuelve a leer `--version` y se
  compara con la versión objetivo. Si coincide, la tarjeta dice «Actualizado a vX» y se cierra sola a
  los 4 s. Si no coincide, «Se instaló pero el PATH sigue usando vY». Ese es el caso de las dos
  copias, y se muestra la ruta de cada una.
- **Sin «Cancelar» durante la instalación** (corregido tras ver el diseño de OpenBot): dura segundos y
  cancelar dejaría el CLI a medias. La × solo **cierra la tarjeta** y no detiene nada.
- **Estado «Esperando a que terminen los turnos»** si el CLI está en uso, y no se actualiza uno que
  está iniciando sesión.
- **Se anuncia la transición** a «hay versión nueva», no el estado: una versión posterior es otra
  transición, así que descartar una tarjeta se respeta hasta que salga otra.
- Botón **«Copiar diagnóstico»** (proveedor, estado, versión, origen, último error con hora).

### Control de errores

Lo pidió el usuario el 2026-10-27, con una captura de referencia.

```
┌────────────────────────────────────────────────┐
│ [logo] La actualización de OpenCode falló   ×  │
│        Sin permisos para escribir en la        │   ← una frase, la causa en palabras
│        carpeta global de npm.  [Reintentar]    │   ← la acción que corresponde a la causa
│        Mostrar detalles                        │   ← se despliega: últimas ~40 líneas + «Copiar»
└────────────────────────────────────────────────┘
```

- **Se clasifica el error en Rust** (`install.rs::classify`), leyendo el exit code y la salida de
  npm/brew/el instalador. El texto crudo nunca va como título. Cada clase tiene su frase y su acción:

  | Clase | Se detecta por | Mensaje | Acción |
  |---|---|---|---|
  | `network` | `ENOTFOUND`, `ETIMEDOUT`, `ECONNRESET`, 5xx del registry | Sin conexión con el registro | **Reintentar** (antes hay 1 reintento automático a los 10 s) |
  | `permission` | `EACCES`, `EPERM`, `Permission denied` | Sin permisos para escribir en … | **Copiar comando** (para la terminal) |
  | `in_use` | `EBUSY`, `in use`, el `claude.exe` bloqueado de Windows | El CLI está abierto en otro programa | **Reintentar** (pide cerrar las otras sesiones) |
  | `disk_full` | `ENOSPC` | No hay espacio en disco | Reintentar |
  | `tool_missing` | no aparece `npm`/`brew` en el PATH aumentado | No se encontró npm/brew | Copiar comando |
  | `brew_locked` | "another brew process", el lock de brew | Homebrew está ocupado | Reintentar |
  | `timeout` | más de 10 min sin terminar | Tardó demasiado | Reintentar |
  | `not_applied` | terminó bien pero `--version` no cambió | Se instaló, pero se sigue usando vY en *ruta* | **Mostrar rutas** (el caso de las dos copias) |
  | `broken` | después del fallo, el binario ya no existe o no responde | El CLI quedó sin instalar | **Reparar** (reinstala la versión anterior) + Copiar comando |
    | `unknown` | cualquier otra cosa | Falló la actualización | Reintentar + detalles |

- **No dejar el CLI roto.** Antes de instalar se guarda la versión y la ruta actuales. Si después
  del fallo el binario no está o no responde (`broken`), el motor se marca como no disponible
  (igual que cuando un CLI no está instalado). Además se ofrece **Reparar**: reinstalar exactamente
  `<pkg>@<versión anterior>` por el mismo canal.
- **«Mostrar detalles»** despliega las últimas ~40 líneas de salida, ya pasadas por
  `secret_scan::redact` (npm a veces imprime tokens del `.npmrc`), con un botón «Copiar». Todo queda
  también en `applog`.
- **Una tarjeta de error no expira sola**: se va con × o con éxito en el reintento. Un error en un
  CLI no frena a los demás en «Actualizar todos». Se pasa al siguiente, y al final queda un resumen:
  «3 actualizados, 1 falló».
- **El check del arranque nunca muestra errores** (sin red = silencio). Los errores solo aparecen
  cuando el usuario apretó Instalar.
- Fuera de alcance: los errores de *ejecución* de un motor (como «Error de OpenCode: Internal
  service failure») ya tienen su propio aviso. Estas tarjetas son solo de la actualización y no se
  mezclan con esos avisos.

### Cerrar y omitir

- **×** antes de instalar: oculta la tarjeta hasta la próxima apertura de la app.
- **«Omitir esta versión»**: no vuelve a avisar hasta que salga otra (`cli_updates_skipped`, por
  CLI).
- Si hay 2 o más tarjetas, arriba aparece un «Actualizar todos (N)». Los CLIs se instalan **de a
  uno**, para no poner a npm a competir consigo mismo.

---

## 2. Fases

### U1 — Detección (2 días)

- Módulo `src-tauri/src/cli_updates/`:
  - `catalog.rs`: CLI → paquetes por canal.
  - `channel.rs`: ruta resuelta → canal, con tests por cada forma de ruta en mac, Linux y Windows.
  - `latest.rs`: npm vía `npm.rs`, brew vía `brew info --json=v2`.
  - `check.rs`: `check_all() -> Vec<CliUpdate { provider, binary, path, channel, installed, latest,
    can_install, manual_command }>`.
- `engine_version`: agregar `forget(binary)` para invalidar la caché.
- Comando `cli_updates_check(force: bool)` y settings `cli_updates_enabled` (sí por defecto),
  `cli_updates_last_check` y `cli_updates_skipped`.

### U2 — Instalación con progreso (2–3 días)

- `install.rs`: `cli_updates_install(provider) -> install_id`. Emite el evento
  `cli-update:progress { id, stage, percent?, line }` y termina con `done | failed`.
- Si hay una ejecución activa con ese CLI, la instalación queda en cola. Una sola instalación a la
  vez.
- Verificación posterior y detección de las dos copias.
- `classify(exit, output) -> ErrorClass`, el reintento automático solo para `network`, la foto
  previa (versión + ruta), `cli_updates_repair(provider)` para `broken`, y la salida redactada en el
  evento `failed`.

### U3 — Tarjetas (2 días)

- `components/layout/CliUpdateCards.tsx`, con la misma pila y coreografía que `NotificationPopups`
  (MorphToast, `align="right"`). Son tarjetas *persistentes*: no expiran mientras haya una decisión o
  una instalación en curso.
- Logo del CLI (iconos de proveedor existentes), versión `vX → vY`, barra con el color del proveedor,
  «Instalar», «Omitir esta versión», × y «Actualizar todos».
- Store `cliUpdatesStore`: se arma al arrancar, después del check.
- Ajustes › Motores de IA: interruptor «Buscar actualizaciones de los CLI al abrir», «Buscar ahora»
  y la lista con versión instalada / última / canal.
- i18n es/en. Copy corto (ver la memoria *terse-in-app-copy*).

### U4 — Pruebas

- Unit: canal por ruta, comparación semver, cálculo de etapas, omitir versión, nada en el arranque si
  la red falla.
- Unit de `classify`: una muestra real de salida por clase (npm, brew, el `claude.exe` en uso de
  Windows), `not_applied` con dos copias, `broken` → Reparar, redacción de tokens en los detalles.
- vitest: las tarjetas (instalar, cerrar sin detener, actualizar todos, omitir, tarjeta de error con
  Reintentar/Mostrar detalles, resumen de «Actualizar todos» con un fallo).
- Prueba en vivo (`#[ignore]`): instalar una versión vieja de un paquete de prueba en un prefix npm
  temporal y actualizarla. **Nunca** sobre los CLIs reales del usuario en los tests.

**Total estimado: ~1.5 semanas** (el control de errores suma unos 2 días).

---

## 3. Decisiones pendientes del usuario

**Decidido 2026-10-27:** el × oculta hasta la próxima apertura; sí hay «Omitir esta versión»;
se revisa **solo al abrir la app** (sin revisión periódica con la app abierta). El tope de 12 h
sigue aplicando para no consultar en cada reinicio seguido.

Pendiente:

4. Cuando el canal es desconocido: ¿mostrar la tarjeta con el comando para copiar, o no mostrar
   nada?
