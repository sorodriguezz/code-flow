import { getAdoPat, getSetting, setSetting } from "./tauri/commands";
import type { AdoConnection } from "../types/domain";

// The list of connected Azure DevOps organizations, persisted as a single app-setting JSON
// blob — the PATs themselves stay in the OS keychain, keyed per org (`ado-pat:{org}`). Mirrors
// the GitHub connections model so both hosts support several accounts at once.
const KEY = "ado_connections";
// Where a single org lived before multi-org support — read once for back-compat migration.
const LEGACY_ORG_KEY = "ado_default_org";

export async function loadAdoConnections(): Promise<AdoConnection[]> {
  const raw = await getSetting(KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((c): c is AdoConnection => c && typeof c.org === "string");
    } catch {
      /* fall through to legacy */
    }
  }
  // Back-compat: before multi-org support, a single org lived in `ado_default_org`. Surface it
  // as a one-item list (only if its PAT is still saved) so an existing connection isn't lost
  // after upgrading. Once the user adds/removes anything, `ado_connections` becomes authoritative.
  const legacyOrg = await getSetting(LEGACY_ORG_KEY);
  if (legacyOrg) {
    const pat = await getAdoPat(legacyOrg).catch(() => null);
    if (pat) return [{ org: legacyOrg }];
  }
  return [];
}

export async function saveAdoConnections(connections: AdoConnection[]): Promise<void> {
  await setSetting(KEY, JSON.stringify(connections));
}

// Accepts a bare org name or a pasted `https://dev.azure.com/<org>` /
// `https://<org>.visualstudio.com` URL and reduces it to the bare name — the Azure DevOps REST
// client builds request paths straight from this value and rejects URLs.
export function normalizeAdoOrg(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  const devAzureMatch = trimmed.match(/^https?:\/\/dev\.azure\.com\/([^/]+)/i);
  if (devAzureMatch) return devAzureMatch[1];
  const visualStudioMatch = trimmed.match(/^https?:\/\/([^./]+)\.visualstudio\.com/i);
  if (visualStudioMatch) return visualStudioMatch[1];
  return trimmed;
}
