/**
 * The mobile client's own strings.
 *
 * # Why not `src/lib/i18n/translations.ts`
 *
 * That table is ~5,300 keys and its own header explains that English alone is ~325 KB parsed at
 * startup. Almost none of it names anything this client can show: there is no editor here, no
 * database workspace, no diagram gallery. Importing it would mean a phone on a weak connection
 * downloading and parsing the vocabulary of eleven screens it does not have, to use a hundred
 * strings.
 *
 * So this is a separate, deliberately small table — and it stays small. A string that belongs to a
 * desktop feature does not belong here, because the feature does not.
 *
 * The language is read from the browser rather than from the desktop's setting: the setting is not
 * in the command allowlist (it has no business being — a phone must not be able to read arbitrary
 * settings rows), and the phone's own locale is the better answer anyway. Whoever is holding it is
 * the one reading.
 *
 * # Keeping the two tables in step
 *
 * `en` is typed `Record<MobileKey, string>`, where `MobileKey` is derived from `es`. Adding a key
 * to one table and not the other is a compile error, which is the only mechanism that has ever kept
 * two translation tables honest.
 */

const es = {
  // ── Emparejamiento ──────────────────────────────────────────────────────────
  "pair.title": "Conecta tu CodeFlow",
  "pair.intro":
    "En el escritorio abre Ajustes → Control remoto y toca «Emparejar dispositivo». Escribe aquí los seis dígitos.",
  "pair.code": "Código",
  "pair.name": "Nombre de este dispositivo",
  "pair.namePlaceholder": "Mi iPhone",
  "pair.submit": "Emparejar",
  "pair.rejected": "Ese código no sirve. Pide uno nuevo en el escritorio.",
  "pair.unreachable": "No se puede alcanzar CodeFlow. Revisa que sigas en la misma red.",
  "pair.noWindow": "No hay un emparejamiento abierto. Ábrelo en el escritorio y vuelve a intentar.",
  "pair.checking": "Buscando tu CodeFlow…",
  "pair.ready": "CodeFlow está esperando tu código.",
  "pair.waiting": "CodeFlow responde, pero no hay ningún emparejamiento abierto.",

  // ── Navegación ──────────────────────────────────────────────────────────────
  "nav.repo": "Repo",
  "nav.prs": "PRs",
  "nav.chat": "Chat",
  "nav.agents": "Agentes",
  "nav.terminal": "Shell",
  "nav.settings": "Ajustes",
  "nav.tabs": "Secciones",
  "nav.gatesWaiting": "{n} esperando respuesta",

  "agents.chains": "Cadenas",
  "agents.runs": "Corridas",

  // ── Ámbito ──────────────────────────────────────────────────────────────────
  "scope.title": "Dónde estás trabajando",
  "scope.workspace": "Espacio",
  "scope.project": "Proyecto",
  "scope.change": "Cambiar espacio o proyecto",
  "scope.noProjects": "Este espacio no tiene proyectos.",
  "scope.movedAway": "Cambiaste de proyecto: se cerró lo que tenías abierto.",

  // ── Antes del commit ────────────────────────────────────────────────────────
  "precommit.title": "Antes del commit",
  "precommit.secrets": "Secretos",
  "precommit.secretsClean": "Sin secretos en lo que está en stage.",
  "precommit.analyze": "Revisar cambios",
  "precommit.analysis": "Lo que vio el modelo",

  // ── Pull requests ───────────────────────────────────────────────────────────
  "pr.open": "Pull requests abiertos",
  "pr.none": "No hay pull requests abiertos.",
  "pr.noneHint": "Cuando alguien abra uno en este repositorio, aparecerá aquí.",
  "pr.failed": "No se pudieron leer los pull requests.",
  "pr.review": "Revisar",
  "pr.reviewing": "Revisando…",
  "pr.openInHost": "Abrir",
  "pr.copyLink": "Copiar enlace",
  "pr.savedRuns": "Revisiones guardadas",
  "pr.noRuns": "Todavía no hay revisiones guardadas.",
  "pr.noRunsHint": "Toca «Revisar» en un pull request y el informe quedará aquí.",
  "pr.noFindings": "Esta revisión no encontró hallazgos.",
  "pr.allResolved": "No queda nada abierto: los {n} hallazgo(s) de esta revisión ya se cerraron.",
  "pr.reviewText": "Informe",
  "pr.diff": "Cambios del PR",
  "pr.iteration": "iteración {n}",
  "pr.findings": "Hallazgos activos",
  "pr.posted": "Publicado",
  "pr.approve": "Aprobar",
  "pr.approveConfirm": "Sí, aprobar",
  "pr.requestChanges": "Pedir cambios",
  "pr.requestChangesConfirm": "Sí, pedir cambios",
  "pr.publish": "Publicar este hallazgo",
  "pr.publishCount": "Publicar {n} en el PR",
  "pr.publishConfirm": "Sí, publicar",
  "pr.reply": "Responder en el hilo de este hallazgo",
  "pr.replyCount": "Responder en {n} hilo(s)",
  "pr.publishUnavailable":
    "Guardado por una versión anterior: no trae el comentario armado, así que se publica desde el escritorio.",
  "pr.discard": "Descartar como falso positivo",
  "pr.approved": "Aprobado",
  "pr.changesRequested": "Cambios pedidos",
  "pr.detailFailed": "No se pudo leer esta revisión.",
  "pr.otherProject": "Esta revisión es de otro proyecto. Vuelve a él para actuar sobre ella.",
  "pr.status.open": "Abierto",
  "pr.status.draft": "Borrador",
  "pr.status.merged": "Fusionado",
  "pr.status.closed": "Cerrado",

  // ── Chat ────────────────────────────────────────────────────────────────────
  "chat.empty": "Todavía no hay conversación en este proyecto.",
  "chat.emptyHint": "Escribe abajo y el modelo del escritorio responde con el repositorio a mano.",
  "chat.placeholder": "Escribe tu mensaje",
  "chat.send": "Enviar",
  "chat.new": "Conversación nueva",
  "chat.thinking": "Pensando…",
  "chat.failed": "No se pudo enviar. Tu mensaje sigue escrito abajo.",

  // ── Terminal ────────────────────────────────────────────────────────────────
  "terminal.refused":
    "Los terminales están apagados para dispositivos remotos. Actívalos en el escritorio, en Ajustes → Control remoto.",
  "terminal.loadFailed": "No se pudo cargar el terminal. Puede que la app se haya actualizado.",
  "terminal.close": "Cerrar terminal",
  "terminal.closeConfirm": "¿Cerrar esta terminal? El proceso que esté corriendo se mata.",
  "terminal.reopen": "Abrir otra vez",
  "terminal.retry": "Reintentar",
  "terminal.revoked": "El escritorio apagó los terminales remotos.",
  "terminal.profile": "Perfil de shell",
  "terminal.profileDefault": "Por defecto",
  "terminal.keyboard": "Teclado",

  // ── Estado de la conexión ───────────────────────────────────────────────────
  "status.reconnecting": "Reconectando…",
  "status.resync": "Te perdiste algo. Actualizando…",
  "status.unpaired": "Este dispositivo fue revocado.",
  "status.unpairedHint":
    "El escritorio ya no reconoce este teléfono. Pide un código nuevo para volver a entrar.",
  "status.repoFailed": "No se pudo leer el repositorio.",
  "status.offline": "Sin conexión con el escritorio",

  // ── Errores ─────────────────────────────────────────────────────────────────
  "error.crashed": "Algo se rompió al dibujar esta pantalla.",
  "error.reload": "Recargar",
  "error.notAllowed": "El escritorio no permite esa acción desde un dispositivo remoto.",
  "error.actionFailed": "No se pudo completar la acción.",

  // ── Diffs ───────────────────────────────────────────────────────────────────
  "diff.failed": "No se pudo leer el diff.",
  "diff.noText": "Este archivo no tiene cambios de texto para mostrar.",
  "diff.binary": "Archivo binario: no hay diff que mostrar.",
  "diff.more": "Ver {n} línea(s) más",
  "diff.textSize": "Tamaño del texto",
  "diff.smaller": "Achicar el texto",
  "diff.bigger": "Agrandar el texto",
  "diff.stats": "+{added} −{removed}",
  "diff.staged": "En stage",
  "diff.unstaged": "Sin stage",

  // ── Commits ─────────────────────────────────────────────────────────────────
  "commits.title": "Últimos commits",
  "commits.files": "{n} archivo(s)",
  "commits.none": "Este repositorio todavía no tiene commits.",
  "commits.unpushedMark": "sin enviar",

  // ── Ramas ───────────────────────────────────────────────────────────────────
  "branches.title": "Ramas",
  "branches.local": "Locales",
  "branches.remote": "Remotas",
  "branches.new": "Rama nueva",
  "branches.newPlaceholder": "nombre-de-la-rama",
  "branches.create": "Crear y cambiar",
  "branches.current": "Rama actual",
  "branches.locked": "Bloqueada",
  "branches.search": "Buscar rama",
  "branches.noMatch": "Ninguna rama coincide.",

  // ── Comunes ─────────────────────────────────────────────────────────────────
  "common.retry": "Reintentar",
  "common.loading": "Cargando…",
  "common.empty": "Nada por aquí.",
  "common.cancel": "Cancelar",
  "common.confirm": "Confirmar",
  "common.back": "Atrás",
  "common.dismiss": "Descartar",
  "common.copy": "Copiar",
  "common.copied": "Copiado.",
  "common.refresh": "Actualizar",
  "common.workspace": "Espacio",
  "common.project": "Proyecto",

  // ── Repositorio ─────────────────────────────────────────────────────────────
  "repo.branch": "Rama",
  "repo.staged": "En stage",
  "repo.unstaged": "Sin stage",
  "repo.untracked": "Sin seguimiento",
  "repo.conflicted": "En conflicto",
  "repo.clean": "El árbol de trabajo está limpio.",
  "repo.cleanHint": "No hay nada que enviar. Abajo está lo último que se commiteó.",
  "repo.stageAll": "Stage a todo",
  "repo.unstageAll": "Quitar todo del stage",
  "repo.stageThis": "Poner en stage",
  "repo.unstageThis": "Quitar del stage",
  "repo.stageOne": "Poner {file} en stage",
  "repo.unstageOne": "Quitar {file} del stage",
  "repo.commit": "Commit",
  "repo.commitMessage": "Mensaje del commit",
  "repo.commitPlaceholder": "Qué cambió y por qué",
  "repo.committing": "Haciendo commit…",
  "repo.push": "Push",
  "repo.pull": "Pull",
  "repo.fetch": "Fetch",
  "repo.unpushed": "{count} sin enviar",
  "repo.noProject": "Elige un proyecto arriba.",
  "repo.noProjectHint": "Toca el nombre del proyecto en la barra de arriba para elegir uno.",
  "repo.busy": "Trabajando…",
  "repo.changes": "Cambios",
  "repo.openDiff": "Ver los cambios de {file}",

  // ── Corridas ────────────────────────────────────────────────────────────────
  "runs.title": "Corridas",
  "runs.none": "Ninguna corrida activa.",
  "runs.noneHint":
    "Lo que corra el escritorio aparece aquí en vivo, línea por línea, mientras esta pantalla esté conectada.",
  "runs.live": "En vivo",
  "runs.cancel": "Cancelar corrida",
  "runs.output": "Salida",
  "runs.waiting": "Esperando salida…",
  "runs.finished": "Terminada",
  "runs.dismiss": "Quitar esta corrida",
  "runs.clearFinished": "Limpiar terminadas",
  "runs.history": "Historial",
  "runs.historyNone": "Todavía no hay nada en el historial de este proyecto.",
  "runs.historyFailed": "No se pudo leer el historial.",
  "runs.jobResult": "Resultado",
  "runs.jobFailed": "No se pudo leer el resultado.",

  // ── Cadenas ─────────────────────────────────────────────────────────────────
  "chains.title": "Cadenas",
  "chains.none": "No hay cadenas en este espacio.",
  "chains.noneHint": "Las cadenas se arman en el escritorio; desde aquí se responden y se retoman.",
  "chains.step": "Paso {current} de {total}",
  "chains.gateWaiting": "Esperando tu respuesta",
  "chains.gateAnswer": "Tu respuesta",
  "chains.gatePlaceholder": "Sigue adelante, o dile qué cambiar",
  "chains.approve": "Aprobar y seguir",
  "chains.skip": "Saltar este paso",
  "chains.retry": "Reintentar",
  "chains.resume": "Reanudar",
  "chains.abort": "Abortar",
  "chains.abortConfirm": "¿Abortar esta cadena? Los pasos que faltan no se ejecutan.",
  "chains.gone": "Esta cadena ya no existe en el escritorio.",
  "chains.failed": "No se pudo leer esta cadena.",
  "chains.steps": "Pasos",
  "chains.repos": "Repositorios",
  "chains.output": "Lo que devolvió",
  "chains.handoff": "Lo que se le pasa al siguiente paso",
  "chains.onlyWaiting": "Solo las que esperan",
  "chains.waitingCount": "{n} esperando",

  "chainStatus.queued": "En cola",
  "chainStatus.running": "Corriendo",
  "chainStatus.gated": "Esperando",
  "chainStatus.paused": "Pausada",
  "chainStatus.failed": "Falló",
  "chainStatus.done": "Lista",
  "chainStatus.aborted": "Abortada",

  // Why a chain or a step is not moving. The backend stores these as keys, not as prose, so the
  // reason is read in the reader's language rather than in whatever the machine that wrote it was
  // set to — and the phone was printing the key itself. Same wording as the desktop table, because
  // it is the same sentence about the same chain seen from another room.
  "chain.interrupted": "interrumpida — la app se cerró a mitad de un paso",
  "chain.repoBusy": "esperando al repositorio",
  "chain.projectGone": "el repositorio ya no está",
  "chain.agentNotRoutable": "el agente de un paso no tiene proveedor y modelo",
  "chain.attemptsExhausted": "el paso falló demasiadas veces",
  "chain.checkFailed": "falló la verificación de un paso — devolviendo el trabajo",
  "chain.dispatchesExhausted": "el plan agotó su presupuesto de pasos — está dando vueltas",
  "chain.emptyOutput": "un paso no devolvió nada — revisa antes de continuar",
  "chain.stopped": "lo detuviste tú",
  "chain.timedOut": "el paso tardó demasiado y se detuvo",
  // No es un `last_reason` como los diez anteriores: se rechaza *antes* de escribir nada, así que
  // es una frase para una persona y no una nota sobre una fila. Se lee como tal.
  "chain.gateMoved": "Esta pausa ya fue respondida — la cadena siguió adelante.",

  // ── Ajustes del teléfono ────────────────────────────────────────────────────
  "settings.title": "Ajustes",
  "settings.device": "Este dispositivo",
  "settings.deviceName": "Nombre",
  "settings.connection": "Conexión",
  "settings.connected": "Conectado al escritorio",
  "settings.disconnected": "Sin conexión",
  "settings.address": "Dirección",
  "settings.bundle": "Versión del cliente",
  "settings.terminals": "Terminales remotos",
  "settings.terminalsOn": "Permitidos por el escritorio",
  "settings.terminalsOff": "Apagados en el escritorio",
  "settings.unpair": "Olvidar este emparejamiento",
  "settings.unpairConfirm": "Sí, olvidar",
  "settings.unpairHint":
    "Borra el token de este teléfono y vuelve a la pantalla de emparejamiento. Para retirarlo también del escritorio, revócalo allí.",
  "settings.scope": "Ámbito",

  // ── Confirmaciones de acciones ──────────────────────────────────────────────
  // Cada acción que escribe algo dice que lo hizo. Antes siete de las ocho no decían nada, y en un
  // teléfono «no pasó nada» y «todavía no llega» se ven exactamente igual.
  "toast.staged": "En stage.",
  "toast.unstaged": "Fuera del stage.",
  "toast.committed": "Commit hecho.",
  "toast.pushed": "Enviado.",
  "toast.pulled": "Actualizado desde el remoto.",
  "toast.fetched": "Fetch listo.",
  "toast.checkedOut": "Ahora estás en {branch}.",
  "toast.branchCreated": "Rama {branch} creada.",
  "toast.gateApproved": "Cadena reanudada.",
  "toast.stepSkipped": "Paso saltado.",
  "toast.chainAborted": "Cadena abortada.",
  "toast.chainResumed": "Cadena reanudada.",
  "toast.stepRetried": "Reintentando el paso.",
  "toast.runCancelled": "Corrida cancelada.",
  "toast.reviewDone": "Revisión lista.",
  "toast.published": "Publicado en el pull request.",
  "toast.discarded": "Hallazgo descartado.",
  "toast.prApproved": "Pull request aprobado.",
  "toast.prChangesRequested": "Cambios pedidos.",
  "toast.terminalClosed": "Terminal cerrada.",
  "toast.analyzed": "Análisis listo.",
} as const;

export type MobileKey = keyof typeof es;

const en: Record<MobileKey, string> = {
  "pair.title": "Connect to your CodeFlow",
  "pair.intro":
    "On the desktop open Settings → Remote control and tap “Pair a device”. Type the six digits here.",
  "pair.code": "Code",
  "pair.name": "This device's name",
  "pair.namePlaceholder": "My iPhone",
  "pair.submit": "Pair",
  "pair.rejected": "That code does not work. Ask for a new one on the desktop.",
  "pair.unreachable": "Cannot reach CodeFlow. Check that you are still on the same network.",
  "pair.noWindow": "No pairing is open. Start one on the desktop and try again.",
  "pair.checking": "Looking for your CodeFlow…",
  "pair.ready": "CodeFlow is waiting for your code.",
  "pair.waiting": "CodeFlow answers, but no pairing is open.",

  "nav.repo": "Repo",
  "nav.prs": "PRs",
  "nav.chat": "Chat",
  "nav.agents": "Agents",
  "nav.terminal": "Shell",
  "nav.settings": "Settings",
  "nav.tabs": "Sections",
  "nav.gatesWaiting": "{n} waiting for an answer",

  "agents.chains": "Chains",
  "agents.runs": "Runs",

  "scope.title": "Where you are working",
  "scope.workspace": "Workspace",
  "scope.project": "Project",
  "scope.change": "Change workspace or project",
  "scope.noProjects": "This workspace has no projects.",
  "scope.movedAway": "You changed project, so what was open has been closed.",

  "precommit.title": "Before committing",
  "precommit.secrets": "Secrets",
  "precommit.secretsClean": "No secrets in what is staged.",
  "precommit.analyze": "Review changes",
  "precommit.analysis": "What the model saw",

  "pr.open": "Open pull requests",
  "pr.none": "No open pull requests.",
  "pr.noneHint": "When somebody opens one on this repository, it shows up here.",
  "pr.failed": "The pull requests could not be read.",
  "pr.review": "Review",
  "pr.reviewing": "Reviewing…",
  "pr.openInHost": "Open",
  "pr.copyLink": "Copy link",
  "pr.savedRuns": "Saved reviews",
  "pr.noRuns": "No saved reviews yet.",
  "pr.noRunsHint": "Tap “Review” on a pull request and the report stays here.",
  "pr.noFindings": "This review found nothing.",
  "pr.allResolved": "Nothing open left: all {n} finding(s) in this review have been closed.",
  "pr.reviewText": "Report",
  "pr.diff": "PR changes",
  "pr.iteration": "iteration {n}",
  "pr.findings": "Active findings",
  "pr.posted": "Posted",
  "pr.approve": "Approve",
  "pr.approveConfirm": "Yes, approve",
  "pr.requestChanges": "Request changes",
  "pr.requestChangesConfirm": "Yes, request changes",
  "pr.publish": "Publish this finding",
  "pr.publishCount": "Publish {n} on the PR",
  "pr.publishConfirm": "Yes, publish",
  "pr.reply": "Reply on this finding's thread",
  "pr.replyCount": "Reply on {n} thread(s)",
  "pr.publishUnavailable":
    "Saved by an older version: it carries no rendered comment, so publish this one from the desktop.",
  "pr.discard": "Dismiss as a false positive",
  "pr.approved": "Approved",
  "pr.changesRequested": "Changes requested",
  "pr.detailFailed": "This review could not be read.",
  "pr.otherProject": "This review belongs to another project. Switch back to it to act on it.",
  "pr.status.open": "Open",
  "pr.status.draft": "Draft",
  "pr.status.merged": "Merged",
  "pr.status.closed": "Closed",

  "chat.empty": "No conversation in this project yet.",
  "chat.emptyHint": "Type below and the desktop's model answers with the repository at hand.",
  "chat.placeholder": "Type your message",
  "chat.send": "Send",
  "chat.new": "New conversation",
  "chat.thinking": "Thinking…",
  "chat.failed": "Could not send. Your message is still in the box below.",

  "terminal.refused":
    "Terminals are switched off for remote devices. Turn them on at the desktop, under Settings → Remote control.",
  "terminal.loadFailed": "The terminal could not be loaded. The app may have been updated.",
  "terminal.close": "Close terminal",
  "terminal.closeConfirm": "Close this terminal? Whatever is running in it is killed.",
  "terminal.reopen": "Open again",
  "terminal.retry": "Try again",
  "terminal.revoked": "The desktop switched remote terminals off.",
  "terminal.profile": "Shell profile",
  "terminal.profileDefault": "Default",
  "terminal.keyboard": "Keyboard",

  "status.reconnecting": "Reconnecting…",
  "status.resync": "You missed something. Refreshing…",
  "status.unpaired": "This device was revoked.",
  "status.unpairedHint":
    "The desktop no longer recognises this phone. Ask for a new code to get back in.",
  "status.repoFailed": "The repository could not be read.",
  "status.offline": "No connection to the desktop",

  "error.crashed": "Something broke while drawing this screen.",
  "error.reload": "Reload",
  "error.notAllowed": "The desktop does not allow that action from a remote device.",
  "error.actionFailed": "That action could not be completed.",

  "diff.failed": "The diff could not be read.",
  "diff.noText": "This file has no text changes to show.",
  "diff.binary": "Binary file: there is no diff to show.",
  "diff.more": "Show {n} more line(s)",
  "diff.textSize": "Text size",
  "diff.smaller": "Smaller text",
  "diff.bigger": "Larger text",
  "diff.stats": "+{added} −{removed}",
  "diff.staged": "Staged",
  "diff.unstaged": "Not staged",

  "commits.title": "Recent commits",
  "commits.files": "{n} file(s)",
  "commits.none": "This repository has no commits yet.",
  "commits.unpushedMark": "unpushed",

  "branches.title": "Branches",
  "branches.local": "Local",
  "branches.remote": "Remote",
  "branches.new": "New branch",
  "branches.newPlaceholder": "branch-name",
  "branches.create": "Create and switch",
  "branches.current": "Current branch",
  "branches.locked": "Locked",
  "branches.search": "Find a branch",
  "branches.noMatch": "No branch matches.",

  "common.retry": "Try again",
  "common.loading": "Loading…",
  "common.empty": "Nothing here.",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.back": "Back",
  "common.dismiss": "Dismiss",
  "common.copy": "Copy",
  "common.copied": "Copied.",
  "common.refresh": "Refresh",
  "common.workspace": "Workspace",
  "common.project": "Project",

  "repo.branch": "Branch",
  "repo.staged": "Staged",
  "repo.unstaged": "Not staged",
  "repo.untracked": "Untracked",
  "repo.conflicted": "Conflicted",
  "repo.clean": "The working tree is clean.",
  "repo.cleanHint": "Nothing to send. What was committed last is below.",
  "repo.stageAll": "Stage everything",
  "repo.unstageAll": "Unstage everything",
  "repo.stageThis": "Stage this file",
  "repo.unstageThis": "Unstage this file",
  "repo.stageOne": "Stage {file}",
  "repo.unstageOne": "Unstage {file}",
  "repo.commit": "Commit",
  "repo.commitMessage": "Commit message",
  "repo.commitPlaceholder": "What changed, and why",
  "repo.committing": "Committing…",
  "repo.push": "Push",
  "repo.pull": "Pull",
  "repo.fetch": "Fetch",
  "repo.unpushed": "{count} unpushed",
  "repo.noProject": "Pick a project above.",
  "repo.noProjectHint": "Tap the project name in the top bar to choose one.",
  "repo.busy": "Working…",
  "repo.changes": "Changes",
  "repo.openDiff": "See what changed in {file}",

  "runs.title": "Runs",
  "runs.none": "No run is active.",
  "runs.noneHint":
    "Whatever the desktop runs shows up here live, line by line, for as long as this screen is connected.",
  "runs.live": "Live",
  "runs.cancel": "Cancel run",
  "runs.output": "Output",
  "runs.waiting": "Waiting for output…",
  "runs.finished": "Finished",
  "runs.dismiss": "Remove this run",
  "runs.clearFinished": "Clear finished",
  "runs.history": "History",
  "runs.historyNone": "Nothing in this project's history yet.",
  "runs.historyFailed": "The history could not be read.",
  "runs.jobResult": "Result",
  "runs.jobFailed": "The result could not be read.",

  "chains.title": "Chains",
  "chains.none": "No chains in this workspace.",
  "chains.noneHint": "Chains are built at the desk; from here you answer them and restart them.",
  "chains.step": "Step {current} of {total}",
  "chains.gateWaiting": "Waiting for you",
  "chains.gateAnswer": "Your answer",
  "chains.gatePlaceholder": "Carry on, or say what to change",
  "chains.approve": "Approve and continue",
  "chains.skip": "Skip this step",
  "chains.retry": "Try again",
  "chains.resume": "Resume",
  "chains.abort": "Abort",
  "chains.abortConfirm": "Abort this chain? The remaining steps will not run.",
  "chains.gone": "This chain no longer exists on the desktop.",
  "chains.failed": "This chain could not be read.",
  "chains.steps": "Steps",
  "chains.repos": "Repositories",
  "chains.output": "What it returned",
  "chains.handoff": "What the next step is given",
  "chains.onlyWaiting": "Only the waiting ones",
  "chains.waitingCount": "{n} waiting",

  "chainStatus.queued": "Queued",
  "chainStatus.running": "Running",
  "chainStatus.gated": "Waiting",
  "chainStatus.paused": "Paused",
  "chainStatus.failed": "Failed",
  "chainStatus.done": "Done",
  "chainStatus.aborted": "Aborted",

  "chain.interrupted": "interrupted — the app closed mid-step",
  "chain.repoBusy": "waiting for the repository",
  "chain.projectGone": "the repository is gone",
  "chain.agentNotRoutable": "a step's agent has no provider and model",
  "chain.attemptsExhausted": "the step failed too many times",
  "chain.checkFailed": "a step's check failed — sending the work back",
  "chain.dispatchesExhausted": "the plan ran out of its step budget — it is looping",
  "chain.emptyOutput": "a step returned nothing — check before continuing",
  "chain.stopped": "you stopped it",
  "chain.timedOut": "the step took too long and was stopped",
  "chain.gateMoved": "This gate was already answered — the chain has moved on.",

  "settings.title": "Settings",
  "settings.device": "This device",
  "settings.deviceName": "Name",
  "settings.connection": "Connection",
  "settings.connected": "Connected to the desktop",
  "settings.disconnected": "Not connected",
  "settings.address": "Address",
  "settings.bundle": "Client build",
  "settings.terminals": "Remote terminals",
  "settings.terminalsOn": "Allowed by the desktop",
  "settings.terminalsOff": "Switched off on the desktop",
  "settings.unpair": "Forget this pairing",
  "settings.unpairConfirm": "Yes, forget it",
  "settings.unpairHint":
    "Deletes this phone's token and returns to the pairing screen. To remove it from the desktop as well, revoke it there.",
  "settings.scope": "Scope",

  "toast.staged": "Staged.",
  "toast.unstaged": "Unstaged.",
  "toast.committed": "Committed.",
  "toast.pushed": "Pushed.",
  "toast.pulled": "Pulled.",
  "toast.fetched": "Fetched.",
  "toast.checkedOut": "You are on {branch} now.",
  "toast.branchCreated": "Branch {branch} created.",
  "toast.gateApproved": "Chain resumed.",
  "toast.stepSkipped": "Step skipped.",
  "toast.chainAborted": "Chain aborted.",
  "toast.chainResumed": "Chain resumed.",
  "toast.stepRetried": "Retrying the step.",
  "toast.runCancelled": "Run cancelled.",
  "toast.reviewDone": "Review ready.",
  "toast.published": "Posted on the pull request.",
  "toast.discarded": "Finding dismissed.",
  "toast.prApproved": "Pull request approved.",
  "toast.prChangesRequested": "Changes requested.",
  "toast.terminalClosed": "Terminal closed.",
  "toast.analyzed": "Analysis ready.",
};

/**
 * The table this phone reads, chosen once at module load.
 *
 * The phone's language does not change mid-session, and re-reading `navigator` per string would be
 * a property lookup on every render of every label.
 */
const spanish =
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("es");

const table: Record<MobileKey, string> = spanish ? es : en;

/**
 * Which language won, for anything that has to agree with it outside this module.
 *
 * `main.tsx` writes it onto `<html lang>`: the document is authored in Spanish and says so, but a
 * phone set to English gets the English table, and a screen reader was then announcing English
 * words in a Spanish voice.
 */
export const locale = spanish ? "es" : "en";

/** One string, with `{name}` placeholders filled in. Unknown keys render as themselves, which is
 *  visible in testing and harmless in production — the alternative is a blank where text belongs. */
export function t(key: MobileKey, vars?: Record<string, string | number>): string {
  let text: string = table[key] ?? key;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      text = text.replace(`{${name}}`, String(value));
    }
  }
  return text;
}
