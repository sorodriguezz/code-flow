import type { FlowConnector, FlowLabel, FlowNodeDescriptor } from "../tauri/flowsCommands";

/**
 * What the palette lists: a node type, or one service of a node type.
 *
 * Most entries are a node type as the catalogue has it. The Apps family is the exception: its three
 * node types (the Conector, Google, Microsoft 365) are drawn as **one entry per service** — Slack,
 * Telegram, Gmail, OneDrive… — because nobody goes looking for "Conector": they look for Slack, and
 * searching for "Telegram" used to find nothing (the Conector's description named eleven services
 * and ended in "y más"). An entry for a service adds the same node type with its `preset` params, so
 * the node lands already pointing at the service, named after it.
 */
export interface PaletteEntry {
  /** The type id, or `typeId:serviceId` for a service. */
  key: string;
  descriptor: FlowNodeDescriptor;
  /** Shown name; for a node type, its translation (filled by the caller). */
  name: string;
  description: string;
  /** Palette sub-heading — `flows.group.<group>`, `""` for none. */
  group: string;
  /** Params the node starts with. */
  preset?: Record<string, unknown>;
  /** A service mark (`appLogo`) to draw instead of the Lucide glyph. */
  logo?: string;
  /** More words search should match: the service's id. */
  keywords?: string;
}

/** The Apps family's headings, in the order the palette shows them. */
const APPS_HEADINGS = ["appsChat", "appsProjects", "appsDevops", "appsData", "appsGoogle", "appsMicrosoft", ""];

/** Google's services, as `net.google`'s `service` param names them. */
export const GOOGLE_SERVICES = [
  { id: "gmail", name: "Gmail", logo: "gmail" },
  { id: "sheets", name: "Google Sheets", logo: "" },
  { id: "calendar", name: "Google Calendar", logo: "calendar" },
  { id: "drive", name: "Google Drive", logo: "drive" },
] as const;

/** Microsoft 365's services, as `net.microsoft`'s `service` param names them. */
export const MICROSOFT_SERVICES = [
  { id: "outlook", name: "Outlook", logo: "outlook" },
  { id: "calendar", name: "Outlook Calendar", logo: "microsoft" },
  { id: "onedrive", name: "OneDrive", logo: "onedrive" },
  { id: "excel", name: "Excel", logo: "excel" },
] as const;

/** The service a node calls, as a mark id — what the canvas draws on an Apps node. */
export function serviceOf(typeId: string, params: Record<string, unknown>): string {
  if (typeId === "net.connector") {
    const call = params.call;
    return call && typeof call === "object" && typeof (call as Record<string, unknown>).connector === "string"
      ? ((call as Record<string, unknown>).connector as string)
      : "";
  }
  const service = typeof params.service === "string" ? params.service : "";
  if (typeId === "net.google") return GOOGLE_SERVICES.find((s) => s.id === (service || "gmail"))?.logo ?? "";
  if (typeId === "net.microsoft") return MICROSOFT_SERVICES.find((s) => s.id === (service || "outlook"))?.logo ?? "";
  return "";
}

/**
 * The palette's entries, in catalogue order — a family's entries heading by heading, the services of
 * a node in the place that node holds.
 *
 * `nameOf` / `descriptionOf` translate a node type; `serviceDescription` a Google or Microsoft
 * service's line (`flows.appDesc.<node>.<service>`); `say` picks a connector label's language.
 */
export function paletteEntries(
  catalog: readonly FlowNodeDescriptor[],
  connectors: readonly FlowConnector[],
  nameOf: (d: FlowNodeDescriptor) => string,
  descriptionOf: (d: FlowNodeDescriptor) => string,
  serviceDescription: (typeId: string, service: string) => string,
  say: (label: FlowLabel) => string,
): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const d of catalog) {
    if (d.typeId === "net.connector") {
      // Until the definitions arrive, the node itself stands in for its services.
      if (connectors.length === 0) {
        entries.push({ key: d.typeId, descriptor: d, name: nameOf(d), description: descriptionOf(d), group: d.group });
        continue;
      }
      const ordered = [...connectors].sort((a, b) => a.name.localeCompare(b.name));
      for (const c of ordered) {
        const first = c.operations[0];
        entries.push({
          key: `${d.typeId}:${c.id}`,
          descriptor: d,
          name: c.name,
          description: c.operations.map((op) => say(op.name)).join(" · "),
          group: c.group || "appsData",
          preset: { call: { connector: c.id, operation: first?.id ?? "", fields: {} } },
          logo: c.id,
          keywords: c.id,
        });
      }
      continue;
    }
    const services = d.typeId === "net.google" ? GOOGLE_SERVICES : d.typeId === "net.microsoft" ? MICROSOFT_SERVICES : null;
    if (services) {
      for (const s of services) {
        entries.push({
          key: `${d.typeId}:${s.id}`,
          descriptor: d,
          name: s.name,
          description: serviceDescription(d.typeId, s.id),
          group: d.group,
          preset: { service: s.id },
          logo: s.logo || undefined,
          keywords: s.id,
        });
      }
      continue;
    }
    entries.push({ key: d.typeId, descriptor: d, name: nameOf(d), description: descriptionOf(d), group: d.group });
  }
  // Headings in the order their first entry appears — except in Apps, whose services are sorted by
  // name above and whose headings have an order of their own.
  const families: string[] = [];
  const headings: string[] = [];
  for (const e of entries) {
    if (!families.includes(e.descriptor.family)) families.push(e.descriptor.family);
    const key = `${e.descriptor.family}/${e.group}`;
    if (!headings.includes(key)) headings.push(key);
  }
  const headingRank = (e: PaletteEntry) =>
    e.descriptor.family === "apps" ? APPS_HEADINGS.indexOf(e.group) : headings.indexOf(`${e.descriptor.family}/${e.group}`);
  return entries
    .map((e, index) => ({ e, index }))
    .sort((a, b) => families.indexOf(a.e.descriptor.family) - families.indexOf(b.e.descriptor.family) || headingRank(a.e) - headingRank(b.e) || a.index - b.index)
    .map(({ e }) => e);
}
