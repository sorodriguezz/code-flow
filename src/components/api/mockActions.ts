/**
 * The mock verbs every entry point shares — the collection's context menu, its settings header,
 * the Mock panel and the Services dock — so «Levantar mock» means the same thing from each.
 */

import { apiGetHistorySnapshot, apiListHistoryMeta } from "../../lib/tauri/apiCommands";
import { mockGetConfig, mockSaveConfig, type MockConfig, type MockRoute, type MockStatus } from "../../lib/tauri/mockCommands";
import { mergeRoutes, routeFromRequest } from "../../lib/api/mock";
import { parseSpec, parseVariables, useApiStore } from "../../state/apiStore";
import { useApiMockStore } from "../../state/apiMockStore";
import type { ApiResponse } from "../../types/api";

/** How many history snapshots one generation reads — each is a separate round trip. */
const SNAPSHOT_BUDGET = 40;

/**
 * Routes for every HTTP request saved in the collection: its saved examples when it has some,
 * otherwise the newest response history holds for it.
 */
export async function routesFromCollection(collectionId: string): Promise<MockRoute[]> {
  const state = useApiStore.getState();
  const collection = state.collections.find((c) => c.id === collectionId);
  if (!collection) return [];
  const context = state.variableContext(collectionId);
  const variables = [...parseVariables(collection.variables), ...context.environment, ...context.global];
  const rows = state.requests.filter((r) => r.collection_id === collectionId && r.protocol === "http");
  const specs = rows.map((row) => ({ row, spec: parseSpec(row) }));

  const needHistory = specs.filter(({ spec }) => !(spec.examples ?? []).length);
  const lastResponses = new Map<string, ApiResponse>();
  if (needHistory.length) {
    const meta = await apiListHistoryMeta(collection.workspace_id, 500).catch(() => []);
    // Newest first, so the first entry per request is its latest send.
    const latest = new Map<string, string>();
    for (const entry of meta) {
      if (entry.request_id && entry.status && !latest.has(entry.request_id)) latest.set(entry.request_id, entry.id);
    }
    const wanted = needHistory.filter(({ row }) => latest.has(row.id)).slice(0, SNAPSHOT_BUDGET);
    await Promise.all(
      wanted.map(async ({ row }) => {
        const raw = await apiGetHistorySnapshot(latest.get(row.id)!).catch(() => null);
        if (!raw) return;
        try {
          const snapshot = JSON.parse(raw) as { response?: ApiResponse | null };
          if (snapshot.response) lastResponses.set(row.id, snapshot.response);
        } catch {
          // A snapshot that does not parse just leaves the route on its placeholder answer.
        }
      }),
    );
  }

  return specs.map(({ row, spec }) =>
    routeFromRequest({ id: row.id, name: row.name, spec, lastResponse: lastResponses.get(row.id) ?? null }, variables),
  );
}

/** Adds the collection's requests to its saved rules; returns the new config and how many were added. */
export async function generateIntoConfig(collectionId: string, config: MockConfig): Promise<{ config: MockConfig; added: number }> {
  const { routes, added } = mergeRoutes(config.routes, await routesFromCollection(collectionId));
  return { config: { ...config, routes }, added };
}

/**
 * «Levantar mock». A collection that never had a mock gets its routes generated first, so the
 * button does something useful on the first press instead of serving 404 to everything.
 */
export async function startMock(collectionId: string): Promise<MockStatus> {
  const config = await mockGetConfig(collectionId);
  if (!config.routes.length) {
    const generated = await generateIntoConfig(collectionId, config);
    if (generated.added) await mockSaveConfig(collectionId, generated.config);
  }
  return useApiMockStore.getState().start(collectionId);
}

export function stopMock(collectionId: string): Promise<void> {
  return useApiMockStore.getState().stop(collectionId);
}
