/**
 * Test data only: four worked architectures (a minimal service, an Azure AKS system, AWS serverless,
 * Google Cloud Run) that the layout, routing, simulation, rules and pattern tests run against. The
 * app offers none of them — a new document is an empty sheet, or one generated from a source
 * (the user's call, 2026-10-21). Neutral content throughout: none of it describes a real system.
 */
import { ARCH_FORMAT, type ArchDoc, type SimParams } from "./types";

export type ExampleId = "minimal" | "azureAks" | "awsServerless" | "gcpRun";
export const EXAMPLE_IDS: ExampleId[] = ["minimal", "azureAks", "awsServerless", "gcpRun"];

type Lang = "es" | "en";

export function exampleDoc(id: ExampleId, lang: Lang, today = "2026-10-21"): ArchDoc {
  const L = (es: string, en: string) => (lang === "es" ? es : en);
  const envs = { dev: L("Desarrollo", "Development"), qa: "QA", prd: L("Producción", "Production") };
  if (id === "minimal") {
    return {
      format: ARCH_FORMAT,
      meta: { title: L("Mi servicio", "My service"), version: "v0.1.0", date: today, environments: { dev: envs.dev, prd: envs.prd } },
      layout: [
        { column: ["user"], offset: 70 },
        { id: "cloud", title: L("Nube", "Cloud"), icon: "cloud", style: "cloud", direction: "row", children: ["api", "db"] },
      ],
      components: {
        user: { name: L("Usuario", "User"), type: L("Persona", "Person"), icon: "person", category: "actor", sim: { rps: 50 } },
        api: { name: "API", type: L("Contenedor · Node.js", "Container · Node.js"), icon: "container", badge: "logos:nodejs-icon", category: "compute", resource: "api-{env}", sim: { capacity: 200, latency: 20, replicas: 2 } },
        db: { name: L("Base de datos", "Database"), type: "PostgreSQL", icon: "database", badge: "logos:postgresql", category: "data", resource: "pg-{env}", sim: { capacity: 1000, latency: 5, managed: true } },
      },
      connections: [
        { from: "user", to: "api", protocol: "https", step: 1 },
        { from: "api", to: "db", protocol: "tcp", step: 2 },
      ],
      flow: [L("El usuario llama a la API.", "The user calls the API."), L("La API lee y escribe en la base.", "The API reads and writes the database.")],
    };
  }
  if (id === "awsServerless") {
    return {
      format: ARCH_FORMAT,
      meta: { title: L("Pedidos", "Orders"), description: L("API de pedidos sin servidores: la escritura confirma rápido y el procesamiento va por cola.", "Serverless orders API: writes acknowledge fast and processing goes through a queue."), version: "v0.1.0", date: today, environments: envs },
      layout: [
        { column: ["customer"], offset: 220 },
        { id: "aws", title: "AWS", icon: "aws:group-aws-cloud-logo", style: "cloud", children: [
          { row: [
            { column: ["cdn"], offset: 40 },
            { id: "region", title: "us-east-1", subtitle: L("Región", "Region"), icon: "aws:group-region", style: "cluster", children: [
              { id: "edge", title: L("Entrada", "Entry"), style: "tier", direction: "row", children: ["apigw", "auth"] },
              { id: "compute", title: L("Cómputo", "Compute"), style: "tier", direction: "row", children: ["orders_fn", "worker_fn"] },
              { id: "datatier", title: L("Datos", "Data"), style: "tier", direction: "row", children: ["table", "queue"] },
            ] },
          ] },
        ] },
        { column: ["payments"], offset: 420 },
      ],
      components: {
        customer: { name: L("Cliente", "Customer"), type: L("Persona", "Person"), icon: "person", category: "actor", sim: { rps: 150 } },
        cdn: { name: "CloudFront", type: "CDN + AWS WAF", icon: "aws:cloudfront", badge: "aws:waf", category: "network", description: L("Reglas administradas y rate limit", "Managed rules and rate limiting"), sim: { capacity: 20000, latency: 10, managed: true } },
        apigw: { name: "API Gateway", type: "REST API", icon: "aws:api-gateway", category: "network", resource: "orders-api-{env}", sim: { capacity: 10000, latency: 6, managed: true } },
        auth: { name: "Cognito", type: L("Identidad", "Identity"), icon: "aws:cognito", category: "identity", description: L("Inicio de sesión y tokens", "Sign-in and tokens"), sim: { managed: true } },
        orders_fn: { name: L("Crear pedido", "Create order"), type: "Lambda · Node.js", icon: "aws:lambda", badge: "logos:nodejs-icon", category: "compute", resource: "orders-create-{env}", description: L("Valida, guarda y encola", "Validates, stores and enqueues"), sim: { capacity: 400, latency: 40, managed: true } },
        worker_fn: { name: L("Procesar pedido", "Process order"), type: "Lambda · Python", icon: "aws:lambda", badge: "logos:python", category: "compute", resource: "orders-worker-{env}", description: L("Cobra y notifica", "Charges and notifies"), sim: { capacity: 80, latency: 300, managed: true } },
        table: { name: L("Pedidos", "Orders"), type: "DynamoDB", icon: "aws:dynamodb", category: "data", resource: "orders-{env}", sim: { capacity: 4000, latency: 6, managed: true } },
        queue: { name: L("pedidos-nuevos", "orders-new"), type: "SQS", icon: "aws:simple-queue-service", category: "messaging", description: L("Con cola de mensajes muertos tras 5 intentos", "Dead-letter queue after 5 attempts"), sim: { capacity: 3000, latency: 3, managed: true } },
        payments: { name: L("Pasarela de pago", "Payment gateway"), type: L("Externo", "External"), icon: "external", category: "external", sim: { capacity: 100, latency: 400 } },
      },
      connections: [
        { from: "customer", to: "cdn", protocol: "https", step: 1 },
        { from: "cdn", to: "apigw", protocol: "https" },
        { from: "apigw", to: "auth", protocol: "https", share: 0.1 },
        { from: "apigw", to: "orders_fn", protocol: "https", step: 2, share: 0.9 },
        { from: "orders_fn", to: "table", protocol: "https", step: 3 },
        { from: "orders_fn", to: "queue", protocol: "https", kind: "async", step: 4 },
        { from: "queue", to: "worker_fn", protocol: "sqs", kind: "async", step: 5 },
        { from: "worker_fn", to: "payments", protocol: "https", step: 6 },
        { from: "worker_fn", to: "table", protocol: "https", share: 1 },
      ],
      flow: [
        L("El cliente crea un pedido a través de CloudFront.", "The customer places an order through CloudFront."),
        L("API Gateway valida el token y llama a la función.", "API Gateway checks the token and calls the function."),
        L("El pedido se guarda como pendiente.", "The order is stored as pending."),
        L("La función encola el pedido y responde de inmediato.", "The function enqueues the order and answers at once."),
        L("El worker toma el pedido a su ritmo.", "The worker takes the order at its own pace."),
        L("Cobra en la pasarela y marca el pedido como pagado.", "It charges through the gateway and marks the order paid."),
      ],
    };
  }
  if (id === "gcpRun") {
    return {
      format: ARCH_FORMAT,
      meta: { title: L("Catálogo", "Catalog"), description: L("Servicio de catálogo en Cloud Run con caché y eventos.", "A catalog service on Cloud Run with a cache and events."), version: "v0.1.0", date: today, environments: envs },
      layout: [
        { column: ["shopper"], offset: 150 },
        { id: "gcp", title: "Google Cloud", icon: "logos:google-cloud", style: "cloud", children: [
          { row: ["lb", { id: "run", title: "Cloud Run", style: "cluster", icon: "gcp:cloud-run", direction: "row", children: ["catalog", "indexer"] }] },
          { row: ["sql", "cache", "topic"] },
        ] },
      ],
      components: {
        shopper: { name: L("Comprador", "Shopper"), type: L("Persona", "Person"), icon: "person", category: "actor", sim: { rps: 300 } },
        lb: { name: "Cloud Load Balancing", type: L("Balanceador global + Cloud Armor", "Global load balancer + Cloud Armor"), icon: "gcp:cloud-load-balancing", category: "network", description: "WAF · TLS", sim: { managed: true } },
        catalog: { name: L("API de catálogo", "Catalog API"), type: "Cloud Run · Go", icon: "gcp:cloud-run", badge: "logos:go", category: "compute", resource: "catalog-{env}", sim: { capacity: 250, latency: 15, replicas: 3 } },
        indexer: { name: L("Indexador", "Indexer"), type: "Cloud Run job", icon: "gcp:cloud-run", category: "compute", resource: "indexer-{env}", sim: { capacity: 50, latency: 200 } },
        sql: { name: L("Productos", "Products"), type: "Cloud SQL · PostgreSQL", icon: "gcp:cloud-sql", category: "data", sim: { capacity: 1500, latency: 6, managed: true } },
        cache: { name: L("Caché", "Cache"), type: "Memorystore · Redis", icon: "gcp:memorystore", category: "data", sim: { capacity: 20000, latency: 1, managed: true } },
        topic: { name: L("productos-cambiados", "product-changed"), type: "Pub/Sub", icon: "gcp:pubsub", category: "messaging", sim: { capacity: 10000, latency: 5, managed: true } },
      },
      connections: [
        { from: "shopper", to: "lb", protocol: "https", step: 1 },
        { from: "lb", to: "catalog", protocol: "https", step: 2 },
        { from: "catalog", to: "cache", protocol: "resp", step: 3 },
        { from: "catalog", to: "sql", protocol: "tcp", step: 4, share: 0.2 },
        { from: "catalog", to: "topic", protocol: "grpc", kind: "async", share: 0.05 },
        { from: "topic", to: "indexer", protocol: "grpc", kind: "async" },
      ],
      flow: [
        L("El comprador abre el catálogo.", "The shopper opens the catalog."),
        L("El balanceador enruta a la API más cercana.", "The load balancer routes to the nearest API."),
        L("La API responde desde la caché cuando puede.", "The API answers from the cache when it can."),
        L("Si no está en caché, lee la base y la guarda.", "On a miss it reads the database and caches it."),
      ],
    };
  }
  // azureAks: the shape of the reference diagram, with neutral content.
  const k8s = (name: string, stack: "React" | "NestJS", resource: string, description: string, sim: SimParams) => ({
    name, type: `${L("Workload Kubernetes", "Kubernetes workload")} · ${stack}`, icon: "container", badge: stack === "React" ? "logos:react" : "logos:nestjs", category: "compute" as const, resource, description, sim,
  });
  return {
    format: ARCH_FORMAT,
    meta: {
      title: L("Reservas", "Bookings"),
      description: L("Reserva de espacios: autoservicio público y gestión interna de agendas y reglas, con las reservas en el sistema heredado.", "Space booking: public self-service and internal management of schedules and rules, with the bookings kept in the legacy system."),
      version: "v0.1.0", date: today, owner: L("Equipo Plataforma", "Platform team"), environments: envs,
    },
    layout: [
      { column: ["staff", "client"], offset: 330, gap: 110 },
      { id: "azure", title: "Azure", icon: "azure:azure-a", style: "cloud", children: [
        { id: "identity", title: L("Identidad", "Identity"), style: "logical", align: "center", children: ["entra"] },
        { id: "rg", title: "rg-{env}-bookings", subtitle: "Resource group", icon: "azure:resource-groups", style: "group", children: [
          { row: [
            { column: ["front_door"], offset: 30 },
            { id: "aks", title: "aks-{env}-bookings", subtitle: "Kubernetes Service", icon: "azure:kubernetes-services", style: "cluster", align: "center", children: [
              "agc",
              { id: "ns", title: "bookings", subtitle: "Namespace", icon: "namespace", style: "cluster", children: [
                { id: "frontend", title: "Frontend", style: "tier", direction: "row", children: ["web_admin", "web_public"] },
                { id: "bff", title: "BFF", style: "tier", direction: "row", children: ["bff_admin", "bff_public"] },
                { id: "core", title: "Core", style: "tier", align: "center", children: ["core_bookings", { row: ["core_rules", "core_integration"] }] },
              ] },
            ] },
          ] },
          { row: [
            { column: ["func_etl"], offset: 40 },
            { id: "sql", title: "sql-{env}-bookings", subtitle: "SQL Server", icon: "azure:sql-server", style: "cluster", children: [
              { id: "pool", title: "sqlep-{env}-bookings", subtitle: "Elastic pool", icon: "azure:sql-elastic-pools", style: "cluster", children: ["db_catalog", "db_bookings", "db_rules"] },
            ] },
            { column: [{ id: "sb", title: "sb-{env}-bookings", subtitle: "Service Bus", icon: "azure:azure-service-bus", style: "cluster", children: ["queue_out", "queue_results"] }, "redis"], gap: 40 },
          ] },
        ] },
      ] },
      { column: [{ id: "external", title: L("Servicios externos", "External services"), icon: "globe", style: "providers", children: ["sms", "recaptcha"] }, "legacy"], offset: 560, gap: 380 },
    ],
    components: {
      staff: { name: L("Funcionario", "Staff"), type: L("Persona", "Person"), icon: "person", category: "actor", description: L("Gestiona agendas, reservas y reglas", "Manages schedules, bookings and rules"), sim: { rps: 15 } },
      client: { name: L("Cliente", "Client"), type: L("Persona", "Person"), icon: "person", category: "actor", description: L("Reserva en la web pública y recibe avisos", "Books on the public web and gets notices"), sim: { rps: 120 } },
      entra: { name: "Entra ID", type: "Microsoft Entra ID", icon: "azure:entra-id-protection", category: "identity", description: L("Inicio de sesión y roles de app", "Sign-in and app roles"), sim: { capacity: 3000, latency: 45, managed: true } },
      front_door: { name: "Front Door", type: "Azure Front Door", icon: "azure:front-door-and-cdn-profiles", category: "network", resource: "afd-{env}-bookings", description: L("Premium con WAF; una URL para webs y BFF", "Premium with WAF; one URL for webs and BFFs"), sim: { capacity: 10000, latency: 8, managed: true } },
      agc: { name: "App Gateway for Containers", type: "Application Gateway", icon: "azure:application-gateway-containers", category: "network", resource: "agw-{env}-bookings-agc", description: L("Ingress (Gateway API): rutas a webs y BFF", "Ingress (Gateway API): routes to webs and BFFs"), sim: { capacity: 3000, latency: 3, replicas: 2 } },
      web_admin: k8s("Web Admin", "React", "web-admin", L("Agendas, mantenedores y reglas (/admin)", "Schedules, settings and rules (/admin)"), { capacity: 300, latency: 4 }),
      web_public: k8s(L("Web Reservas", "Booking web"), "React", "web-public", L("Autoservicio (ruta /, nginx)", "Self-service (route /, nginx)"), { capacity: 300, latency: 4, replicas: 2 }),
      bff_admin: k8s("Admin BFF", "NestJS", "bff-admin", L("API de la web interna (/api/admin) y roles de app", "Internal web API (/api/admin) and app roles"), { capacity: 120, latency: 18 }),
      bff_public: k8s("Public BFF", "NestJS", "bff-public", L("API de la web pública (/api/public)", "Public web API (/api/public)"), { capacity: 100, latency: 22, replicas: 2 }),
      core_bookings: k8s("Bookings Core", "NestJS", "core-bookings", L("Disponibilidad, reservas y catálogo; orquesta reglas e integración", "Availability, bookings and catalog; orchestrates rules and integration"), { capacity: 90, latency: 35, replicas: 2 }),
      core_rules: k8s("Rules Core", "NestJS", "core-rules", L("Motor de reglas: evalúa decisiones versionadas", "Rules engine: evaluates versioned decisions"), { capacity: 200, latency: 10, replicas: 2 }),
      core_integration: k8s("Integration Core", "NestJS", "core-integration", L("Sistema heredado: datos del cliente y alta o anulación de reservas", "Legacy system: customer data and creating or cancelling bookings"), { capacity: 60, latency: 25 }),
      db_catalog: { name: L("Catálogo DB", "Catalog DB"), type: "SQL Database", icon: "azure:sql-database", category: "data", resource: "sqldb-{env}-bookings-catalog", description: L("Recursos, ofertas, horarios y calendario", "Resources, offers, hours and calendar"), sim: { capacity: 800, latency: 5, managed: true } },
      db_bookings: { name: L("Reservas DB", "Bookings DB"), type: "SQL Database", icon: "azure:sql-database", category: "data", resource: "sqldb-{env}-bookings", description: L("Reservas, historial y outbox hacia el sistema heredado", "Bookings, history and the outbox to the legacy system"), sim: { capacity: 800, latency: 5, managed: true } },
      db_rules: { name: L("Reglas DB", "Rules DB"), type: "SQL Database", icon: "azure:sql-database", category: "data", resource: "sqldb-{env}-bookings-rules", description: L("Decisiones versionadas y auditoría", "Versioned decisions and audit"), sim: { capacity: 800, latency: 5, managed: true } },
      redis: { name: L("Caché de reservas", "Bookings cache"), type: "Managed Redis", icon: "azure:azure-managed-redis", category: "data", resource: "amr-{env}-bookings", description: L("Disponibilidad, retención de cupos e idempotencia", "Availability, slot holds and idempotency"), sim: { capacity: 8000, latency: 1, managed: true } },
      queue_out: { name: L("reservas-salida", "bookings-out"), type: L("Cola de Service Bus", "Service Bus queue"), icon: "queue", category: "messaging", description: L("Reservas por crear o anular", "Bookings to create or cancel"), sim: { capacity: 2000, latency: 3, managed: true } },
      queue_results: { name: L("reservas-resultado", "bookings-result"), type: L("Cola de Service Bus", "Service Bus queue"), icon: "queue", category: "messaging", description: L("Respuesta del sistema heredado por reserva", "The legacy system's answer per booking"), sim: { capacity: 2000, latency: 3, managed: true } },
      func_etl: { name: L("Catálogo ETL", "Catalog ETL"), type: "Function App", icon: "azure:function-apps", category: "compute", resource: "func-{env}-bookings-etl", description: L("Trae sedes, prestaciones y profesionales", "Brings in sites, services and practitioners"), sim: { rps: 1, capacity: 20, latency: 400 } },
      sms: { name: "SMS / WhatsApp", type: L("Proveedor de mensajería", "Messaging provider"), icon: "chat", badge: "logos:whatsapp-icon", category: "external", sim: { capacity: 300, latency: 250 } },
      recaptcha: { name: "reCAPTCHA", type: "Google", icon: "captcha", badge: "logos:google-icon", category: "external", sim: { capacity: 5000, latency: 60 } },
      legacy: { name: L("Sistema heredado", "Legacy system"), type: L("ERP heredado (externo)", "Legacy ERP (external)"), icon: "external", category: "external", description: L("Clientes y reservas", "Customers and bookings"), sim: { capacity: 80, latency: 180 } },
    },
    connections: [
      { from: "client", to: "front_door", protocol: "https", step: 1 },
      { from: "staff", to: "front_door", protocol: "https" },
      { from: "front_door", to: "agc", protocol: "https" },
      { from: "agc", to: "web_admin", protocol: "http", share: 0.05 },
      { from: "agc", to: "web_public", protocol: "http", share: 0.4 },
      { from: "agc", to: "bff_admin", protocol: "http", share: 0.1 },
      { from: "agc", to: "bff_public", protocol: "http", share: 0.45 },
      { from: "web_admin", to: "entra", protocol: "https", share: 0.1 },
      { from: "bff_admin", to: "entra", protocol: "https", share: 0.2 },
      { from: "web_public", to: "recaptcha", protocol: "https", step: 2, share: 0.3 },
      { from: "bff_public", to: "recaptcha", protocol: "https", step: 3, share: 0.3 },
      { from: "bff_public", to: "core_bookings", protocol: "http:internal", step: 4 },
      { from: "bff_admin", to: "core_bookings", protocol: "http:internal", share: 0.6 },
      { from: "bff_admin", to: "core_rules", protocol: "http:internal", share: 0.4 },
      { from: "core_bookings", to: "core_integration", protocol: "http:internal", step: 5, share: 0.3 },
      { from: "core_bookings", to: "core_rules", protocol: "http:internal", step: 6, share: 0.5 },
      { from: "core_bookings", to: "db_bookings", protocol: "tds", step: 7, share: 0.6 },
      { from: "core_bookings", to: "db_catalog", protocol: "tds", share: 0.8 },
      { from: "core_rules", to: "db_rules", protocol: "tds", share: 0.5 },
      { from: "core_bookings", to: "redis", protocol: "resp" },
      { from: "core_bookings", to: "queue_out", protocol: "amqp", kind: "async", step: 8, share: 0.2 },
      { from: "queue_out", to: "core_integration", protocol: "amqp", kind: "async" },
      { from: "core_integration", to: "legacy", protocol: "https", step: 9, share: 0.8 },
      { from: "core_integration", to: "queue_results", protocol: "amqp", kind: "async", step: 10, share: 0.4 },
      { from: "queue_results", to: "core_bookings", protocol: "amqp", kind: "async" },
      { from: "core_bookings", to: "sms", protocol: "https", step: 11, share: 0.2 },
      { from: "sms", to: "client", protocol: "sms / whatsapp" },
      { from: "func_etl", to: "legacy", protocol: "https" },
      { from: "func_etl", to: "db_catalog", protocol: "tds" },
    ],
    flow: [
      L("El cliente abre la web pública (Front Door y App Gateway) y busca un horario.", "The client opens the public web (Front Door and App Gateway) and looks for a slot."),
      L("La web obtiene un token de reCAPTCHA.", "The web gets a reCAPTCHA token."),
      L("El Public BFF valida el token y aplica rate limit.", "The Public BFF checks the token and applies a rate limit."),
      L("El Public BFF pide disponibilidad y reserva el horario en Bookings Core.", "The Public BFF asks for availability and books the slot in Bookings Core."),
      L("Bookings Core trae los datos del cliente desde el sistema heredado por Integration Core.", "Bookings Core fetches the customer's data from the legacy system through Integration Core."),
      L("Rules Core evalúa elegibilidad y restricciones con esos datos.", "Rules Core evaluates eligibility and restrictions with that data."),
      L("Bookings Core crea la reserva (pendiente) y su evento en el outbox, en una transacción.", "Bookings Core creates the booking (pending) and its outbox event in one transaction."),
      L("El outbox se publica en la cola de salida.", "The outbox is published to the outgoing queue."),
      L("Integration Core crea la reserva en el sistema heredado.", "Integration Core creates the booking in the legacy system."),
      L("El resultado vuelve por la cola de resultados y Bookings Core marca la reserva confirmada o rechazada.", "The result comes back through the results queue and Bookings Core marks the booking confirmed or rejected."),
      L("El cliente recibe el aviso por SMS o WhatsApp.", "The client gets the notice by SMS or WhatsApp."),
    ],
    notes: [
      { id: "N1", on: "front_door", title: L("Una URL para todo", "One URL for everything"), text: L("Rutas: / web pública, /admin web interna, /api/public y /api/admin a los BFF. Mismo origen, sin CORS. WAF con rate limit en /api/public.", "Routes: / public web, /admin internal web, /api/public and /api/admin to the BFFs. Same origin, no CORS. WAF with a rate limit on /api/public.") },
      { id: "N2", on: "aks", title: L("Plataforma del clúster", "Cluster platform"), text: L("Cada workload usa Workload Identity; imágenes en ACR, secretos en Key Vault y telemetría en Application Insights.", "Every workload uses Workload Identity; images in ACR, secrets in Key Vault and telemetry in Application Insights.") },
      { id: "N3", on: "pool", title: L("Tres bases sin FK entre ellas", "Three databases with no FKs between them"), text: L("Las referencias entre bases son lógicas y las valida el core dueño de cada una.", "References across databases are logical and the owning core validates them.") },
      { id: "N4", on: "core_integration", title: L("Riesgo: escritura en el sistema heredado", "Risk: writing to the legacy system"), text: L("Confirmar qué API admite crear y anular reservas, y si avisa los cambios hechos allá.", "Confirm which API can create and cancel bookings, and whether it reports changes made there.") },
    ],
    decisions: [
      {
        id: "ADR-001", title: L("Un BFF por cada web", "One BFF per web"), status: "accepted", date: today, confidence: 85,
        affects: ["bff_admin", "bff_public", "web_admin", "web_public"],
        context: L("La web pública y la interna tienen usuarios, permisos y ritmos de cambio distintos.", "The public and internal webs have different users, permissions and pace of change."),
        criteria: [{ id: "sec", name: L("Seguridad", "Security"), weight: 5 }, { id: "evo", name: L("Mantenibilidad", "Maintainability"), weight: 4 }, { id: "cost", name: L("Costo", "Cost"), weight: 2 }],
        options: [
          { name: L("Una API para las dos webs", "One API for both webs"), scores: { sec: 2, evo: 2, cost: 5 }, pros: [L("Un solo despliegue", "One deployment")], cons: [L("Roles mezclados en una API", "Roles mixed in one API")] },
          { name: L("Un BFF por web", "One BFF per web"), recommended: true, scores: { sec: 5, evo: 4, cost: 3 }, pros: [L("Superficie pública mínima", "Minimal public surface")], cons: [L("Dos servicios más que operar", "Two more services to run")] },
        ],
        consequences: L("La lógica de negocio vive en los cores; los BFF solo adaptan y autorizan.", "Business logic lives in the cores; the BFFs only adapt and authorise."),
      },
      {
        id: "ADR-002", title: L("Escribir en el sistema heredado por cola, no en línea", "Write to the legacy system through a queue, not inline"), status: "accepted", date: today, confidence: 70,
        affects: ["core_bookings", "db_bookings", "queue_out", "queue_results", "core_integration"],
        context: L("El sistema heredado responde lento y a veces no está; una reserva no debería fallar por eso.", "The legacy system is slow and sometimes down; a booking should not fail because of it."),
        criteria: [{ id: "avail", name: L("Disponibilidad", "Availability"), weight: 5 }, { id: "cons", name: L("Consistencia", "Consistency"), weight: 3 }, { id: "simple", name: L("Simplicidad", "Simplicity"), weight: 2 }, { id: "ttm", name: "Time to market", weight: 3 }],
        options: [
          { name: L("Llamada síncrona", "Synchronous call"), scores: { avail: 1, cons: 5, simple: 5, ttm: 5 }, pros: [L("Confirmación inmediata", "Immediate confirmation")], cons: [L("Si el sistema heredado cae, cae la reserva", "If the legacy system is down, so is booking")] },
          { name: L("Outbox + colas", "Outbox + queues"), recommended: true, scores: { avail: 5, cons: 4, simple: 3, ttm: 3 }, pros: [L("La reserva no depende del sistema heredado", "Booking does not depend on the legacy system")], cons: [L("La reserva queda pendiente unos segundos", "The booking stays pending for a few seconds")] },
          { name: L("CDC desde la base", "CDC from the database"), scores: { avail: 5, cons: 4, simple: 2, ttm: 2 }, pros: [L("Sin código de publicación", "No publishing code")], cons: [L("Infraestructura nueva", "New infrastructure")] },
        ],
        consequences: L("Las reservas pasan por pendiente → confirmada o rechazada.", "Bookings go pending → confirmed or rejected."),
        revisitIf: L("El sistema heredado ofrece avisos de cambios o una API con SLA.", "The legacy system offers change notifications or an API with an SLA."),
      },
    ],
    risks: [
      { id: "R1", title: L("La API del sistema heredado no permite anular reservas", "The legacy system's API cannot cancel bookings"), impact: 5, probability: 3, mitigation: L("Confirmarlo con el proveedor antes de construir Integration Core.", "Confirm with the vendor before building Integration Core."), affects: ["core_integration", "legacy"] },
      { id: "R2", title: L("Integration Core se satura en campañas", "Integration Core saturates during campaigns"), impact: 4, probability: 3, mitigation: L("Dos réplicas y caché de datos del cliente (ver Simular).", "Two replicas and a customer-data cache (see Simulate)."), affects: ["core_integration"] },
    ],
  };
}
