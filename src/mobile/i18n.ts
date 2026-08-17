/**
 * The mobile client's own strings.
 *
 * # Why not `src/lib/i18n/translations.ts`
 *
 * That table is ~5,300 keys and its own header explains that English alone is ~325 KB parsed at
 * startup. Almost none of it names anything this client can show: there is no editor here, no
 * terminal, no database workspace, no diagram gallery. Importing it would mean a phone on a weak
 * connection downloading and parsing the vocabulary of eleven screens it does not have, to use
 * sixty strings.
 *
 * So this is a separate, deliberately small table — and it stays small. A string that belongs to a
 * desktop feature does not belong here, because the feature does not.
 *
 * The language is read from the browser rather than from the desktop's setting: the setting is not
 * in the command allowlist (it has no business being — a phone must not be able to read arbitrary
 * settings rows), and the phone's own locale is the better answer anyway. Whoever is holding it is
 * the one reading.
 */

const es = {
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

  "nav.repo": "Repo",
  "nav.prs": "PRs",
  "nav.chat": "Chat",
  "nav.agents": "Agentes",
  "nav.terminal": "Shell",

  "agents.chains": "Cadenas",
  "agents.runs": "Corridas",

  "precommit.title": "Antes del commit",
  "precommit.secrets": "Secretos",
  "precommit.secretsClean": "Sin secretos en lo que está en stage.",
  "precommit.analyze": "Revisar cambios",

  "pr.open": "Pull requests abiertos",
  "pr.none": "No hay pull requests abiertos.",
  "pr.review": "Revisar",
  "pr.openInHost": "Abrir",
  "pr.savedRuns": "Revisiones guardadas",
  "pr.noRuns": "Todavía no hay revisiones guardadas.",
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

  "chat.empty": "Todavía no hay conversación en este proyecto.",
  "chat.placeholder": "Escribe tu mensaje",
  "chat.send": "Enviar",
  "chat.new": "Conversación nueva",

  "terminal.refused":
    "Los terminales están apagados para dispositivos remotos. Actívalos en el escritorio, en Ajustes → Control remoto.",
  "terminal.loadFailed": "No se pudo cargar el terminal. Puede que la app se haya actualizado.",
  "terminal.close": "Cerrar terminal",
  "terminal.closeConfirm": "¿Cerrar esta terminal? El proceso que esté corriendo se mata.",
  "terminal.reopen": "Abrir otra vez",

  "status.reconnecting": "Reconectando…",
  "status.resync": "Te perdiste algo. Actualizando…",
  "status.unpaired": "Este dispositivo fue revocado.",
  "status.repoFailed": "No se pudo leer el repositorio.",

  "error.crashed": "Algo se rompió al dibujar esta pantalla.",
  "error.reload": "Recargar",
  "error.notAllowed": "El escritorio no permite esa acción desde un dispositivo remoto.",

  "diff.failed": "No se pudo leer el diff.",
  "diff.noText": "Este archivo no tiene cambios de texto para mostrar.",
  "diff.binary": "Archivo binario: no hay diff que mostrar.",
  "diff.more": "Ver {n} línea(s) más",

  "commits.title": "Últimos commits",
  "commits.files": "{n} archivo(s)",

  "branches.title": "Ramas",
  "branches.local": "Locales",
  "branches.remote": "Remotas",
  "branches.new": "Rama nueva",
  "branches.newPlaceholder": "nombre-de-la-rama",
  "branches.create": "Crear y cambiar",

  "common.retry": "Reintentar",
  "common.loading": "Cargando…",
  "common.empty": "Nada por aquí.",
  "common.cancel": "Cancelar",
  "common.confirm": "Confirmar",
  "common.workspace": "Espacio",
  "common.project": "Proyecto",

  "repo.branch": "Rama",
  "repo.staged": "En stage",
  "repo.unstaged": "Sin stage",
  "repo.untracked": "Sin seguimiento",
  "repo.conflicted": "En conflicto",
  "repo.clean": "El árbol de trabajo está limpio.",
  "repo.stageAll": "Stage a todo",
  "repo.unstageAll": "Quitar todo del stage",
  "repo.commit": "Commit",
  "repo.commitMessage": "Mensaje del commit",
  "repo.commitPlaceholder": "Qué cambió y por qué",
  "repo.push": "Push",
  "repo.pull": "Pull",
  "repo.fetch": "Fetch",
  "repo.unpushed": "{count} sin enviar",
  "repo.noProject": "Elige un proyecto arriba.",
  "repo.busy": "Trabajando…",

  "runs.title": "Corridas",
  "runs.none": "Ninguna corrida activa.",
  "runs.live": "En vivo",
  "runs.cancel": "Cancelar corrida",
  "runs.output": "Salida",
  "runs.waiting": "Esperando salida…",

  "chains.title": "Cadenas",
  "chains.none": "No hay cadenas en este espacio.",
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

  "nav.repo": "Repo",
  "nav.prs": "PRs",
  "nav.chat": "Chat",
  "nav.agents": "Agents",
  "nav.terminal": "Shell",

  "agents.chains": "Chains",
  "agents.runs": "Runs",

  "precommit.title": "Before committing",
  "precommit.secrets": "Secrets",
  "precommit.secretsClean": "No secrets in what is staged.",
  "precommit.analyze": "Review changes",

  "pr.open": "Open pull requests",
  "pr.none": "No open pull requests.",
  "pr.review": "Review",
  "pr.openInHost": "Open",
  "pr.savedRuns": "Saved reviews",
  "pr.noRuns": "No saved reviews yet.",
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

  "chat.empty": "No conversation in this project yet.",
  "chat.placeholder": "Type your message",
  "chat.send": "Send",
  "chat.new": "New conversation",

  "terminal.refused":
    "Terminals are switched off for remote devices. Turn them on at the desktop, under Settings → Remote control.",
  "terminal.loadFailed": "The terminal could not be loaded. The app may have been updated.",
  "terminal.close": "Close terminal",
  "terminal.closeConfirm": "Close this terminal? Whatever is running in it is killed.",
  "terminal.reopen": "Open again",

  "status.reconnecting": "Reconnecting…",
  "status.resync": "You missed something. Refreshing…",
  "status.unpaired": "This device was revoked.",
  "status.repoFailed": "The repository could not be read.",

  "error.crashed": "Something broke while drawing this screen.",
  "error.reload": "Reload",
  "error.notAllowed": "The desktop does not allow that action from a remote device.",

  "diff.failed": "The diff could not be read.",
  "diff.noText": "This file has no text changes to show.",
  "diff.binary": "Binary file: there is no diff to show.",
  "diff.more": "Show {n} more line(s)",

  "commits.title": "Recent commits",
  "commits.files": "{n} file(s)",

  "branches.title": "Branches",
  "branches.local": "Local",
  "branches.remote": "Remote",
  "branches.new": "New branch",
  "branches.newPlaceholder": "branch-name",
  "branches.create": "Create and switch",

  "common.retry": "Try again",
  "common.loading": "Loading…",
  "common.empty": "Nothing here.",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.workspace": "Workspace",
  "common.project": "Project",

  "repo.branch": "Branch",
  "repo.staged": "Staged",
  "repo.unstaged": "Not staged",
  "repo.untracked": "Untracked",
  "repo.conflicted": "Conflicted",
  "repo.clean": "The working tree is clean.",
  "repo.stageAll": "Stage everything",
  "repo.unstageAll": "Unstage everything",
  "repo.commit": "Commit",
  "repo.commitMessage": "Commit message",
  "repo.commitPlaceholder": "What changed, and why",
  "repo.push": "Push",
  "repo.pull": "Pull",
  "repo.fetch": "Fetch",
  "repo.unpushed": "{count} unpushed",
  "repo.noProject": "Pick a project above.",
  "repo.busy": "Working…",

  "runs.title": "Runs",
  "runs.none": "No run is active.",
  "runs.live": "Live",
  "runs.cancel": "Cancel run",
  "runs.output": "Output",
  "runs.waiting": "Waiting for output…",

  "chains.title": "Chains",
  "chains.none": "No chains in this workspace.",
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
};

// Resolved once at module load. The phone's language does not change mid-session, and re-reading
// it per render would be a `navigator` hit on every string.
const table: Record<MobileKey, string> =
  typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("es") ? es : en;

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
