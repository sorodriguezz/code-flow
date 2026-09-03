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
  /** A database: engine, host, port, database, and the login that reaches it. */
  | "database"
  /** A machine reached over SSH/SFTP/FTP: host, port, and a password or a private key. */
  | "server"
  /** Object storage — S3, Azure, GCS, MinIO: an endpoint, a bucket and a key pair. */
  | "storage"
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
  /** Shared with `database` and `server`: where the thing lives. */
  host?: string;
  port?: string;

  // database, server, storage — the infrastructure kinds
  /** `postgres`, `mysql`, `oracle`, … Free text on purpose: the keyring holds credentials for
   *  engines this app does not itself speak, and a select would refuse to store them. */
  engine?: string;
  /** Database, schema or namespace. */
  database?: string;
  /** `disable`, `require`, `verify_full` — or whatever the driver in question calls it. */
  sslMode?: string;
  /** `ssh`, `sftp`, `ftp`, `ftps`, … — what the server is reached over. */
  protocol?: string;
  /** `s3`, `azure`, `gcs`, `minio`, `r2`, … */
  provider?: string;
  /** The service endpoint, for anything not on the provider's default. */
  endpoint?: string;
  region?: string;
  /** Bucket, container or share. */
  bucket?: string;
  /** Access key id, or the storage account name. An identifier rather than a secret — it travels in
   *  request URLs and logs already, which is why it is not in `SECRET_FIELDS`. */
  accessKeyId?: string;
  secretAccessKey?: string;
  /** A SAS or session token. */
  token?: string;

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

/**
 * One entry's password-health verdict, as the backend reports it.
 *
 * Carries no password and no derivative of one — `reuse_group` is a group number, not a hash. See
 * `keyvault_password_health` for why the comparison happens in Rust.
 */
export interface PasswordVerdict {
  item_id: string;
  title: string;
  /** Set when this password is shared with at least one other entry; equal numbers share. */
  reuse_group: number | null;
  weak: boolean;
  /** Not changed in over a year. */
  stale: boolean;
  age_days: number;
}

export interface PasswordHealth {
  /** Entries that carry a password at all — the denominator of "3 of 24". */
  checked: number;
  verdicts: PasswordVerdict[];
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
  database: ["password", "connectionString"],
  server: ["password", "privateKey", "passphrase"],
  storage: ["secretAccessKey", "token", "connectionString"],
  card: ["cardNumber", "cvv", "pin"],
  identity: ["documentNumber"],
  note: ["notes"],
  file: [],
};

/** Which fields the editor shows for each kind, in order. */
export const KIND_FIELDS: Record<VaultItemKind, (keyof VaultSecret)[]> = {
  login: ["username", "password", "totp", "recoveryCodes", "notes"],
  key: ["username", "apiKey", "privateKey", "passphrase", "connectionString", "host", "port", "notes"],
  // Ordered the way the fields are filled in, not alphabetically: what the thing is, where it is,
  // then who you are to it. It is also the order a connection dialog asks for them in, which is what
  // makes an entry readable side by side with the form it was copied from.
  database: [
    "engine",
    "host",
    "port",
    "database",
    "username",
    "password",
    "sslMode",
    "connectionString",
    "notes",
  ],
  server: ["protocol", "host", "port", "username", "password", "privateKey", "passphrase", "notes"],
  storage: [
    "provider",
    "endpoint",
    "region",
    "bucket",
    "accessKeyId",
    "secretAccessKey",
    "token",
    "connectionString",
    "notes",
  ],
  card: ["cardholder", "cardNumber", "expiry", "cvv", "pin", "notes"],
  identity: ["fullName", "documentNumber", "nationality", "issued", "expires", "notes"],
  note: ["notes"],
  file: ["notes"],
};

/**
 * Which payload field the list's second line is taken from, per kind.
 *
 * The subtitle is **derived, not typed**. It used to be its own box in the editor, sitting directly
 * above the `username` field and labelled "Username" as well — two boxes with the same label, and
 * whichever one you filled, the other stayed empty. It is not a field the user has an opinion
 * about: it is "who am I on this thing", which every kind already has a field for.
 *
 * It is stored **in the clear**, like the title, so a locked keyring can still say what is in it.
 * That is why `storage` takes the bucket rather than the access key id, and why `card` takes the
 * cardholder rather than any part of the number: the value here is one an over-the-shoulder glance
 * is welcome to. `null` is a kind with nothing worth putting there.
 */
export const SUBTITLE_FIELD: Record<VaultItemKind, keyof VaultSecret | null> = {
  login: "username",
  key: "username",
  database: "username",
  server: "username",
  storage: "bucket",
  card: "cardholder",
  identity: "fullName",
  note: null,
  file: null,
};

/** The subtitle an entry should carry, given what is in it. Empty is a valid answer. */
export function deriveSubtitle(kind: VaultItemKind, secret: VaultSecret): string {
  const field = SUBTITLE_FIELD[kind];
  if (!field) return "";
  const value = secret[field];
  return typeof value === "string" ? value.trim() : "";
}
