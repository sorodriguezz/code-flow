/**
 * The keyring's types.
 *
 * Two layers, like `types/notes.ts`: **wire types** (`*Row`) mirror the Rust structs in `db::models`
 * field for field — `tags` is the JSON *string* SQLite stores — and **view types** are what the
 * components use, with the tags already parsed.
 *
 * The split that matters most here is a different one, and it is enforced by the backend rather
 * than by convention: `VaultItem` has **no secret**. The list, the tree and the search index are all
 * built from metadata that is stored in the clear, so a locked keyring can still say what is in it.
 * A secret arrives one entry at a time, through `keyvaultGetItem`, and only while unlocked.
 */

/** What kind of thing an entry is. Decides which fields the editor shows and how the row is drawn. */
export type VaultItemKind =
  /** Site or app: username, password, URL, and optionally a TOTP secret. */
  | "login"
  /** A payment card. */
  | "card"
  /** Free-form encrypted text. */
  | "note"
  /** Passport, driving licence, national id. */
  | "identity"
  /** The developer's bread and butter: API keys, SSH keys, tokens, connection strings. */
  | "key"
  /** An entry that is mostly its attachments — a certificate, a licence file. */
  | "file";

/**
 * The decrypted payload, by kind.
 *
 * Every field is optional and every one is a string: the payload is one JSON blob the backend seals
 * without interpreting, so adding a field here needs no migration — the same bargain
 * `api_requests.spec` and `db_connections.spec` make.
 */
export interface VaultSecret {
  // login
  username?: string;
  password?: string;
  /** An `otpauth://` URI or a bare base32 secret. Never rendered — the *code* is asked for
   *  separately, so the secret itself stays in the backend. See `keyvaultTotpCode`. */
  totp?: string;
  /** Recovery/backup codes, one per line. */
  recoveryCodes?: string;

  // key
  apiKey?: string;
  privateKey?: string;
  passphrase?: string;
  connectionString?: string;
  host?: string;
  port?: string;

  // card
  cardholder?: string;
  cardNumber?: string;
  expiry?: string;
  cvv?: string;
  pin?: string;

  // identity
  fullName?: string;
  documentNumber?: string;
  issued?: string;
  expires?: string;
  nationality?: string;

  // every kind
  notes?: string;
  /** Anything the fixed fields do not cover, as name/value pairs. */
  custom?: { name: string; value: string; secret?: boolean }[];
}

/** Whether the keyring exists, and whether it is open. Says nothing about what is in it. */
export interface VaultStatus {
  initialised: boolean;
  unlocked: boolean;
  /** Minutes of inactivity before it locks itself. `0` is never. */
  autolock_minutes: number;
  /** Whether this machine holds the master password in the OS credential store. */
  remembered: boolean;
}

export interface VaultFolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  color: string;
  /** `""` is every workspace. */
  workspace_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** An entry **without its secret** — what every list is built from. */
export interface VaultItemRow {
  id: string;
  folder_id: string | null;
  kind: VaultItemKind;
  title: string;
  subtitle: string;
  site: string;
  /** JSON array of strings, verbatim as stored. Parsed once at the store boundary. */
  tags: string;
  favorite: boolean;
  workspace_id: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  /** Empty unless the entry is in the trash. */
  deleted_at: string;
  attachments: number;
}

/** One entry with its secret decrypted. Held one at a time, never in a list. */
export interface VaultItemPlainRow extends VaultItemRow {
  secret: VaultSecret;
}

export interface VaultBlobMeta {
  id: string;
  item_id: string;
  name: string;
  mime: string;
  /** The plaintext length, so a list can say "2.4 MB" without decrypting anything. */
  size_bytes: number;
  created_at: string;
}

export interface VaultTreeRows {
  folders: VaultFolderRow[];
  items: VaultItemRow[];
}

export interface VaultAuditRow {
  id: string;
  item_id: string;
  action: string;
  at: string;
}

export interface PasswordRecipe {
  length: number;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
  /** Include characters that are easy to misread (`l1IO0`). Off by default. */
  ambiguous: boolean;
}

export const DEFAULT_RECIPE: PasswordRecipe = {
  length: 20,
  uppercase: true,
  digits: true,
  symbols: true,
  ambiguous: false,
};

/** The current 2FA code and how long it lasts. */
export interface TotpCode {
  code: string;
  seconds_remaining: number;
  period: number;
}

// ---------------------------------------------------------------------------
// View types
// ---------------------------------------------------------------------------

/** An entry, tags parsed. */
export interface VaultItem extends Omit<VaultItemRow, "tags"> {
  tags: string[];
}

/** A folder with its children, so the flattener can walk without re-scanning per level. */
export interface VaultFolder extends VaultFolderRow {
  children: VaultFolder[];
}

/** One row of the explorer tree. */
export type VaultTreeRow =
  | { kind: "folder"; id: string; depth: number; folder: VaultFolder; itemCount: number }
  | { kind: "item"; id: string; depth: number; item: VaultItem };

/** How the list is ordered. */
export type VaultSort = "recent" | "title" | "created";

/**
 * Which fields of a payload are secret, per kind.
 *
 * Drives two things at once: what the detail panel masks behind a reveal, and what "copy" offers.
 * A single list rather than a flag per field, because the answer is a property of the *kind* and
 * having it in one place is what stops a new field shipping unmasked by accident.
 */
export const SECRET_FIELDS: Record<VaultItemKind, (keyof VaultSecret)[]> = {
  login: ["password", "totp", "recoveryCodes"],
  key: ["apiKey", "privateKey", "passphrase", "connectionString"],
  card: ["cardNumber", "cvv", "pin"],
  identity: ["documentNumber"],
  note: ["notes"],
  file: [],
};

/** Which fields the editor shows for each kind, in order. */
export const KIND_FIELDS: Record<VaultItemKind, (keyof VaultSecret)[]> = {
  login: ["username", "password", "totp", "recoveryCodes", "notes"],
  key: ["username", "apiKey", "privateKey", "passphrase", "connectionString", "host", "port", "notes"],
  card: ["cardholder", "cardNumber", "expiry", "cvv", "pin", "notes"],
  identity: ["fullName", "documentNumber", "nationality", "issued", "expires", "notes"],
  note: ["notes"],
  file: ["notes"],
};
