/**
 * An import's parsed tree, turned into the row-shaped payload `api_import_tree` writes in one
 * transaction (see `src-tauri/src/db/api_import.rs`).
 *
 * Everything the columns store as JSON is serialised here, so the backend stays storage and never
 * has to know what an auth block or a request spec means — the same split every other API write
 * keeps.
 */

import type { ApiVariable, AuthConfig, ImportedCollection, ImportedItem } from "../../types/api";
import type { ImportTreeItem, ImportTreePayload } from "../tauri/apiCommands";

/** `inherit` at a level configures nothing, which the column spells `""` — as `saveEntityTab` does. */
function authColumn(auth: AuthConfig | null): string {
  return auth === null || auth.type === "inherit" ? "" : JSON.stringify(auth);
}

function toItems(items: ImportedItem[]): ImportTreeItem[] {
  return items.map((item): ImportTreeItem =>
    item.kind === "request"
      ? { kind: "request", name: item.name, protocol: item.spec.protocol, spec: JSON.stringify(item.spec) }
      : {
          kind: "folder",
          name: item.name,
          description: item.description,
          auth: authColumn(item.auth),
          pre_script: item.preScript,
          post_script: item.postScript,
          items: toItems(item.items),
        },
  );
}

/**
 * `name` renames the collection when the import holds exactly one — with several there is nothing
 * sensible for one typed name to mean.
 */
export function buildImportPayload(
  format: string,
  collections: ImportedCollection[],
  environments: { name: string; variables: ApiVariable[] }[],
  name = "",
): ImportTreePayload {
  const rename = collections.length === 1 && name.trim() !== "" ? name.trim() : null;
  return {
    format,
    collections: collections.map((collection) => ({
      name: rename ?? collection.name,
      description: collection.description,
      auth: authColumn(collection.auth),
      pre_script: collection.preScript,
      post_script: collection.postScript,
      variables: JSON.stringify(collection.variables),
      items: toItems(collection.items),
    })),
    environments: environments.map((environment) => ({
      name: environment.name,
      variables: JSON.stringify(environment.variables),
    })),
  };
}
