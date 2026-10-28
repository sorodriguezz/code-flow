# Arquitectura multi-repo — plan

Lo pidió el usuario el 2026-10-27: con todos los repos de un sistema en el workspace (por ejemplo
5 core, 2 Azure Functions, 1 Redis, 3 BFF y 3 frontends), generar la arquitectura **completa**:
qué repo es qué, quién llama a quién, y los flujos trazados de punta a punta entre repos.

Estado: **plan, nada construido.**

---

## 0. Qué ya existe y qué falta

**Ya está:**

- **Arquitectura** (`src-tauri/src/architecture/`, `src/lib/architecture/`):
  - Acepta **varias** fuentes `ArchSource::Repo`. `scan_repo` saca hechos deterministas con
    `path:line`: compose, k8s, helm, terraform, bicep, openapi, ADR, dependencias y claves de
    `.env.example`.
  - Tiene canvas editable, «Ordenar» y lectura de cloud solo-lectura autorizada por lectura
    (`cloud.rs`, incluido Azure).
- **Archify** (Diagramas):
  - Lee **un** repo con herramientas en modo solo lectura (`ai::archify_repository`).
  - Ancla las fuentes (`ground_archify_answer`) y fija `meta.repository` a origin + HEAD.
  - Tiene 5 tipos: architecture, workflow, sequence, dataflow, lifecycle.
  - `archify_suggest.rs` ya detecta rutas HTTP en NestJS, Express, FastAPI, Flask, Spring, Go, axum,
    actix, Next, Laravel y Rails.
- **codemap**: símbolos, imports y usos por repo, con caché por blob id.

**Por qué hoy no sale "completísimo":**

1. **Una sola llamada al modelo con resúmenes recortados.** `architecture_generate` reparte
   `GENERATE_BUDGET` (90k) entre las fuentes, con un mínimo de 8k cada una. Con 13 repos, cada uno
   queda en ~8k de README y manifiestos, y el modelo no lee código.
2. **Los hechos no incluyen rutas expuestas ni llamadas salientes.** Sin eso no se puede unir el
   frontend con el BFF ni el BFF con el core.
3. **No se reconocen los triggers de Azure Functions** (`host.json`, `function.json`,
   `app.http(...)`, `[HttpTrigger]`, `[ServiceBusTrigger]`, `[TimerTrigger]`).
4. **No hay enlace entre repos ni niveles de confianza.**
5. **Archify es de un solo repo.** Un flujo que cruza 4 repos no tiene dónde trazarse.

---

## 1. Diseño

**El modelo de sistema vive en Arquitectura; los flujos se dibujan con archify.**
Arquitectura ya tiene multi-fuente, cloud y canvas, así que meter el sistema en Diagramas
duplicaría todo eso.

```
13 repos ──A1──→ ficha por repo (determinista, caché por HEAD)
                    │  rol · expone (rutas, triggers, consumidores) · consume (HTTP, env, Redis, colas)
                    ▼
            ──A2──→ enlaces entre repos con confianza (verificado · configurado · inferido · sin resolver)
                    │
            ──A3──→ (opcional) pase IA por repo, solo para huecos
                    ▼
            ──A4──→ documento de Arquitectura por carriles + evidencia por arista
            ──A5──→ flujos trazados → archify sequence/dataflow multi-repo
```

**Principio:** el grafo se arma **sin el modelo**. El modelo nombra, describe y llena huecos, pero
nunca inventa una arista. Si una arista no tiene evidencia, aparece como «sin resolver», no como
conexión.

---

## 2. Fases

### A1 — Ficha por repo (4–5 días)

Módulo nuevo `src-tauri/src/architecture/repo_card.rs`. `RepoCard { role, role_reason, exposes,
consumes, infra }`, con cada entrada en `path:line`.

- **Rol** (deducido, y el usuario puede corregirlo):
  - `frontend`: react, vue, angular, next o svelte sin servidor propio.
  - `function`: `host.json`, `function.json`, `@azure/functions`, o
    `Microsoft.Azure.Functions.Worker` en el csproj.
  - `bff`: un servidor que expone rutas *y* casi solo llama a otros servicios.
  - `core`: un servidor con persistencia propia.
  - `worker`, `library` u `other`.
  - BFF y core se confunden fácil, por eso el rol siempre se muestra con su motivo y se puede cambiar.
- **Expone:**
  - Rutas: se hace `pub` `archify_suggest::routes_in`, ampliado con el método.
  - Triggers de functions: http con su ruta, queue/servicebus/eventhub con su nombre, timer.
  - Consumidores de colas y topics.
  - OpenAPI, que ya se lee hoy.
- **Consume:**
  - Llamadas HTTP: axios/fetch/ky, `HttpClient`, `RestTemplate`/`WebClient`/Feign, refit, `requests`.
    De cada una se guarda **la expresión de la URL** (literal, template o variable de entorno).
  - Claves de entorno referenciadas: `process.env.X`, `import.meta.env.X`, `IConfiguration["X"]`,
    `@Value("${x}")`, `os.environ`.
  - Productores de colas y topics.
  - Clientes Redis (ioredis, node-redis, StackExchange.Redis, spring-data-redis), con los prefijos de
    clave literales.
- **Infraestructura:** BD, Redis, Service Bus y Storage, a partir de dependencias más compose,
  bicep o terraform (eso ya sale de `scan_repo`).
- **Caché** por HEAD más el estado del working tree, en `cache_dir()/archcards/`. Un pull solo
  recalcula los repos que cambiaron.
- Regex primero. Si se necesitan símbolos, se usa codemap. No hay dependencias nuevas.
- `.env` nunca se abre (como hoy) y todo pasa por `secret_scan::redact`.

### A2 — Enlaces entre repos (3–4 días)

Módulo `src-tauri/src/architecture/links.rs`: `link(cards) -> Vec<Link { from, to, kind, via,
confidence, evidence: [desde, hasta] }>` más `unresolved: Vec<Consume>`.

Las estrategias, de la más fuerte a la más débil:

1. **Ruta + método:** se normalizan `/orders/:id`, `/orders/{id}` y `` `/orders/${id}` `` a
   `/orders/*`, y se descarta el prefijo de base/versión, que es configurable. Si la evidencia está
   en ambos lados, el enlace es **verificado**.
2. **Configuración:** valores no secretos de `appsettings*.json`, `.env.example`, helm values,
   bicep/terraform app settings y YAML de pipelines. Solo cuentan hostnames y paths base. El enlace
   es **configurado**.
3. **Colas y topics:** el mismo nombre en un productor y un consumidor da un enlace **verificado**.
4. **Redis o BD compartidos:** la misma clave de conexión o el mismo host crean un nodo de
   infraestructura compartido. No se modela como arista entre repos.
5. **Nombre:** por ejemplo `ORDERS_API_URL` ↔ el repo `orders-api`. El enlace es **inferido**.
6. **Opcional, con autorización:** las App Settings de Azure vía `cloud.rs` dan los hostnames reales,
   y con eso se llega a la Function App o el App Service y de ahí al repo. Sube un enlace inferido a
   **configurado**.

Una llamada que no se resuelve **nunca se descarta**: va a `unresolved`, y en la interfaz el
usuario puede asignarle un destino a mano. Esa asignación se guarda como override en el documento.

### A3 — Pase IA por repo, opcional (2 días)

- Solo cuando A1 dejó huecos: URLs dinámicas, rol ambiguo, falta describir el propósito.
- Un run por repo con `cwd` = el repo, en solo lectura, como `archify_repository`. Recibe la ficha
  como orientación y devuelve un JSON acotado que se ancla con el mismo criterio de fuentes.
- Concurrencia de 2–3 runs para respetar la cuota. Usa la caché por HEAD. El progreso se ve por repo.
- Se puede saltar: sin IA, igual sale una arquitectura correcta pero menos descrita.

### A4 — Documento de arquitectura (2–3 días)

- Composición **determinista**: fichas + enlaces → documento de Arquitectura con un nodo por repo
  y nodos de infraestructura compartida.
  - Carriles: Frontends | BFF | Core | Functions | Datos/Infra.
  - Cada arista lleva su evidencia (ambos `path:line`). Las aristas inferidas van punteadas y las de
    sin resolver, aparte.
- El modelo solo pone títulos y descripciones (`architecture_turn`, con las fichas como fuente en
  vez del resumen recortado).
- En el diálogo de fuentes: un botón «Todos los repos del workspace», un chip de rol por repo
  (editable) y una vista previa de lo que cada ficha encontró antes de generar.

### A5 — Flujos trazados entre repos (3–4 días)

- Se elige un punto de entrada (una ruta o página del frontend, o una ruta del BFF) y se recorre el
  grafo de A2. El resultado es una `sequence` (o `dataflow`) de archify donde los participantes son
  los repos y la infraestructura, con una fuente por salto.
- Sugerencias automáticas: los puntos de entrada con más saltos hacia abajo, como chips en
  `ArchifyTopicDialog`.
- Los pasos dentro de cada repo los llena un run por repo involucrado (el motor solo ve un `cwd`).
  Los runs se componen con el esqueleto determinista.
- IR: `meta.repositories[]`, con un pin (origin + HEAD) por repo, y fuentes con prefijo
  `repo:path`. `ground_archify_answer` pasa a resolver cada fuente contra su repo.
- Export al CLI de archify: es una decisión pendiente (ver §3).

### A6 — Re-verificar y cambios (1–2 días)

- «Re-verificar»: recalcula las fichas de los repos cuyo HEAD cambió y vuelve a enlazar.
  `delta.ts` ya compara arquitecturas y muestra qué aristas aparecieron o desaparecieron.
- Si se construye el plan `agent-loop.md`, se puede montar encima un loop que verifique cada arista
  (verificador determinista: ¿sigue existiendo la ruta?, ¿sigue existiendo la llamada?).

### A7 — Pruebas

- Fixture neutral (por ejemplo "shop"): 2 frontends, 1 BFF, 2 core, 1 function (HTTP + queue) y
  Redis por compose.
- Tests por estrategia de enlace, por normalización de rutas, por detección de rol y por "sin
  resolver nunca se pierde".
- Prueba en vivo opcional sobre los repos reales del usuario: la corre el usuario, no va en fixtures.

**Total estimado: ~3–4 semanas** (A1+A2+A4 son el núcleo, ~2 semanas; A3, A5 y A6 suman encima).

---

## 3. Decisiones pendientes del usuario

1. ~~¿Dónde vive?~~ **Decidido 2026-10-27: el mapa general en Arquitectura; cada flujo como diagrama
   archify.**
2. ~~¿Leer las App Settings de Azure (A2.6)?~~ **Decidido 2026-10-27: sí, siempre con permiso previo**
   (la tarjeta muestra los comandos exactos antes de correr nada, como hoy en `cloud.rs`).
3. Export de un flujo multi-repo a archify: ¿`meta.repository` = el repo de entrada (compatible con
   el CLI) o solo `meta.repositories[]` (no compatible)?
4. ¿Tope de repos por generación? (Propuesta: 30.)
