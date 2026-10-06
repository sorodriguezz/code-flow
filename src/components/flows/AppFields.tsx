import { useEffect, useState } from "react";
import { Select } from "../common/Select";
import { str } from "./fieldRows";
import { dbLoadTree } from "../../lib/tauri/dbCommands";
import { remoteLoadTree } from "../../lib/tauri/remoteCommands";
import { notesLoadTree } from "../../lib/tauri/notesCommands";
import { keyvaultLoadTree } from "../../lib/tauri/keyvaultCommands";
import { apiListEnvironments, apiLoadTree } from "../../lib/tauri/apiCommands";
import { useT } from "../../state/languageStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

/**
 * Pickers for things that live in other CodeFlow apps: a database connection, a Remote host, a
 * note, a Llavero item. Each stores the row's id and lists the workspace's rows by name.
 */

type Option = { value: string; label: string };

/** The workspace's rows of one kind, loaded once per workspace and kept for the session. */
function useRows(key: string, load: (workspaceId: string) => Promise<Option[]>): { options: Option[]; problem: string | null } {
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [options, setOptions] = useState<Option[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void load(workspaceId)
      .then((rows) => {
        if (!alive) return;
        setOptions(rows);
        setProblem(null);
      })
      .catch((error) => alive && setProblem(String(error)));
    return () => {
      alive = false;
    };
    // `load` is a module-level function per picker; `key` names it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, key]);
  return { options, problem };
}

function Picker({
  value,
  onChange,
  options,
  placeholder,
  empty,
  problem,
}: {
  value: unknown;
  onChange: (next: unknown) => void;
  options: Option[];
  placeholder: string;
  empty: string;
  problem?: string | null;
}) {
  const current = str(value);
  // A row that is gone still shows, so the node does not read as unset when it is not.
  const shown = current && !options.some((o) => o.value === current) ? [...options, { value: current, label: current }] : options;
  return (
    <div className="flex flex-col gap-1">
      <div className="max-w-[300px]">
        <Select value={current} onChange={onChange} placeholder={options.length === 0 ? empty : placeholder} options={shown} size="sm" />
      </div>
      {problem && <span className="text-[11.5px] text-[var(--cf-text-muted)]">{problem}</span>}
    </div>
  );
}

const loadConnections = (kinds: string[]) => async (workspaceId: string) => {
  const tree = await dbLoadTree(workspaceId);
  return tree.connections.filter((row) => kinds.includes(row.kind)).map((row) => ({ value: row.id, label: row.name }));
};

export function DbConnectionPicker({ value, onChange, kinds }: { value: unknown; onChange: (next: unknown) => void; kinds: string[] }) {
  const t = useT();
  const { options, problem } = useRows(`db:${kinds.join(",")}`, loadConnections(kinds));
  return <Picker value={value} onChange={onChange} options={options} placeholder={t("flows.app.pickConnection")} empty={t("flows.app.noConnections")} problem={problem} />;
}

const loadHosts = (kinds: string[]) => async (workspaceId: string) => {
  const tree = await remoteLoadTree(workspaceId);
  return tree.hosts
    .filter((row) => {
      let kind = "ssh";
      try {
        kind = (JSON.parse(row.spec) as { kind?: string }).kind ?? "ssh";
      } catch {
        // A row whose spec does not parse is offered as what it most likely is.
      }
      return kinds.includes(kind);
    })
    .map((row) => ({ value: row.id, label: row.name }));
};

export function RemoteHostPicker({ value, onChange, kinds }: { value: unknown; onChange: (next: unknown) => void; kinds: string[] }) {
  const t = useT();
  const { options, problem } = useRows(`remote:${kinds.join(",")}`, loadHosts(kinds));
  return <Picker value={value} onChange={onChange} options={options} placeholder={t("flows.app.pickHost")} empty={t("flows.app.noHosts")} problem={problem} />;
}

const loadNotes = async (workspaceId: string) => {
  const tree = await notesLoadTree(workspaceId);
  return tree.notes.map((note) => ({ value: note.id, label: note.title || "—" }));
};

export function NotePicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const { options, problem } = useRows("notes", loadNotes);
  return <Picker value={value} onChange={onChange} options={options} placeholder={t("flows.app.pickNote")} empty={t("flows.app.noNotes")} problem={problem} />;
}

const loadVault = async (workspaceId: string) => {
  const tree = await keyvaultLoadTree(workspaceId);
  return tree.items.map((item) => ({ value: item.id, label: item.subtitle ? `${item.title} · ${item.subtitle}` : item.title }));
};

export function VaultItemPicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const { options, problem } = useRows("vault", loadVault);
  // A locked Llavero cannot list its items; it says so rather than looking empty.
  return (
    <Picker
      value={value}
      onChange={onChange}
      options={options}
      placeholder={t("flows.app.pickVaultItem")}
      empty={problem ? t("flows.app.vaultLocked") : t("flows.app.noVaultItems")}
      problem={null}
    />
  );
}

/** The workspace's saved HTTP requests, as "Collection / folder / request". */
const loadApiRequests = async (workspaceId: string) => {
  const tree = await apiLoadTree(workspaceId);
  const folderName = new Map(tree.folders.map((folder) => [folder.id, folder] as const));
  const path = (folderId: string | null) => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = folderId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const folder = folderName.get(current);
      if (!folder) break;
      names.unshift(folder.name);
      current = folder.parent_id;
    }
    return names;
  };
  const collectionName = new Map(tree.collections.map((collection) => [collection.id, collection.name] as const));
  return tree.requests
    .filter((request) => request.protocol === "http")
    .map((request) => ({
      value: request.id,
      label: [collectionName.get(request.collection_id) ?? "—", ...path(request.folder_id), request.name].join(" / "),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
};

export function ApiRequestPicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const { options, problem } = useRows("apiRequests", loadApiRequests);
  return <Picker value={value} onChange={onChange} options={options} placeholder={t("flows.app.pickRequest")} empty={t("flows.app.noRequests")} problem={problem} />;
}

const loadEnvironments = async (workspaceId: string) => {
  const environments = await apiListEnvironments(workspaceId);
  return environments.filter((environment) => !environment.is_global).map((environment) => ({ value: environment.id, label: environment.name }));
};

/** `""` follows the environment active in the API client; `"none"` sends without one. */
export function ApiEnvironmentPicker({ value, onChange }: { value: unknown; onChange: (next: unknown) => void }) {
  const t = useT();
  const { options, problem } = useRows("apiEnvironments", loadEnvironments);
  const all = [{ value: "", label: t("flows.app.activeEnvironment") }, { value: "none", label: t("flows.app.noEnvironment") }, ...options];
  return <Picker value={value} onChange={onChange} options={all} placeholder={t("flows.app.activeEnvironment")} empty={t("flows.app.activeEnvironment")} problem={problem} />;
}
