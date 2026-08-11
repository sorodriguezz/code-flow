import { useMemo, useState } from "react";
import { Loader2, Plus, Table2, Trash2 } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton } from "../api/ApiModal";
import { Select } from "../common/Select";
import { pushErrorToast } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { remoteTableUpsert } from "../../lib/tauri/remoteCommands";
import type { TranslationKey } from "../../lib/i18n/translations";

/**
 * Adding or editing one Table entity — Storage Explorer's Add/Edit dialog, and the same shape for
 * the same reason.
 *
 * **A property has a type, and the type is not guessable from the box you typed it in.** `42` is a
 * plausible Int32, Int64 or String, and the three are stored differently and filter differently:
 * `RowKey gt '9'` and `Age gt 9` do not mean the same comparison. The service infers a type from
 * JSON when none is given — string, double, boolean — and needs an explicit `@odata.type`
 * annotation for the four it cannot see in JSON at all (Int64, DateTime, Guid, Binary). So the type
 * is a control rather than a guess, pre-filled from what came back and changeable.
 *
 * **The write is a replace, not a merge**, because this dialog shows the whole entity: a MERGE would
 * silently keep a property the user has just deleted from the form. That is `remotes::cloud::table`
 * upsert's own note, and this is the editor it was written for.
 *
 * **`Timestamp` is the service's and never sent.** It is a column in the grid because it is worth
 * reading; it is not a field here because writing one is rejected, and a form that offers a box the
 * server refuses is a form that teaches the wrong thing.
 */

/** The EDM types a Table property can have. The four after `Boolean` are the ones JSON cannot
 *  express, and each is sent with a `Name@odata.type` annotation beside its value. */
const EDM_TYPES = [
  "String",
  "Int32",
  "Int64",
  "Double",
  "Boolean",
  "DateTime",
  "Guid",
  "Binary",
] as const;

type EdmType = (typeof EDM_TYPES)[number];

/** Properties the service owns. Read in the grid, never written from here. */
const RESERVED = new Set(["Timestamp", "etag", "odata.etag"]);

interface PropertyDraft {
  /** Stable across renders so React keeps the row while its name is being typed. */
  id: number;
  name: string;
  type: EdmType;
  value: string;
}

let draftSeq = 0;

/**
 * What type a property is, read from the wire rather than guessed from it.
 *
 * The annotation is the authority and JSON is the fallback, in that order, because JSON cannot
 * express four of the eight types: an `Int64`, a `DateTime`, a `Guid` and a `Binary` all arrive as
 * strings and are indistinguishable from a string that is genuinely a string. Guessing would mean
 * an entity opened and saved without touching the type box came back with its 19-digit id quietly
 * restored as text. `remotes::cloud::azure::sign_table` asks for `odata=minimalmetadata` precisely
 * so that `Name@odata.type` is sitting here to be read.
 */
function typeOf(entity: Record<string, unknown>, name: string): EdmType {
  const declared = entity[`${name}@odata.type`];
  if (typeof declared === "string") {
    const stripped = declared.replace(/^Edm\./, "");
    if ((EDM_TYPES as readonly string[]).includes(stripped)) return stripped as EdmType;
  }
  const value = entity[name];
  if (typeof value === "boolean") return "Boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "Int32" : "Double";
  return "String";
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function EntityEditorModal({
  hostId,
  table,
  entity,
  columns,
  onClose,
  onSaved,
}: {
  hostId: string;
  table: string;
  /** `null` to add a new entity. */
  entity: Record<string, unknown> | null;
  /** The grid's columns, used to seed a new entity with the shape the table already has. */
  columns: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useT();
  const editing = entity !== null;

  const [partition, setPartition] = useState(() => asText(entity?.PartitionKey));
  const [rowKey, setRowKey] = useState(() => asText(entity?.RowKey));
  const [properties, setProperties] = useState<PropertyDraft[]>(() => {
    if (entity) {
      return Object.keys(entity)
        .filter((key) => !RESERVED.has(key) && key !== "PartitionKey" && key !== "RowKey")
        .filter((key) => !key.startsWith("odata.") && !key.includes("@odata."))
        .map((key) => ({
          id: ++draftSeq,
          name: key,
          type: typeOf(entity, key),
          value: asText(entity[key]),
        }));
    }
    // A new entity in a table that already has a shape starts with that shape, empty. It is the
    // difference between "add a row" and "reconstruct the schema from memory" — and on a service
    // with no schema, memory is the only place it exists.
    return columns
      .filter((key) => !RESERVED.has(key) && key !== "PartitionKey" && key !== "RowKey")
      .map((key) => ({ id: ++draftSeq, name: key, type: "String" as EdmType, value: "" }));
  });
  const [saving, setSaving] = useState(false);

  /** The first thing wrong with the form, or `null`. Shown under the fields rather than raised as a
   *  toast on submit: every one of these is visible before the button is pressed. */
  const problem = useMemo(() => {
    // Both, not either: `remotes::cloud::table::upsert` refuses an entity missing one of them, and
    // a form that lets you press Save into that refusal is a form that teaches nothing.
    if (!partition.trim() || !rowKey.trim()) return t("remote.entityNeedsKeys");
    const names = properties.map((one) => one.name.trim()).filter(Boolean);
    if (new Set(names).size !== names.length) return t("remote.entityDuplicateProperty");
    for (const property of properties) {
      const name = property.name.trim();
      if (!name) continue;
      if (RESERVED.has(name) || name === "PartitionKey" || name === "RowKey") {
        return t("remote.entityReservedProperty", { name });
      }
      const invalid = valueProblem(property, t);
      if (invalid) return invalid;
    }
    return null;
  }, [partition, rowKey, properties, t]);

  const set = (id: number, changes: Partial<PropertyDraft>) =>
    setProperties((current) =>
      current.map((one) => (one.id === id ? { ...one, ...changes } : one)),
    );

  const save = async () => {
    if (problem) return;
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        PartitionKey: partition,
        RowKey: rowKey,
      };
      for (const property of properties) {
        const name = property.name.trim();
        if (!name) continue;
        // An empty box is a property that isn't there. Azure has no null — writing one deletes the
        // property — so "clear this field" and "remove this property" are the same act, and a
        // replace that simply omits it is how both are spelled.
        if (property.value === "") continue;
        const { value, odataType } = encode(property);
        payload[name] = value;
        if (odataType) payload[`${name}@odata.type`] = odataType;
      }
      await remoteTableUpsert(hostId, table, payload);
      onSaved();
      onClose();
    } catch (error) {
      pushErrorToast(String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ApiModal
      icon={Table2}
      title={editing ? t("remote.entityEdit") : t("remote.entityAdd")}
      subtitle={table}
      width="max-w-2xl"
      busy={saving}
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          {problem && (
            <p className="mr-auto min-w-0 flex-1 truncate text-[11px] text-[var(--cf-danger)]">
              {problem}
            </p>
          )}
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={() => void save()} disabled={!!problem || saving}>
            {saving && <Loader2 size={13} className="animate-spin" />}
            {t("common.save")}
          </PrimaryButton>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              PartitionKey
            </span>
            {/* Locked while editing: the two keys *are* the entity's address, so changing one here
                would not move a row — it would leave the old one behind and write a second. Storage
                Explorer refuses the same edit for the same reason. */}
            <Field value={partition} onChange={setPartition} disabled={editing} mono />
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
              RowKey
            </span>
            <Field value={rowKey} onChange={setRowKey} disabled={editing} mono />
          </label>
        </div>
        {editing && (
          <p className="text-[11px] text-[var(--cf-text-muted)]">{t("remote.entityKeysLocked")}</p>
        )}

        <div className="rounded-md border border-[var(--cf-border)]">
          <div className="flex items-center gap-2 border-b border-[var(--cf-border)] px-2 py-1">
            <span className="mr-auto text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("remote.entityProperties")}
            </span>
            <GhostButton
              onClick={() =>
                setProperties((current) => [
                  ...current,
                  { id: ++draftSeq, name: "", type: "String", value: "" },
                ])
              }
            >
              <Plus size={12} />
              {t("remote.entityAddProperty")}
            </GhostButton>
          </div>
          <div className="max-h-[42vh] overflow-y-auto p-1.5">
            {properties.length === 0 ? (
              <p className="px-1.5 py-2 text-[11px] text-[var(--cf-text-muted)]">
                {t("remote.entityNoProperties")}
              </p>
            ) : (
              properties.map((property) => (
                <div key={property.id} className="flex items-center gap-1.5 py-0.5">
                  <div className="w-[34%] min-w-0">
                    <Field
                      value={property.name}
                      onChange={(name) => set(property.id, { name })}
                      placeholder={t("remote.entityPropertyName")}
                      mono
                    />
                  </div>
                  <div className="w-[104px] shrink-0">
                    <Select
                      value={property.type}
                      onChange={(type) => set(property.id, { type: type as EdmType })}
                      size="field"
                      options={EDM_TYPES.map((type) => ({ value: type, label: type }))}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Field
                      value={property.value}
                      onChange={(value) => set(property.id, { value })}
                      placeholder={placeholderFor(property.type)}
                      mono
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setProperties((current) => current.filter((one) => one.id !== property.id))
                    }
                    title={t("remote.entityRemoveProperty")}
                    aria-label={t("remote.entityRemoveProperty")}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[var(--cf-text-muted)] hover:bg-black/[0.05] hover:text-[var(--cf-danger)] dark:hover:bg-white/[0.08]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--cf-text-muted)]">
          {t("remote.entityEmptyIsAbsent")}
        </p>
      </div>
    </ApiModal>
  );
}

/** What a value of this type should look like, said in the box rather than after the request. */
function placeholderFor(type: EdmType): string {
  switch (type) {
    case "Boolean":
      return "true";
    case "DateTime":
      return "2026-01-31T09:00:00Z";
    case "Guid":
      return "00000000-0000-0000-0000-000000000000";
    case "Binary":
      return "base64";
    case "Double":
      return "1.5";
    case "Int32":
    case "Int64":
      return "42";
    default:
      return "";
  }
}

/** Why this value can't be sent as this type, or `null`. Checked here because the service's answer
 *  — a 400 naming the whole request — does not say which property it choked on. */
function valueProblem(
  property: PropertyDraft,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string | null {
  const { name, type, value } = property;
  if (value === "") return null;
  const bad = () => t("remote.entityBadValue", { name: name.trim(), type });
  switch (type) {
    case "Int32":
    case "Int64":
      return /^-?\d+$/.test(value.trim()) ? null : bad();
    case "Double":
      return Number.isFinite(Number(value.trim())) ? null : bad();
    case "Boolean":
      return /^(true|false)$/i.test(value.trim()) ? null : bad();
    case "DateTime":
      return Number.isNaN(Date.parse(value.trim())) ? bad() : null;
    case "Guid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())
        ? null
        : bad();
    default:
      return null;
  }
}

/**
 * One property as the wire wants it.
 *
 * `Int64` goes out as a *string* and not a number, which looks wrong and is not: JSON numbers are
 * doubles, so a 19-digit id sent as a number comes back rounded. The annotation is what tells the
 * service to read the string as an integer.
 */
function encode(property: PropertyDraft): { value: unknown; odataType: string | null } {
  const raw = property.value.trim();
  switch (property.type) {
    case "Int32":
      return { value: Number(raw), odataType: null };
    case "Double":
      // Annotated rather than inferred, unlike Int32. The service reads a JSON number with no
      // fractional part as an Edm.Int32, and JSON has no way to keep the difference: `100` and
      // `100.0` serialise identically, so picking Double and typing a whole number would silently
      // store an Int32 — a different type from the 100.5 sitting in the same column, and an
      // overflow for anything past 2^31.
      return { value: Number(raw), odataType: "Edm.Double" };
    case "Boolean":
      return { value: raw.toLowerCase() === "true", odataType: null };
    case "Int64":
      return { value: raw, odataType: "Edm.Int64" };
    case "DateTime":
      return { value: new Date(raw).toISOString(), odataType: "Edm.DateTime" };
    case "Guid":
      return { value: raw, odataType: "Edm.Guid" };
    case "Binary":
      return { value: raw, odataType: "Edm.Binary" };
    default:
      // Not trimmed: leading and trailing spaces are part of a string value, and a key that ends in
      // one is a real thing people have to look at.
      return { value: property.value, odataType: null };
  }
}
