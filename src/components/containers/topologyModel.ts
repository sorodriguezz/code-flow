/**
 * The pure half of the topology pages: where each node of a graph goes, which column a Kubernetes
 * kind or an Azure type stands in, and what an Azure type is called. No React here — the canvas
 * (`TopologyCanvas`) only draws what this decides, and vitest checks it.
 */

export interface LayoutInput {
  id: string;
  /** The column, left to right. */
  layer: number;
  /** The horizontal band it lives in (a namespace, a resource group); bands stack top to bottom. */
  band: string;
}

export interface Placed {
  x: number;
  y: number;
}

export const NODE_W = 210;
export const NODE_H = 54;
const COL_GAP = 90;
const ROW_GAP = 14;
const BAND_GAP = 56;
/** Room for a band's title above its first row. */
export const BAND_HEAD = 26;

export interface Band {
  id: string;
  y: number;
  height: number;
  width: number;
}

/**
 * Columns by layer, bands one under the other, and inside a column the order that keeps edges short:
 * each node sits at the mean row of what it is linked to in the column before (a barycentre pass,
 * then one back from the right) — enough for graphs of a namespace or a resource group.
 */
export function layeredLayout(nodes: LayoutInput[], edges: { from: string; to: string }[]): { positions: Map<string, Placed>; bands: Band[] } {
  const positions = new Map<string, Placed>();
  const bands: Band[] = [];
  const neighbours = new Map<string, string[]>();
  for (const e of edges) {
    neighbours.set(e.from, [...(neighbours.get(e.from) ?? []), e.to]);
    neighbours.set(e.to, [...(neighbours.get(e.to) ?? []), e.from]);
  }
  const bandIds = [...new Set(nodes.map((n) => n.band))].sort((a, b) => a.localeCompare(b));
  const layers = [...new Set(nodes.map((n) => n.layer))].sort((a, b) => a - b);
  let top = 0;
  for (const band of bandIds) {
    const inBand = nodes.filter((n) => n.band === band);
    const columns = layers.map((layer) => inBand.filter((n) => n.layer === layer).map((n) => n.id).sort((a, b) => a.localeCompare(b)));
    const rowOf = new Map<string, number>();
    const settle = (column: string[]) => column.forEach((id, i) => rowOf.set(id, i));
    columns.forEach(settle);
    const order = (column: string[]) => {
      const weight = (id: string) => {
        const rows = (neighbours.get(id) ?? []).map((n) => rowOf.get(n)).filter((r): r is number => r !== undefined);
        return rows.length ? rows.reduce((a, b) => a + b, 0) / rows.length : (rowOf.get(id) ?? 0);
      };
      const sorted = [...column].sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
      settle(sorted);
      return sorted;
    };
    for (let i = 1; i < columns.length; i++) columns[i] = order(columns[i]);
    for (let i = columns.length - 2; i >= 0; i--) columns[i] = order(columns[i]);
    const tallest = Math.max(1, ...columns.map((c) => c.length));
    const used = columns.filter((c) => c.length > 0);
    let x = 0;
    for (const column of columns) {
      if (column.length === 0) continue;
      // A short column is centred against the tallest, so a lone ingress faces its services.
      const offset = ((tallest - column.length) * (NODE_H + ROW_GAP)) / 2;
      column.forEach((id, row) => positions.set(id, { x, y: top + BAND_HEAD + offset + row * (NODE_H + ROW_GAP) }));
      x += NODE_W + COL_GAP;
    }
    const height = BAND_HEAD + tallest * (NODE_H + ROW_GAP);
    bands.push({ id: band, y: top, height, width: Math.max(NODE_W, used.length * (NODE_W + COL_GAP) - COL_GAP) });
    top += height + BAND_GAP;
  }
  return { positions, bands };
}

// ------------------------------------------------------------------------------- Kubernetes

/** Left to right: what comes in, what routes, what runs, what it uses, and its pods last — a pod
 *  between a workload and its ConfigMaps would sit on the lines that are not its own. */
export function kubeLayer(kind: string): number {
  switch (kind) {
    case "ingresses":
      return 0;
    case "services":
    case "horizontalpodautoscalers":
      return 1;
    case "configmaps":
    case "secrets":
    case "persistentvolumeclaims":
      return 3;
    case "pods":
      return 4;
    default:
      return 2;
  }
}

/** The kinds a topology node can open the panel's own detail for. */
export const KUBE_DETAIL_KINDS = new Set(["pods", "deployments", "statefulsets", "daemonsets", "jobs", "cronjobs", "services", "ingresses", "configmaps", "secrets", "persistentvolumeclaims"]);

// ------------------------------------------------------------------------------------ Azure

/** What a type is called, as the portal says it. `flavor` tells a Function App from a web app. */
export function azureTypeLabel(type: string, flavor = ""): string {
  const lower = type.toLowerCase();
  if (lower === "microsoft.web/sites") {
    const f = flavor.toLowerCase();
    if (f.includes("functionapp")) return "Function App";
    if (f.includes("workflowapp")) return "Logic App (Standard)";
    return "App Service";
  }
  const known: Record<string, string> = {
    "microsoft.web/serverfarms": "App Service plan",
    "microsoft.web/staticsites": "Static Web App",
    "microsoft.web/sites/slots": "Deployment slot",
    "microsoft.app/containerapps": "Container App",
    "microsoft.app/managedenvironments": "Container Apps environment",
    "microsoft.app/jobs": "Container Apps job",
    "microsoft.containerinstance/containergroups": "Container Instances",
    "microsoft.containerservice/managedclusters": "AKS",
    "microsoft.containerregistry/registries": "Container Registry",
    "microsoft.compute/virtualmachines": "Virtual machine",
    "microsoft.compute/virtualmachinescalesets": "VM scale set",
    "microsoft.compute/disks": "Disk",
    "microsoft.sql/servers": "SQL server",
    "microsoft.sql/servers/databases": "SQL database",
    "microsoft.dbforpostgresql/flexibleservers": "PostgreSQL",
    "microsoft.dbformysql/flexibleservers": "MySQL",
    "microsoft.documentdb/databaseaccounts": "Cosmos DB",
    "microsoft.cache/redis": "Redis",
    "microsoft.storage/storageaccounts": "Storage account",
    "microsoft.keyvault/vaults": "Key Vault",
    "microsoft.servicebus/namespaces": "Service Bus",
    "microsoft.eventhub/namespaces": "Event Hubs",
    "microsoft.eventgrid/topics": "Event Grid topic",
    "microsoft.eventgrid/systemtopics": "Event Grid system topic",
    "microsoft.apimanagement/service": "API Management",
    "microsoft.network/applicationgateways": "Application Gateway",
    "microsoft.network/frontdoors": "Front Door (classic)",
    "microsoft.cdn/profiles": "Front Door / CDN",
    "microsoft.network/virtualnetworks": "Virtual network",
    "microsoft.network/privateendpoints": "Private endpoint",
    "microsoft.network/privatednszones": "Private DNS zone",
    "microsoft.network/networksecuritygroups": "Network security group",
    "microsoft.network/networkinterfaces": "Network interface",
    "microsoft.network/publicipaddresses": "Public IP",
    "microsoft.network/loadbalancers": "Load balancer",
    "microsoft.network/dnszones": "DNS zone",
    "microsoft.insights/components": "Application Insights",
    "microsoft.operationalinsights/workspaces": "Log Analytics",
    "microsoft.insights/actiongroups": "Action group",
    "microsoft.insights/metricalerts": "Metric alert",
    "microsoft.managedidentity/userassignedidentities": "Managed identity",
    "microsoft.logic/workflows": "Logic App",
    "microsoft.signalrservice/signalr": "SignalR",
    "microsoft.search/searchservices": "AI Search",
    "microsoft.cognitiveservices/accounts": "AI services",
  };
  return known[lower] ?? type.split("/").pop() ?? type;
}

/** Left to right: entry, compute, where it is hosted, data and secrets, network, monitoring. */
export function azureLayer(type: string): number {
  const lower = type.toLowerCase();
  if (/frontdoor|cdn\/profiles|applicationgateways|apimanagement|trafficmanager|publicipaddresses|dnszones$|loadbalancers/.test(lower)) return 0;
  if (/web\/sites|containerapps|app\/jobs|containergroups|managedclusters|virtualmachines|staticsites|logic\/workflows/.test(lower)) return 1;
  if (/serverfarms|managedenvironments|containerregistry|userassignedidentities/.test(lower)) return 2;
  if (/sql|postgres|mysql|documentdb|cache\/redis|storageaccounts|keyvault|servicebus|eventhub|eventgrid|search|cognitive|signalr|disks/.test(lower)) return 3;
  if (/network\//.test(lower)) return 4;
  if (/insights|operationalinsights|alerts|actiongroups/.test(lower)) return 5;
  return 2;
}

export type Tone = "ok" | "warn" | "bad" | "idle";

/** Resource Health first; the provisioning state when Azure has no health for it. */
export function azureTone(health: string | undefined, provisioning: string): Tone {
  switch (health) {
    case "Available":
      return "ok";
    case "Degraded":
      return "warn";
    case "Unavailable":
      return "bad";
  }
  const p = provisioning.toLowerCase();
  if (p === "failed") return "bad";
  if (p && p !== "succeeded") return "warn";
  return "idle";
}

/** Short ids for the screen: the resource's own name, then where it lives. */
export function azureIdName(id: string): string {
  const parts = id.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? id;
}

/** Whether a resource has logs of its own the panel can follow (see `azure::log_source`). */
export function azureLogKind(type: string): "stream" | "cluster" | null {
  const lower = type.toLowerCase();
  if (lower === "microsoft.web/sites" || lower === "microsoft.web/sites/slots" || lower === "microsoft.app/containerapps" || lower === "microsoft.containerinstance/containergroups") return "stream";
  if (lower === "microsoft.containerservice/managedclusters") return "cluster";
  return null;
}

/** Queries worth having one click away — the tables each service writes when it sends its logs to a
 *  workspace. Labels are translation keys. */
export const KQL_PRESETS: { label: string; query: string }[] = [
  { label: "azure.query.preset.exceptions", query: "AppExceptions\n| project TimeGenerated, AppRoleName, ProblemId, OuterMessage\n| order by TimeGenerated desc\n| take 100" },
  { label: "azure.query.preset.failedRequests", query: "AppRequests\n| where Success == false\n| summarize Count = count() by Name, ResultCode, AppRoleName\n| order by Count desc" },
  { label: "azure.query.preset.containerApps", query: "ContainerAppConsoleLogs_CL\n| project TimeGenerated, ContainerAppName_s, Log_s\n| order by TimeGenerated desc\n| take 200" },
  { label: "azure.query.preset.appService", query: "AppServiceConsoleLogs\n| project TimeGenerated, _ResourceId, ResultDescription\n| order by TimeGenerated desc\n| take 200" },
  { label: "azure.query.preset.aksPods", query: "KubePodInventory\n| where PodStatus !in (\"Running\", \"Succeeded\")\n| summarize arg_max(TimeGenerated, *) by Name\n| project TimeGenerated, Namespace, Name, PodStatus, ContainerStatusReason" },
  { label: "azure.query.preset.aksLogs", query: "ContainerLogV2\n| project TimeGenerated, PodNamespace, PodName, ContainerName, LogMessage\n| order by TimeGenerated desc\n| take 200" },
  { label: "azure.query.preset.diagnostics", query: "AzureDiagnostics\n| where Level in (\"Error\", \"Warning\")\n| project TimeGenerated, ResourceType, Resource, Category, OperationName\n| order by TimeGenerated desc\n| take 200" },
];

/** A cell of a query's table, as text. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
