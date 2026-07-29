import type {
  ApiCollection,
  ApiEnvironment,
  ApiFolder,
  ApiRequestRow,
  ApiVariable,
} from "../../types/api";

/**
 * The backup file: every workspace's collections, folders, requests and environments in one
 * document, so moving to another machine is one file instead of one export per collection.
 *
 * Two shapes, and the difference is the whole security model:
 *
 * - **With a passphrase** the payload is encrypted *whole* — AES-GCM over the entire JSON, not
 *   field by field. Requests carry auth material (a bearer token, a basic password, an OAuth2
 *   client secret) in places no `secret: true` flag marks, so encrypting only the variables
 *   flagged secret would leave real credentials in the clear while looking like it hadn't. One
 *   envelope has no such gaps.
 * - **Without one** the file is readable JSON with every credential we can identify stripped out:
 *   the values of variables marked secret, and the secret half of every auth block. It restores
 *   the shape of the workspace, not the ability to authenticate with it.
 *
 * The crypto is WebCrypto — PBKDF2-SHA256 to stretch the passphrase, AES-256-GCM to seal. Doing it
 * here rather than in Rust is what keeps the backend free of a crypto dependency: it hands over
 * plain structs and never sees the file.
 */

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export interface BackupWorkspace {
  id: string;
  name: string;
  icon: string;
  color: string;
  collections: ApiCollection[];
  folders: ApiFolder[];
  requests: ApiRequestRow[];
  environments: ApiEnvironment[];
}

export interface ApiBackupPayload {
  workspaces: BackupWorkspace[];
}

export const BACKUP_FORMAT = "codeflow-backup";
export const BACKUP_VERSION = 1;

/** OWASP's floor for PBKDF2-SHA256. Recorded in the file so raising it later can't strand an old backup. */
const PBKDF2_ITERATIONS = 310_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  encrypted: boolean;
  kdf?: { name: "PBKDF2"; hash: "SHA-256"; iterations: number; salt: string };
  cipher?: { name: "AES-GCM"; iv: string };
  /** The payload itself when in the clear; base64 ciphertext when encrypted. */
  data: ApiBackupPayload | string;
}

/** Thrown when the file is encrypted and the caller has no passphrase, or the wrong one. */
export class BackupPassphraseError extends Error {
  /** `true` when a passphrase was supplied and rejected, as opposed to none being supplied at all. */
  readonly wrong: boolean;
  constructor(wrong: boolean) {
    super(wrong ? "wrong passphrase" : "passphrase required");
    this.name = "BackupPassphraseError";
    this.wrong = wrong;
  }
}

// ---------------------------------------------------------------------------
// Stripping credentials out of a plaintext backup
// ---------------------------------------------------------------------------

/**
 * The fields of an `AuthConfig` that hold a credential, per scheme. Enumerated rather than guessed
 * by name so adding a scheme fails visibly here instead of silently exporting its secret.
 */
const AUTH_SECRET_FIELDS: Record<string, string[]> = {
  basic: ["password"],
  digest: ["password"],
  bearer: ["token"],
  apikey: ["value"],
  jwt: ["secret"],
  awsv4: ["secretKey", "sessionToken"],
  oauth2: ["clientSecret", "password", "accessToken", "refreshToken"],
};

function parse<T>(raw: string, fallback: T): T {
  if (raw.trim() === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Blanks the credential fields of a JSON `AuthConfig` column, leaving its shape intact. */
function stripAuth(raw: string): string {
  if (raw.trim() === "") return raw;
  const auth = parse<Record<string, unknown> | null>(raw, null);
  if (!auth || typeof auth !== "object") return raw;
  for (const [scheme, fields] of Object.entries(AUTH_SECRET_FIELDS)) {
    const block = auth[scheme];
    if (!block || typeof block !== "object") continue;
    for (const field of fields) {
      if (field in (block as Record<string, unknown>)) {
        (block as Record<string, unknown>)[field] = "";
      }
    }
  }
  return JSON.stringify(auth);
}

/** Blanks both values of every variable flagged secret, keeping the key so the shape survives. */
function stripVariables(raw: string): string {
  const variables = parse<ApiVariable[]>(raw, []);
  if (!Array.isArray(variables)) return raw;
  return JSON.stringify(
    variables.map((variable) =>
      variable?.secret ? { ...variable, initialValue: "", currentValue: "" } : variable,
    ),
  );
}

function stripSpec(raw: string): string {
  const spec = parse<Record<string, unknown> | null>(raw, null);
  if (!spec || typeof spec !== "object") return raw;
  if (typeof spec.auth === "object" && spec.auth !== null) {
    spec.auth = JSON.parse(stripAuth(JSON.stringify(spec.auth)));
  }
  return JSON.stringify(spec);
}

/**
 * Everything that can be identified as a credential, removed. Note what this cannot reach: a token
 * pasted into a header value, a URL or a saved example response is indistinguishable from any other
 * string. A plaintext backup is for structure — use a passphrase to move working credentials.
 */
function stripSecrets(payload: ApiBackupPayload): ApiBackupPayload {
  return {
    workspaces: payload.workspaces.map((workspace) => ({
      ...workspace,
      collections: workspace.collections.map((collection) => ({
        ...collection,
        auth: stripAuth(collection.auth),
        variables: stripVariables(collection.variables),
      })),
      folders: workspace.folders.map((folder) => ({ ...folder, auth: stripAuth(folder.auth) })),
      requests: workspace.requests.map((request) => ({ ...request, spec: stripSpec(request.spec) })),
      environments: workspace.environments.map((environment) => ({
        ...environment,
        variables: stripVariables(environment.variables),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// ---------------------------------------------------------------------------
// Write / read
// ---------------------------------------------------------------------------

/**
 * Serialises a payload into the text that gets written to disk. An empty `passphrase` means the
 * plaintext-with-credentials-stripped variant.
 */
export async function buildBackupFile(
  payload: ApiBackupPayload,
  passphrase: string,
): Promise<string> {
  const base = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
  } as const;

  if (passphrase === "") {
    const file: BackupFile = { ...base, encrypted: false, data: stripSecrets(payload) };
    return JSON.stringify(file, null, 2);
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );

  const file: BackupFile = {
    ...base,
    encrypted: true,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: "AES-GCM", iv: toBase64(iv) },
    data: toBase64(new Uint8Array(sealed)),
  };
  return JSON.stringify(file, null, 2);
}

function parseFile(text: string): BackupFile {
  let file: BackupFile;
  try {
    file = JSON.parse(text) as BackupFile;
  } catch {
    throw new Error("not a CodeFlow backup file");
  }
  if (file?.format !== BACKUP_FORMAT) throw new Error("not a CodeFlow backup file");
  // A file from a future version may hold fields this build would silently drop on the round trip
  // back out, so it is refused rather than half-read.
  if (typeof file.version !== "number" || file.version > BACKUP_VERSION) {
    throw new Error(`backup version ${String(file.version)} is newer than this app understands`);
  }
  return file;
}

/** Whether a file needs a passphrase — asked before prompting for one, so the prompt is honest. */
export function backupIsEncrypted(text: string): boolean {
  return parseFile(text).encrypted === true;
}

/** When the file was written, for the "last backup" line in settings. */
export function backupExportedAt(text: string): string {
  return parseFile(text).exportedAt ?? "";
}

/**
 * Reads a backup back into a payload. Throws `BackupPassphraseError` when the file is sealed and
 * the passphrase is missing or wrong — the two cases the UI has to tell apart.
 */
export async function openBackupFile(text: string, passphrase: string): Promise<ApiBackupPayload> {
  const file = parseFile(text);

  if (!file.encrypted) {
    const payload = file.data as ApiBackupPayload;
    if (!payload || !Array.isArray(payload.workspaces)) throw new Error("backup file has no workspaces");
    return payload;
  }

  if (passphrase === "") throw new BackupPassphraseError(false);
  if (!file.kdf || !file.cipher || typeof file.data !== "string") {
    throw new Error("backup file is encrypted but incomplete");
  }

  const key = await deriveKey(passphrase, fromBase64(file.kdf.salt), file.kdf.iterations);
  let opened: ArrayBuffer;
  try {
    opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(file.cipher.iv) as BufferSource },
      key,
      fromBase64(file.data) as BufferSource,
    );
  } catch {
    // GCM authenticates as it decrypts, so a failure here is a wrong passphrase or a tampered
    // file; neither is recoverable and neither is worth telling apart.
    throw new BackupPassphraseError(true);
  }

  const payload = JSON.parse(new TextDecoder().decode(opened)) as ApiBackupPayload;
  if (!payload || !Array.isArray(payload.workspaces)) throw new Error("backup file has no workspaces");
  return payload;
}

/** `2026-07-28` — the date goes in the filename so successive manual exports don't collide. */
export function backupFileName(): string {
  return `codeflow-api-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

/**
 * The synced backup's name in Drive — fixed, and deliberately undated: it is one file kept up to
 * date, and it is also how a second machine recognises the first one's backup.
 */
export const DRIVE_BACKUP_NAME = "codeflow-api-backup.json";
