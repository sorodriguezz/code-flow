# Agent loop — plan

Lo pidió el usuario el 2026-10-27: un master le pide trabajo a workers, cada uno con su función, y
**iteran hasta que el resultado quede pulido**. Los agentes y las chains ya existen, así que lo que
falta es el loop con criterio de parada.

Estado: **plan, nada construido.**

---

## 0. Qué ya existe y qué falta

**Ya está:**

- **Workers con rol.** Son los `WorkspaceAgent` ([models.rs:111](../../src-tauri/src/db/models.rs)),
  con nombre, rol, proveedor, modelo, prompt y cuenta.
- **Saltos que hacen loop.** Un step trae `check_command`, `on_pass` y `on_fail`, y si `on_fail` apunta
  a un step anterior, eso es un loop. `jump_to` deja en `pending` todo lo que va desde el destino
  hacia adelante y le escribe `feedback` (con `rejection_note`: qué check falló, su salida y lo que
  reportó el step) ([queries.rs:3093](../../src-tauri/src/db/queries.rs)).
- **Frenos.** `MAX_STEP_ATTEMPTS = 3`, `MAX_CHAIN_DISPATCHES = 128` y `MAX_CHAIN_STEPS = 16`, todos
  aplicados en `claim_next_chain_step`, el único sitio que reparte trabajo.
- **Un revisor que devuelve trabajo, pero solo en híbrido.** `absorb_hybrid_review` lee
  `VERDICT: FIX` y una lista de arreglos, y llama a `loop_back_to_execute`, que resetea `attempts`
  por ronda. Tiene `MAX_FIX_ROUNDS = 2`.
- **Fases solo-lectura.** El análisis del story realizer corre con herramientas de solo lectura
  forzadas (`running_story_step_phase`).

**Qué falta:**

1. **En una chain normal, solo el exit code del check dispara `on_fail`.** El veredicto de un agente
   revisor no puede devolver trabajo, porque eso solo lo hace el modo híbrido.
2. **"Hasta pulir" está topado en ~2 vueltas.** `jump_to` *no* resetea `attempts` (a propósito), así
   que a un worker devuelto 2 veces ya se le acabaron los 3 intentos y la chain falla con
   `chain.attemptsExhausted`.
3. **No hay criterio de convergencia.** Un revisor LLM siempre encuentra algo, y no se detecta "no
   hubo progreso" ni "dio lo mismo que la vuelta anterior".
4. **`feedback` lleva solo el último rechazo.** El worker no sabe qué se intentó dos vueltas antes,
   así que puede oscilar A→B→A.

Fuera de alcance: el **master dinámico** (un step que crea steps nuevos en ejecución). En este plan,
el "master" es el plan de la chain más el revisor. Si los planes fijos se quedan cortos, el master
dinámico es la fase siguiente.

---

## 1. Diseño

```
[worker A] → [worker B] → [revisor] ──VERDICT: OK──→ siguiente / fin
     ↑                        │
     └──── VERDICT: FIX ──────┘  (feedback = hallazgos con evidencia + registro de vueltas)
```

- **El revisor es un step con `kind = 'review'`.** Corre **solo lectura** y responde con un bloque
  estructurado. Si el motor no puede forzar solo lectura (`enforces_read_only`), se rechaza, como en
  archify. Un revisor que puede editar no es un revisor.
- **Primero el check, después el revisor.** Si el step tiene `check_command`, ese corre antes y su
  fallo manda como siempre. El veredicto LLM solo se consulta cuando el check pasa (o cuando no hay
  check).
- **Los hallazgos llevan severidad y evidencia:** `must` | `should` | `nit` + `file:line` + qué está
  mal + cómo se comprueba. Solo `must` (y `should`, si el loop lo pide) devuelve trabajo. Los `nit`
  se reportan al final sin bloquear.
- **Los hallazgos se anclan.** Un hallazgo cuyo `file:line` no existe en el working copy se descarta
  (mismo criterio que `ground_archify_answer`). Un `FIX` sin ningún `must` anclado cuenta como `OK`.
  Esto corta los nits fantasma, que son la causa principal de los loops infinitos.
- **Vueltas ≠ intentos.** Una vuelta es el plan funcionando y un intento es un reintento por error.
  Al volver por veredicto se resetean `attempts` del tramo, como hace `loop_back_to_execute`, y se
  cuenta una vuelta. `MAX_CHAIN_DISPATCHES` sigue siendo el techo duro.

---

## 2. Fases

### L1 — Step revisor con veredicto (3–4 días)

- Migración: `agent_chain_steps.kind TEXT NOT NULL DEFAULT ''` (`''` | `review`) y
  `review_threshold TEXT NOT NULL DEFAULT 'must'` (`must` | `should`).
- Módulo nuevo `src-tauri/src/chain_review.rs`:
  - `review_instruction(step, threshold)` arma el bloque que se agrega al prompt del revisor: el
    formato de salida y la regla de evidencia.
  - `parse_review(answer) -> Option<Review { verdict, findings: Vec<Finding> }>`, con
    `Finding { severity, file, line, problem, check }`.
  - `ground_findings(review, roots)` descarta lo que no resuelve, contando todos los repos de la
    chain (`agent_chain_repos`).
  - Si la respuesta es ilegible, la chain se estaciona con `chain.reviewUnreadable` y **no pasa**.
    Una respuesta que no se puede leer no es una aprobación, igual que el `VERDICT` ilegible del
    story realizer.
- En `complete_chain_step`, una rama nueva junto a la de `check_failed`: si `kind == 'review'` y el
  veredicto efectivo es `FIX`, se hace `jump_to(on_fail, nota_con_hallazgos)` y la chain queda en
  estado `queued` con `chain.reviewRejected`.
- `compose_step_message` le agrega `review_instruction` al step revisor.
- Solo lectura: se extiende el mecanismo de `running_story_step_phase` a `kind = 'review'`.
- `chainStore.settleStep` no cambia: el veredicto se lee en Rust, como el híbrido.

### L2 — Vueltas y presupuesto (1–2 días)

- Migración: `agent_chains.laps INTEGER DEFAULT 0` y `agent_chain_steps.max_laps INTEGER DEFAULT 3`
  (solo tiene sentido en el revisor; el rango permitido es 1..=8).
- Al rechazar por veredicto: `laps += 1`, y `attempts = 0` para `step_index >= on_fail`.
- Al llegar a `max_laps`, la chain **se estaciona con un gate**, no falla:
  `chain.lapsExhausted`, con tres botones: «Aceptar como está», «Una vuelta más» y «Abortar». Es una
  decisión del usuario, no un error.
- `MAX_CHAIN_DISPATCHES` no cambia, para que ninguna combinación pase de 128 ejecuciones.

### L3 — Convergencia y registro de vueltas (2–3 días)

- Tabla `agent_chain_laps(chain_id, lap, review_step, must_count, should_count, findings_hash,
  diff_hash, summary, created_at)`.
  - `diff_hash`: sha de `git diff HEAD` más los archivos sin trackear en cada repo de la chain.
  - `findings_hash`: los hallazgos normalizados (archivo + problema, sin la línea exacta).
- Reglas de parada. Las evalúa el step revisor después de leer el veredicto:
  - `must_count == 0` (anclado) → pasa.
  - Igual `diff_hash` que la vuelta anterior → `chain.noProgress`: el worker no cambió nada.
  - Igual `findings_hash` dos vueltas seguidas → `chain.noProgress`: está pidiendo lo mismo.
  - `must_count` no baja en 2 vueltas → `chain.stalled`.
  - Las tres estacionan con el mismo gate que L2. Nunca terminan en `failed` silencioso.
- `rejection_note` incluye un resumen acotado del registro, de unos 1.5k caracteres: "vuelta 1:
  5 must (…), vuelta 2: 2 must (…), ya se intentó X". Eso corta la oscilación.

### L4 — Protección contra reward hacking (1 día)

- `agent_chain_steps.protected_paths TEXT` en el revisor: globs, por ejemplo `**/*.test.ts`,
  `**/__snapshots__/**` o el archivo del check.
- Si el diff de la vuelta toca un path protegido, el revisor recibe esos archivos como un `must`
  automático ("revertir cambios en X") y la vuelta no puede pasar. Es determinista y no depende del
  modelo.

### L5 — Interfaz (2–3 días)

- `NewChainModal`:
  - Agregar el tipo de step «Revisor», con destino al fallar (se reutiliza el selector de `on_fail`
    y su re-apuntado al reordenar), umbral (`must` / `must+should`), máximo de vueltas y paths
    protegidos.
  - Las plantillas guardan todo esto, porque no depende del workspace (igual que `check_command`).
- `ChainDetail`:
  - Una línea de vueltas: `vuelta 1 · 5 must → vuelta 2 · 2 → vuelta 3 · 0 ✓`.
  - Hallazgos expandibles con `file:line` clickeable.
  - El motivo de parada y el gate de L2.
- Llevar los tipos a `types/domain.ts`, `remoteStore.ts` (cliente móvil) y el `TaskTree`.
- i18n: `chain.reviewRejected`, `chain.reviewUnreadable`, `chain.lapsExhausted`, `chain.noProgress`
  y `chain.stalled`.
- Codi: si el vocabulario de chains nombra estados, sumar los nuevos (`lib/codi/vocabulary.ts`).

### L6 — Pruebas

Unit tests en `queries.rs`, con la misma forma que los del híbrido:

- El revisor `FIX` devuelve al destino con los hallazgos en `feedback`.
- Un hallazgo no anclado no devuelve trabajo.
- Una respuesta ilegible estaciona y no aprueba.
- Las vueltas resetean `attempts` pero no `dispatches`.
- `max_laps` estaciona con gate.
- Un `diff_hash` repetido da `noProgress`.
- Tocar un path protegido da un `must` automático.
- Una plantilla guarda y recupera los campos nuevos.

Prueba en vivo opcional (`#[ignore]`): una chain worker → revisor sobre un repo temporal con un bug
plantado, con Claude Haiku.

**Total estimado: ~2 semanas.**

---

## 3. Decisiones pendientes del usuario

1. ~~¿`should` devuelve trabajo?~~ **Decidido 2026-10-27: selector «Exigencia» por chain,
   «correcto» (solo `must`) por defecto; «pulido» = `must` + `should`. Los `nit` nunca devuelven.**
   Reemplaza al `review_threshold` de L1 (mismos valores, nombre de UI «Exigencia»).
2. ~~¿Valor por defecto de `max_laps`?~~ **Decidido 2026-10-27: 3 por defecto, tope 8.**
3. ¿El revisor puede ser el mismo motor/modelo que el worker? (Propuesta: se permite, pero se avisa
   en el modal. Con otro modelo se aprueba menos a sí mismo.)
4. Cuando se para por `noProgress`, ¿gate siempre, o terminar con lo que hay si no quedan `must`?
