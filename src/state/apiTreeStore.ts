import { create } from "zustand";
import { useApiStore } from "./apiStore";
import type { ApiFolder } from "../types/api";

const EXPANDED_STORAGE_KEY = "cf_api_tree_expanded";

export type ApiSidebarSection = "collections" | "environments" | "history";

export type ApiTreeNodeKind = "collection" | "folder" | "request";

export interface ApiTreeReveal {
  kind: ApiTreeNodeKind;
  id: string;
  sequence: number;
}

interface ApiTreeState {
  expanded: Set<string>;
  section: ApiSidebarSection;
  query: string;
  reveal: ApiTreeReveal | null;
  setSection: (section: ApiSidebarSection) => void;
  setQuery: (query: string) => void;
  toggle: (id: string) => void;
  expand: (id: string) => void;
  revealNode: (kind: ApiTreeNodeKind, id: string) => void;
  consumeReveal: (sequence: number) => void;
}

function readStoredExpanded(): Set<string> {
  try {
    const stored = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!stored) return new Set();
    const parsed: unknown = JSON.parse(stored);
    const isIdList = Array.isArray(parsed) && parsed.every((id) => typeof id === "string");
    return isIdList ? new Set(parsed as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function writeStoredExpanded(expanded: Set<string>): void {
  const ids = [...expanded];
  const serialized = JSON.stringify(ids);
  try {
    localStorage.setItem(EXPANDED_STORAGE_KEY, serialized);
  } catch {
    return;
  }
}

function folderChainIds(firstFolderId: string | null, folders: ApiFolder[]): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let currentFolderId = firstFolderId;
  while (currentFolderId !== null) {
    const folderId = currentFolderId;
    const alreadyVisited = visited.has(folderId);
    if (alreadyVisited) break;
    visited.add(folderId);
    chain.push(folderId);
    const folder = folders.find((candidate) => candidate.id === folderId);
    currentFolderId = folder?.parent_id ?? null;
  }
  return chain;
}

function containerIdsAbove(kind: ApiTreeNodeKind, id: string): string[] {
  const { folders, requests } = useApiStore.getState();
  if (kind === "collection") return [];
  if (kind === "folder") {
    const folder = folders.find((candidate) => candidate.id === id);
    if (!folder) return [];
    const parentChain = folderChainIds(folder.parent_id, folders);
    return [folder.collection_id, ...parentChain];
  }
  const request = requests.find((candidate) => candidate.id === id);
  if (!request) return [];
  const folderChain = folderChainIds(request.folder_id, folders);
  return [request.collection_id, ...folderChain];
}

let revealSequence = 0;

export const useApiTreeStore = create<ApiTreeState>((set, get) => ({
  expanded: readStoredExpanded(),
  section: "collections",
  query: "",
  reveal: null,

  setSection: (section) => set({ section }),

  setQuery: (query) => set({ query }),

  toggle: (id) => {
    const next = new Set(get().expanded);
    const wasExpanded = next.has(id);
    if (wasExpanded) next.delete(id);
    else next.add(id);
    writeStoredExpanded(next);
    set({ expanded: next });
  },

  expand: (id) => {
    const current = get().expanded;
    const alreadyExpanded = current.has(id);
    if (alreadyExpanded) return;
    const next = new Set(current).add(id);
    writeStoredExpanded(next);
    set({ expanded: next });
  },

  revealNode: (kind, id) => {
    const containers = containerIdsAbove(kind, id);
    const next = new Set(get().expanded);
    for (const containerId of containers) next.add(containerId);
    writeStoredExpanded(next);
    revealSequence += 1;
    set({
      expanded: next,
      section: "collections",
      query: "",
      reveal: { kind, id, sequence: revealSequence },
    });
  },

  consumeReveal: (sequence) => {
    const pending = get().reveal;
    const isPending = pending?.sequence === sequence;
    if (!isPending) return;
    set({ reveal: null });
  },
}));
