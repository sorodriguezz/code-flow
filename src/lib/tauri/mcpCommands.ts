import { invoke } from "@tauri-apps/api/core";

/**
 * Mirrors `mcp_registry::McpServer` — one MCP server declared in CodeFlow, for every model. Env and
 * header values arrive as `"•••"`: they live in the OS keychain and never come back to the frontend.
 */
export interface McpServer {
  id: string;
  workspaceId: string;
  scope: "global" | "workspace";
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  /** On in every conversation unless switched off there. */
  defaultOn: boolean;
  /** Providers it is never handed to. */
  excluded: string[];
  /** A stdio server that arrived without the user's approval (a restored backup) is not run. */
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

/** What the form sends. A value of `"•••"` keeps the stored secret; an empty one removes it. */
export interface McpServerInput {
  id?: string | null;
  workspaceId: string;
  scope: "global" | "workspace";
  name: string;
  transport: "stdio" | "http" | "sse";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  defaultOn: boolean;
  excluded: string[];
}

/** A server a CLI already has, offered for import — secrets named, never sent. */
export interface McpImportCandidate {
  source: "claude" | "codex";
  name: string;
  transport: string;
  summary: string;
  secretNames: string[];
}

export const mcpList = (workspaceId: string) => invoke<McpServer[]>("mcp_list", { workspaceId });
export const mcpSave = (server: McpServerInput) => invoke<McpServer>("mcp_save", { server });
export const mcpDelete = (id: string) => invoke<void>("mcp_delete", { id });
export const mcpApprove = (id: string) => invoke<McpServer>("mcp_approve", { id });
export const mcpImportCandidates = () => invoke<McpImportCandidate[]>("mcp_import_candidates");
export const mcpImport = (workspaceId: string, source: "claude" | "codex", names: string[]) =>
  invoke<McpServer[]>("mcp_import", { workspaceId, source, names });
