/**
 * One document per archify type, written the way an engine writes them: no positions, ids and
 * types a little loose. The same five are what the layout, parser and viewer tests run against.
 */

export const ARCHITECTURE = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Shop", subtitle: "Customers order through the web app; the API persists orders and queues fulfilment for a worker." },
  components: [
    { id: "customers", type: "external", label: "Customers", sublabel: "Browser / mobile" },
    { id: "web", type: "frontend", label: "Web app", sublabel: "React SPA", sources: [{ path: "web/src/main.tsx", line: 1, end_line: 40, label: "entry point" }] },
    { id: "auth", type: "security", label: "Auth service", sublabel: "OAuth 2.0 + JWT", tag: "PKCE" },
    { id: "api", type: "backend", label: "Orders API", sublabel: "Node · Fastify", sources: [{ path: "api/src/server.ts", line: 12 }, { path: "api/src/orders.ts" }] },
    { id: "db", type: "database", label: "PostgreSQL", sublabel: "orders, customers" },
    { id: "cache", type: "database", label: "Redis", sublabel: "session cache" },
    { id: "queue", type: "messagebus", label: "Jobs queue", sublabel: "BullMQ" },
    { id: "worker", type: "backend", label: "Fulfilment worker", sublabel: "background jobs" },
    { id: "payments", type: "external", label: "Payment provider", sublabel: "card payments" },
    { id: "cdn", type: "cloud", label: "CDN", sublabel: "static assets" },
  ],
  boundaries: [
    { kind: "region", label: "Production cluster", wraps: ["api", "db", "cache", "queue", "worker"] },
    { kind: "security-group", label: "Private network", wraps: ["db", "cache"] },
  ],
  connections: [
    { from: "customers", to: "web", label: "HTTPS", variant: "emphasis" },
    { from: "customers", to: "cdn", label: "assets", variant: "dashed" },
    { from: "web", to: "api", label: "REST /api", variant: "emphasis" },
    { from: "web", to: "auth", label: "login", variant: "security" },
    { from: "api", to: "auth", label: "verify JWT", variant: "security" },
    { from: "api", to: "db", label: "SQL", variant: "emphasis" },
    { from: "api", to: "cache", label: "read-through" },
    { from: "api", to: "queue", label: "enqueue", variant: "dashed" },
    { from: "queue", to: "worker", label: "consume", variant: "dashed" },
    { from: "worker", to: "payments", label: "charge" },
    { from: "worker", to: "db", label: "update status" },
  ],
  cards: [
    { dot: "cyan", title: "Request path", items: ["Customer → web app → Orders API → PostgreSQL"] },
    { dot: "amber", title: "Async work", items: ["Fulfilment runs off the jobs queue"] },
  ],
};

export const WORKFLOW = {
  schema_version: 2,
  diagram_type: "workflow",
  meta: { title: "Checkout" },
  lanes: [
    { id: "customer", label: "Customer" },
    { id: "api", label: "Orders API" },
    { id: "failure", label: "Failure handling", variant: "exception" },
  ],
  phases: [
    { id: "intake", label: "Intake", fromCol: 0, toCol: 1 },
    { id: "settle", label: "Settlement", fromCol: 2, toCol: 4 },
  ],
  groups: [{ id: "checks", label: "Validation", lane: "api", fromCol: 1, toCol: 2 }],
  mainPath: ["submit", "validate", "reserve", "charge", "confirm"],
  nodes: [
    { id: "submit", lane: "customer", col: 0, type: "frontend", label: "Submit order" },
    { id: "validate", lane: "api", col: 1, type: "backend", label: "Validate cart", sublabel: "schema + stock" },
    { id: "reserve", lane: "api", col: 2, type: "database", label: "Reserve stock" },
    { id: "charge", lane: "api", col: 3, type: "external", label: "Charge card" },
    { id: "confirm", lane: "customer", col: 4, type: "frontend", label: "Order confirmed" },
    { id: "reject", lane: "failure", col: 1, type: "security", label: "Reject order" },
    { id: "refund", lane: "failure", col: 3, type: "external", label: "Release stock" },
  ],
  edges: [
    { from: "submit", to: "validate", label: "POST /orders", role: "main" },
    { from: "validate", to: "reserve", role: "main" },
    { from: "reserve", to: "charge", role: "main" },
    { from: "charge", to: "confirm", label: "paid", role: "main" },
    { from: "validate", to: "reject", label: "invalid", role: "error" },
    { from: "charge", to: "refund", label: "declined", role: "error" },
    { from: "refund", to: "submit", label: "notify", role: "return" },
  ],
  cards: [],
};

export const SEQUENCE = {
  schema_version: 1,
  diagram_type: "sequence",
  meta: { title: "POST /orders" },
  participants: [
    { id: "client", type: "frontend", label: "Web app" },
    { id: "api", type: "backend", label: "Orders API", sublabel: "Fastify", sources: [{ path: "api/src/server.ts", line: 12 }] },
    { id: "auth", type: "security", label: "Auth" },
    { id: "db", type: "database", label: "PostgreSQL" },
    { id: "queue", type: "messagebus", label: "Jobs queue" },
  ],
  messages: [
    { id: "post", from: "client", to: "api", label: "POST /orders", variant: "emphasis" },
    { from: "api", to: "auth", label: "verify JWT", variant: "security" },
    { from: "auth", to: "api", label: "claims", variant: "return" },
    { from: "api", to: "api", label: "validate body" },
    { from: "api", to: "db", label: "INSERT order" },
    { from: "db", to: "api", label: "order id", variant: "return" },
    { id: "enq", from: "api", to: "queue", label: "enqueue fulfilment", variant: "dashed" },
    { from: "api", to: "client", label: "201 Created", variant: "return", note: "Fulfilment continues asynchronously." },
  ],
  phases: [
    { label: "Authenticate", from: 1, to: 2 },
    { label: "Persist", from: 4, to: 6 },
  ],
  cards: [],
};

export const DATAFLOW = {
  schema_version: 1,
  diagram_type: "dataflow",
  meta: { title: "Order analytics" },
  stages: [{ label: "Sources" }, { label: "Ingest" }, { label: "Transform" }, { label: "Serve" }],
  nodes: [
    { id: "orders", type: "database", label: "Orders DB", stage: 0, row: 0 },
    { id: "events", type: "messagebus", label: "Click events", stage: 0, row: 1 },
    { id: "cdc", type: "backend", label: "CDC connector", stage: 1, row: 0 },
    { id: "stream", type: "messagebus", label: "Event stream", stage: 1, row: 1 },
    { id: "clean", type: "backend", label: "Clean + join", sublabel: "dbt models", stage: 2, row: 0 },
    { id: "pii", type: "security", label: "PII masking", stage: 2, row: 1 },
    { id: "wh", type: "database", label: "Warehouse", stage: 3, row: 0 },
    { id: "dash", type: "frontend", label: "Dashboards", stage: 3, row: 1 },
  ],
  flows: [
    { from: "orders", to: "cdc", label: "row changes" },
    { from: "events", to: "stream", label: "JSON events" },
    { from: "cdc", to: "clean", label: "changes" },
    { from: "stream", to: "pii", label: "raw events", classification: "PII", variant: "security" },
    { from: "pii", to: "clean", label: "masked" },
    { from: "clean", to: "wh", label: "tables", variant: "emphasis" },
    { from: "wh", to: "dash", label: "queries" },
  ],
  cards: [],
};

export const LIFECYCLE = {
  schema_version: 2,
  diagram_type: "lifecycle",
  meta: { title: "Order lifecycle" },
  lanes: [{ id: "main", label: "Happy path" }, { id: "exit", label: "Exits" }],
  states: [
    { id: "created", type: "start", label: "Created", lane: "main", col: 0 },
    { id: "paid", type: "active", label: "Paid", lane: "main", col: 1, step: "1" },
    { id: "review", type: "decision", label: "Fraud check", lane: "main", col: 2 },
    { id: "shipped", type: "waiting", label: "Shipped", lane: "main", col: 3 },
    { id: "delivered", type: "success", label: "Delivered", lane: "main", col: 4 },
    { id: "cancelled", type: "failure", label: "Cancelled", lane: "exit", col: 2 },
    { id: "refunded", type: "neutral", label: "Refunded", lane: "exit", col: 4 },
  ],
  transitions: [
    { from: "created", to: "paid", label: "payment ok" },
    { from: "paid", to: "review" },
    { from: "review", to: "shipped", label: "clear" },
    { from: "review", to: "cancelled", label: "flagged" },
    { from: "shipped", to: "delivered", label: "signed" },
    { from: "cancelled", to: "refunded", label: "refund" },
    { from: "shipped", to: "shipped", label: "tracking update" },
  ],
  cards: [],
};

export const SAMPLES = { ARCHITECTURE, WORKFLOW, SEQUENCE, DATAFLOW, LIFECYCLE };

/** The map from a real session: a multi-tenant SaaS API, its trust boundaries and five providers. */
export const API_SAAS = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: {
    title: "Arquitectura — api-saas",
    subtitle: "Backend SaaS multi-tenant para ópticas en Chile, en NestJS sobre Fastify y PostgreSQL. Recorrido principal: cliente, función Vercel, guards de JWT, perfil y suscripción, caso de uso y TypeORM.",
  },
  components: [
    { id: "spa", type: "frontend", label: "SPA cliente (externo)", sublabel: "CORS y Bearer; no está en este repo", sources: [{ path: "src/main.ts", line: 20 }] },
    { id: "vercel", type: "cloud", label: "Vercel Function", sublabel: "api/index.js → serverless", tag: "maxDuration 300 s", sources: [{ path: "api/index.js" }] },
    { id: "cron", type: "external", label: "Disparador de cron", sublabel: "Llama /internal/cron/*", sources: [{ path: "vercel.json" }] },
    { id: "nest", type: "backend", label: "API NestJS", sublabel: "Fastify · prefijo global", tag: "Helmet · pipes", sources: [{ path: "src/main.ts" }] },
    { id: "guards", type: "security", label: "Guards de acceso", sublabel: "JWT access · roles · suscripción", tag: "perfil por tenant", sources: [{ path: "src/auth/guards.ts" }] },
    { id: "modules", type: "backend", label: "Módulos de negocio", sublabel: "Casos de uso y servicios", tag: "src/modules/*", sources: [{ path: "src/modules/index.ts" }] },
    { id: "crypto", type: "security", label: "Cifrado de campos", sublabel: "AES-256-GCM · APP_ENCRYPTION_KEY", sources: [{ path: "src/crypto/field.ts" }] },
    { id: "pg", type: "database", label: "PostgreSQL", sublabel: "TypeORM · pooler de Supabase", tag: "statement 30 s", sources: [{ path: "src/db/data-source.ts" }] },
    { id: "resend", type: "external", label: "Resend", sublabel: "Correo transaccional" },
    { id: "wa", type: "external", label: "WhatsApp Cloud API", sublabel: "Meta Graph · avisos al paciente" },
    { id: "dte", type: "external", label: "SimpleAPI DTE", sublabel: "Boleta y factura electrónica" },
    { id: "storage", type: "external", label: "Supabase Storage", sublabel: "Imágenes con service key" },
    { id: "flow", type: "external", label: "Flow (flow.cl)", sublabel: "Cobro de suscripciones y pagos" },
  ],
  boundaries: [
    { kind: "region", label: "Aplicación NestJS (src/)", wraps: ["nest", "guards", "modules", "crypto"] },
    { kind: "security-group", label: "Frontera de tenant", wraps: ["guards", "modules"] },
    { kind: "region", label: "Proveedores externos", wraps: ["resend", "wa", "dte", "storage", "flow"] },
  ],
  connections: [
    { from: "spa", to: "vercel", label: "HTTPS /api/*", variant: "emphasis" },
    { from: "vercel", to: "nest", label: "request Fastify", variant: "emphasis" },
    { from: "cron", to: "nest", label: "POST /internal/cron", variant: "dashed" },
    { from: "nest", to: "guards", label: "Bearer JWT", variant: "security" },
    { from: "guards", to: "modules", label: "perfil y tenant", variant: "emphasis" },
    { from: "modules", to: "pg", label: "TypeORM", variant: "emphasis" },
    { from: "modules", to: "crypto", label: "cifra columnas", variant: "security" },
    { from: "crypto", to: "pg", label: "datos cifrados" },
    { from: "modules", to: "resend", label: "correos", variant: "dashed" },
    { from: "modules", to: "wa", label: "avisos WhatsApp", variant: "dashed" },
    { from: "modules", to: "dte", label: "emite DTE" },
    { from: "modules", to: "storage", label: "imágenes" },
    { from: "modules", to: "flow", label: "crea cobros" },
  ],
  cards: [
    { dot: "cyan", title: "Recorrido principal", items: ["SPA → Vercel → NestJS → guards → casos de uso → PostgreSQL"] },
    { dot: "rose", title: "Seguridad", items: ["JWT y roles en guards", "Columnas sensibles cifradas con AES-256-GCM"] },
  ],
};
