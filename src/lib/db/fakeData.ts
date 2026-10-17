import { quoteIdent } from "./sqlTemplates";
import type { DbForeignKey, DbKind, DbNode } from "../../types/database";

/**
 * Plausible rows for a table that has none — the "generate test data" action.
 *
 * Pure: the modal reads the catalog (columns, keys, the parents' existing keys) and hands it here;
 * this decides what each column gets and spells the `INSERT`s. Deterministic for a seed, so the
 * preview the user approved is exactly what runs.
 *
 * Two kinds of choice are made per column, in this order: **what the name says** (`email`,
 * `created_at`, `precio`) and then **what the type allows** (`varchar(12)`, `numeric(6,2)`). The
 * name picks the generator; the type bounds what it produces — a `first_name` in a `char(3)` still
 * fits, because a value that does not fit is an error the user then has to read about in a batch of
 * a hundred rows.
 *
 * What is left out rather than generated: identity / serial / auto-increment columns (the server
 * numbers them), and columns with a default when the column can take it — `created_at DEFAULT
 * now()` is better at being `now()` than anything invented here.
 */

/** The `INSERT` spelling a connection gets. `generic` is a JDBC engine without a known dialect. */
export type SqlDialect = "postgres" | "mysql" | "sqlserver" | "sqlite" | "oracle" | "iris" | "generic";

export function sqlDialectOf(kind: DbKind): SqlDialect {
  switch (kind) {
    case "postgres":
    case "supabase":
      return "postgres";
    case "mysql":
    case "mariadb":
      return "mysql";
    case "sqlserver":
    case "sqlite":
    case "oracle":
    case "iris":
      return kind;
    default:
      return "generic";
  }
}

/** The `DbKind` whose quoting rule a dialect shares — what `quoteIdent` is asked with. */
export function quotingKind(dialect: SqlDialect): DbKind {
  return dialect === "generic" ? "jdbc" : dialect;
}

// ---------------------------------------------------------------------------
// Columns and types
// ---------------------------------------------------------------------------

export interface FakeColumn {
  name: string;
  /** As the catalog renders it: `character varying(50)`, `numeric(10,2)`, `int(11) unsigned`. */
  type: string;
  nullable: boolean;
  primaryKey: boolean;
  default: string | null;
  /** Numbered by the server — identity, serial, `AUTO_INCREMENT`, a rowid alias. */
  autoIncrement: boolean;
  /** The column it references, when it is a foreign key. */
  ref: { schema: string | null; table: string; column: string } | null;
}

/**
 * The modal's columns from what the explorer reads: column nodes (`dbChildren` on the column folder)
 * and the table's foreign keys. `identity` names the columns a dialect-specific probe found to be
 * identity columns (Postgres keeps that out of the default expression).
 */
export function fakeColumnsOf(
  nodes: DbNode[],
  foreignKeys: DbForeignKey[],
  dialect: SqlDialect,
  identity: string[] = [],
): FakeColumn[] {
  const pkCount = nodes.filter((node) => node.column?.primary_key).length;
  return nodes
    .filter((node) => node.kind === "column")
    .map((node) => {
      const info = node.column;
      const type = info?.data_type ?? "";
      const def = info?.default_value ?? null;
      const fk = foreignKeys.find((key) => key.column === node.name);
      const detail = node.detail.toLowerCase();
      const auto =
        identity.includes(node.name) ||
        /identity|auto_increment|autoincrement|generated/.test(detail) ||
        /nextval\(|identity|iseq\$\$|generated/i.test(def ?? "") ||
        /\b(serial|bigserial|smallserial)\b/i.test(type) ||
        // `INTEGER PRIMARY KEY` is SQLite's rowid alias, which numbers itself.
        (dialect === "sqlite" && !!info?.primary_key && pkCount === 1 && /^integer$/i.test(type.trim())) ||
        // IRIS's own row id, listed as a column of every class-backed table.
        (dialect === "iris" && !!info?.primary_key && node.name.toUpperCase() === "ID" && !fk);
      return {
        name: node.name,
        type,
        nullable: info?.nullable ?? true,
        primaryKey: info?.primary_key ?? false,
        default: def,
        autoIncrement: auto,
        ref: fk ? { schema: fk.ref_schema, table: fk.ref_table, column: fk.ref_column } : null,
      };
    });
}

export type TypeFamily = "int" | "decimal" | "float" | "bool" | "date" | "time" | "timestamp" | "uuid" | "json" | "text" | "array" | "binary" | "other";

export interface ParsedType {
  family: TypeFamily;
  /** Characters a string may hold, when the type caps it. */
  length: number | null;
  precision: number | null;
  scale: number | null;
  /** The largest integer the type holds (signed range). */
  intMax: number;
}

/** Reads a catalog type name into what the generators need to stay inside it. */
export function parseType(raw: string): ParsedType {
  const type = raw.trim().toLowerCase();
  const args = /\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)/.exec(type);
  const first = args ? Number(args[1]) : null;
  const second = args && args[2] !== undefined ? Number(args[2]) : null;
  const base = type.replace(/\(.*?\)/g, "").trim();
  const result = (family: TypeFamily, extra: Partial<ParsedType> = {}): ParsedType => ({
    family,
    length: null,
    precision: null,
    scale: null,
    intMax: 2147483647,
    ...extra,
  });

  if (base.endsWith("[]") || base.startsWith("array")) return result("array");
  if (/^(uuid|uniqueidentifier)$/.test(base)) return result("uuid");
  if (/^jsonb?$/.test(base)) return result("json");
  if (/^(bool|boolean|bit)$/.test(base) || (base === "tinyint" && first === 1)) return result("bool");
  if (/^(bytea|blob|longblob|mediumblob|tinyblob|binary|varbinary|image|raw|long raw|bfile)/.test(base)) {
    return result("binary");
  }
  if (/^(tinyint)/.test(base)) return result("int", { intMax: base.includes("unsigned") ? 255 : 127 });
  if (/^(smallint|int2|smallserial)/.test(base)) return result("int", { intMax: 32767 });
  if (/^(mediumint)/.test(base)) return result("int", { intMax: 8388607 });
  if (/^(bigint|int8|bigserial)/.test(base)) return result("int", { intMax: 9007199254740991 });
  if (/^(int|integer|int4|serial)\b/.test(base)) return result("int");
  if (/^(numeric|decimal|number|dec|money|smallmoney)/.test(base)) {
    // Oracle's bare `NUMBER` and `NUMBER(p)` are integers in practice when no scale is given.
    if (base.startsWith("number") && (second === null || second === 0)) {
      return result(first === null ? "decimal" : "int", {
        precision: first,
        scale: second ?? 0,
        intMax: first !== null ? Math.min(10 ** first - 1, 2147483647) : 2147483647,
      });
    }
    return result("decimal", { precision: first, scale: second ?? (base.includes("money") ? 2 : 0) });
  }
  if (/^(real|float|double|float4|float8|binary_float|binary_double)/.test(base)) return result("float");
  if (/^(timestamp|datetime|datetime2|smalldatetime|datetimeoffset)/.test(base)) return result("timestamp");
  if (/^date$/.test(base)) return result("date");
  if (/^time/.test(base)) return result("time");
  if (/^(char|character|nchar|varchar|nvarchar|varchar2|nvarchar2|character varying|text|ntext|tinytext|mediumtext|longtext|clob|nclob|string|citext|varying)/.test(base)) {
    return result("text", { length: first });
  }
  if (/^(xml|geometry|geography|point|polygon|hierarchyid|interval|tsvector|inet|cidr|macaddr|enum|set|year)/.test(base)) {
    if (base === "year") return result("int", { intMax: 2155 });
    return result("other");
  }
  return result("text", { length: first });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

export type GeneratorKind =
  | "skip"
  | "null"
  | "fk"
  | "sequence"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "timestamp"
  | "time"
  | "uuid"
  | "json"
  | "array"
  | "email"
  | "firstName"
  | "lastName"
  | "fullName"
  | "username"
  | "phone"
  | "city"
  | "country"
  | "address"
  | "postalCode"
  | "url"
  | "company"
  | "price"
  | "quantity"
  | "age"
  | "status"
  | "title"
  | "description"
  | "code"
  | "color"
  | "latitude"
  | "longitude"
  | "word";

/** Every generator a column can be switched to, in the order the picker lists them. */
export const GENERATOR_KINDS: GeneratorKind[] = [
  "skip",
  "null",
  "fk",
  "sequence",
  "integer",
  "decimal",
  "boolean",
  "date",
  "timestamp",
  "time",
  "uuid",
  "json",
  "array",
  "email",
  "firstName",
  "lastName",
  "fullName",
  "username",
  "phone",
  "city",
  "country",
  "address",
  "postalCode",
  "url",
  "company",
  "price",
  "quantity",
  "age",
  "status",
  "title",
  "description",
  "code",
  "color",
  "latitude",
  "longitude",
  "word",
];

/** Column-name patterns, first match wins. Spanish and English, because the schemas are both. */
const NAME_RULES: [RegExp, GeneratorKind][] = [
  [/(^|_)(uuid|guid)$/, "uuid"],
  [/e_?mail|correo/, "email"],
  [/^(first_?name|given_?name|nombres?|primer_nombre)$/, "firstName"],
  [/^(last_?name|surname|family_?name|apellidos?|apellido_paterno|apellido_materno)$/, "lastName"],
  [/^(full_?name|display_?name|nombre_completo|name|contact_?name|customer_?name|author)$/, "fullName"],
  [/^(user_?name|login|usuario|nick(name)?|handle)$/, "username"],
  [/phone|mobile|telefono|tel$|^tel_|celular|movil|fax/, "phone"],
  [/^(city|ciudad|town|comuna|localidad|municipio)$/, "city"],
  [/^(country|pais|nation)(_name)?$/, "country"],
  [/address|direccion|street|calle|domicilio/, "address"],
  [/zip|postal|postcode|codigo_postal/, "postalCode"],
  [/url|website|web_?site|link|sitio|homepage|avatar|image|imagen|photo|foto/, "url"],
  [/company|empresa|organi[sz]ation|organizacion|employer|razon_social/, "company"],
  [/price|amount|total|cost|monto|precio|importe|salary|sueldo|salario|balance|saldo|fee|tarifa|subtotal|tax|impuesto/, "price"],
  [/quantity|qty|cantidad|stock|units|unidades|(^|_)count$/, "quantity"],
  [/^(age|edad)$/, "age"],
  [/(^|_)(status|estado|state)$/, "status"],
  [/(^|_)(title|titulo|subject|asunto|headline)$/, "title"],
  [/description|descripcion|notes?$|notas?$|comment|comentario|bio|summary|resumen|detalle|observacion|body|content|contenido|text$|texto$/, "description"],
  [/(^|_)(code|codigo|sku|ref|reference|referencia|slug)$/, "code"],
  [/colou?r/, "color"],
  [/^(lat|latitude|latitud)$/, "latitude"],
  [/^(lng|lon|long|longitude|longitud)$/, "longitude"],
];

/** Which generator a column gets before the user changes anything. */
export function chooseGenerator(column: FakeColumn): GeneratorKind {
  const type = parseType(column.type);
  if (column.autoIncrement) return "skip";
  if (column.ref) return "fk";
  // A default the server would rather supply, on a column that may be left out. Keys are kept: a
  // default on a key is usually a sequence the catalog spelled some other way, and generating it
  // would collide with the next value the server hands out.
  if (column.default !== null && !column.primaryKey) return "skip";
  if (column.default !== null && column.primaryKey && type.family === "int") return "skip";
  if (column.default !== null && column.primaryKey && type.family === "uuid") return "skip";

  const name = column.name.toLowerCase();
  if (type.family === "uuid") return "uuid";
  if (type.family === "json") return "json";
  if (type.family === "array") return "array";
  if (type.family === "binary" || type.family === "other") return column.nullable ? "null" : "skip";
  if (type.family === "bool" || /^(is|has|can|should|es|tiene)_|(^|_)(active|activo|enabled|habilitado|deleted|eliminado|flag|verified|verificado|visible|published|publicado)$/.test(name)) {
    if (type.family === "bool" || type.family === "int") return "boolean";
  }
  if (type.family === "int" && column.primaryKey) return "sequence";
  if (type.family === "date") return "date";
  if (type.family === "timestamp") return "timestamp";
  if (type.family === "time") return "time";

  for (const [pattern, kind] of NAME_RULES) {
    if (!pattern.test(name)) continue;
    if (fitsFamily(kind, type.family)) return kind;
  }
  if (/(_at|_on|_date|^date|fecha|_fecha|^fec_|timestamp)$/.test(name) || /^(fecha|date)/.test(name)) {
    if (type.family === "text") return "timestamp";
  }
  switch (type.family) {
    case "int":
      return "integer";
    case "decimal":
    case "float":
      return "decimal";
    default:
      return column.primaryKey ? "code" : "word";
  }
}

/** Whether a name-chosen generator produces something the column's type can hold. */
function fitsFamily(kind: GeneratorKind, family: TypeFamily): boolean {
  switch (kind) {
    case "price":
    case "latitude":
    case "longitude":
      return family === "decimal" || family === "float" || family === "int" || family === "text";
    case "quantity":
    case "age":
      return family === "int" || family === "decimal" || family === "float" || family === "text";
    case "uuid":
      return family === "uuid" || family === "text";
    case "status":
      return family === "text" || family === "int";
    default:
      return family === "text";
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** One generated value, typed enough to be spelled right in each dialect. */
export type FakeValue =
  | { t: "null" }
  | { t: "text"; v: string }
  | { t: "number"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "date"; v: string }
  | { t: "timestamp"; v: string }
  | { t: "time"; v: string };

const NULL: FakeValue = { t: "null" };

/** mulberry32: small, fast, and the same sequence on every machine for the same seed. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  // Spanish
  "Sofía", "Mateo", "Valentina", "Santiago", "Isabella", "Matías", "Camila", "Sebastián", "Martina", "Benjamín",
  "Lucía", "Diego", "Antonella", "Nicolás", "Catalina", "Tomás", "Florencia", "Joaquín", "Javiera", "Agustín",
  "Fernanda", "Vicente", "Constanza", "Cristóbal", "Daniela", "Ignacio", "Paula", "Francisco", "Carolina", "Andrés",
  // English
  "Olivia", "Liam", "Emma", "Noah", "Ava", "Oliver", "Mia", "Elijah", "Charlotte", "James",
  "Amelia", "William", "Harper", "Benjamin", "Evelyn", "Lucas", "Abigail", "Henry", "Emily", "Alexander",
  "Ella", "Jack", "Grace", "Daniel", "Chloe", "Samuel", "Lily", "David", "Hannah", "Joseph",
];

const LAST_NAMES = [
  "González", "Muñoz", "Rojas", "Díaz", "Pérez", "Soto", "Contreras", "Silva", "Martínez", "Sepúlveda",
  "Morales", "Rodríguez", "López", "Fuentes", "Hernández", "Torres", "Araya", "Flores", "Espinoza", "Valenzuela",
  "Castillo", "Tapia", "Reyes", "Gutiérrez", "Castro", "Pizarro", "Álvarez", "Vásquez", "Sánchez", "Fernández",
  "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis", "Wilson", "Anderson", "Taylor",
  "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis",
  "Walker", "Hall", "Allen", "Young", "King", "Wright", "Scott", "Green", "Baker", "Adams",
];

const CITIES = [
  "Santiago", "Valparaíso", "Concepción", "Madrid", "Barcelona", "Buenos Aires", "Lima", "Bogotá", "Ciudad de México",
  "Montevideo", "Quito", "London", "New York", "Toronto", "Sydney", "Dublin", "Chicago", "Seattle", "Austin", "Boston",
];

const COUNTRIES = [
  "Chile", "Argentina", "Perú", "Colombia", "México", "España", "Uruguay", "Ecuador",
  "United States", "Canada", "United Kingdom", "Ireland", "Australia", "Germany", "France", "Brazil",
];

const STREETS = [
  "Av. Providencia", "Calle Los Aromos", "Av. Libertador", "Pasaje Las Rosas", "Calle Mayor", "Av. del Mar",
  "Main Street", "Oak Avenue", "Maple Road", "Park Lane", "Cedar Street", "Elm Drive",
];

const COMPANIES = [
  "Acme", "Globex", "Initech", "Umbrella", "Hooli", "Vandelay", "Stark", "Wayne", "Soylent", "Tyrell",
  "Andes Tech", "Austral Data", "Pacífico Logística", "Cordillera Software", "Patagonia Labs",
];

const SUFFIXES = ["S.A.", "SpA", "Ltda.", "Inc.", "LLC", "Ltd."];

const STATUSES = ["active", "inactive", "pending", "archived", "draft"];

const WORDS = [
  "lorem", "ipsum", "dolor", "sit", "amet", "consectetur", "adipiscing", "elit", "sed", "do", "eiusmod", "tempor",
  "incididunt", "labore", "dolore", "magna", "aliqua", "enim", "minim", "veniam", "quis", "nostrud", "ullamco",
  "laboris", "nisi", "aliquip", "commodo", "consequat", "duis", "aute", "irure", "velit", "esse", "cillum",
];

const COLORS = ["red", "green", "blue", "yellow", "black", "white", "orange", "purple", "gray", "pink"];

/** Everything a row needs besides the column: the PRNG, the row's index, and the values sampled
 * from the parents of its foreign keys. */
interface GenContext {
  random: () => number;
  index: number;
  /** The row's person, so `first_name`, `last_name` and `email` agree with each other. */
  person: { first: string; last: string };
}

function pick<T>(random: () => number, list: T[]): T {
  return list[Math.floor(random() * list.length)];
}

function int(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** ASCII for the parts of a value that end up in an address: an email with `ñ` is legal and still
 * the one row a mail library somewhere chokes on. */
function ascii(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "")
    .toLowerCase();
}

/** Cuts a text to a column's length; a unique value keeps its suffix, which is what makes it unique. */
function fit(text: string, length: number | null, suffix = ""): string {
  if (length === null || length <= 0) return text + suffix;
  if (text.length + suffix.length <= length) return text + suffix;
  if (suffix.length >= length) return suffix.slice(-length);
  return text.slice(0, length - suffix.length) + suffix;
}

function sentence(random: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) out.push(pick(random, WORDS));
  const text = out.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/** 2020-01-01 … 2025-12-31, a day at a time. */
function randomDate(random: () => number): string {
  const start = Date.UTC(2020, 0, 1);
  const day = int(random, 0, 6 * 365 - 1);
  const date = new Date(start + day * 86_400_000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function randomTime(random: () => number): string {
  return `${pad(int(random, 0, 23))}:${pad(int(random, 0, 59))}:${pad(int(random, 0, 59))}`;
}

function uuid(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** A number inside `numeric(p,s)`, at most `ceiling` (prices shouldn't be in the billions just
 * because the column could hold them). */
function decimalIn(random: () => number, type: ParsedType, floor: number, ceiling: number): string {
  const scale = type.family === "int" ? 0 : (type.scale ?? 2);
  const integerDigits = type.precision !== null ? type.precision - scale : null;
  const max = integerDigits !== null ? Math.min(ceiling, 10 ** integerDigits - 10 ** -scale) : ceiling;
  const min = Math.min(floor, max);
  const value = min + random() * (max - min);
  return value.toFixed(Math.max(0, Math.min(scale, 6)));
}

function textValue(text: string, type: ParsedType, unique: boolean, index: number): FakeValue {
  return { t: "text", v: fit(text, type.length, unique ? `_${index + 1}` : "") };
}

/**
 * One value. `unique` is set for key columns: text gains the row's number, numbers count up.
 * `start` is where a sequence begins — one past the table's current maximum, read by the modal.
 */
export function generateValue(
  kind: GeneratorKind,
  column: FakeColumn,
  ctx: GenContext,
  start = 1,
): FakeValue {
  const type = parseType(column.type);
  const { random, index, person } = ctx;
  const unique = column.primaryKey;
  const asNumber = type.family === "int" || type.family === "decimal" || type.family === "float";
  switch (kind) {
    case "skip":
    case "null":
    case "fk":
      return NULL;
    case "sequence":
      if (asNumber) return { t: "number", v: String(start + index) };
      return { t: "text", v: fit(String(start + index), type.length) };
    case "integer": {
      if (unique) return { t: "number", v: String(start + index) };
      const max = Math.min(type.intMax, 100_000);
      if (type.family === "text") return textValue(String(int(random, 1, max)), type, false, index);
      if (type.family === "decimal" || type.family === "float") return { t: "number", v: decimalIn(random, { ...type, scale: 0 }, 1, max) };
      return { t: "number", v: String(int(random, 1, max)) };
    }
    case "decimal":
      if (type.family === "text") return textValue(decimalIn(random, { ...type, precision: null, scale: 2 }, 0, 10_000), type, false, index);
      if (type.family === "int") return { t: "number", v: String(int(random, 0, Math.min(type.intMax, 10_000))) };
      return { t: "number", v: decimalIn(random, type, 0, 10_000) };
    case "boolean": {
      const yes = random() < 0.5;
      if (type.family === "text") return { t: "text", v: fit(yes ? "true" : "false", type.length) };
      return { t: "bool", v: yes };
    }
    case "date":
      if (type.family === "text") return textValue(randomDate(random), type, false, index);
      if (type.family === "timestamp") return { t: "timestamp", v: `${randomDate(random)} 00:00:00` };
      return { t: "date", v: randomDate(random) };
    case "timestamp": {
      const stamp = `${randomDate(random)} ${randomTime(random)}`;
      if (type.family === "text") return textValue(stamp, type, false, index);
      if (type.family === "date") return { t: "date", v: stamp.slice(0, 10) };
      return { t: "timestamp", v: stamp };
    }
    case "time":
      return type.family === "text" ? textValue(randomTime(random), type, false, index) : { t: "time", v: randomTime(random) };
    case "uuid":
      return { t: "text", v: type.family === "text" ? fit(uuid(random), type.length) : uuid(random) };
    case "json":
      return { t: "text", v: "{}" };
    case "array":
      return { t: "text", v: "{}" };
    case "email": {
      const local = `${ascii(person.first)}.${ascii(person.last)}`;
      const domain = pick(random, ["example.com", "example.org", "example.net"]);
      // Always numbered: an email column is unique far more often than the catalog says it is.
      return { t: "text", v: fit(local, type.length === null ? null : type.length - domain.length - 1, String(index + 1)) + "@" + domain };
    }
    case "firstName":
      return textValue(person.first, type, unique, index);
    case "lastName":
      return textValue(person.last, type, unique, index);
    case "fullName":
      return textValue(`${person.first} ${person.last}`, type, unique, index);
    case "username":
      return textValue(`${ascii(person.first)}${ascii(person.last).slice(0, 3)}`, type, true, index);
    case "phone":
      return textValue(`+${pick(random, ["56 9", "34 6", "1 555", "54 9", "52 55"])} ${int(random, 1000, 9999)} ${int(random, 1000, 9999)}`, type, false, index);
    case "city":
      return textValue(pick(random, CITIES), type, unique, index);
    case "country":
      return textValue(pick(random, COUNTRIES), type, unique, index);
    case "address":
      return textValue(`${pick(random, STREETS)} ${int(random, 1, 9999)}`, type, unique, index);
    case "postalCode":
      return textValue(String(int(random, 10000, 99999)), type, unique, index);
    case "url":
      return textValue(`https://example.com/${pick(random, WORDS)}/${index + 1}`, type, false, index);
    case "company":
      return textValue(`${pick(random, COMPANIES)} ${pick(random, SUFFIXES)}`, type, unique, index);
    case "price":
      if (type.family === "int") return { t: "number", v: String(int(random, 1, Math.min(type.intMax, 100_000))) };
      if (type.family === "text") return textValue((1 + random() * 999).toFixed(2), type, false, index);
      return { t: "number", v: decimalIn(random, { ...type, scale: type.scale ?? 2 }, 1, 1_000) };
    case "quantity":
      if (type.family === "text") return textValue(String(int(random, 0, 500)), type, false, index);
      return { t: "number", v: String(int(random, 0, Math.min(500, type.intMax))) };
    case "age":
      if (type.family === "text") return textValue(String(int(random, 18, 80)), type, false, index);
      return { t: "number", v: String(int(random, 18, Math.min(80, type.intMax))) };
    case "status":
      if (type.family === "int") return { t: "number", v: String(int(random, 0, Math.min(3, type.intMax))) };
      return textValue(pick(random, STATUSES), type, unique, index);
    case "title":
      return textValue(sentence(random, int(random, 2, 5)).slice(0, -1), type, unique, index);
    case "description":
      return textValue(sentence(random, int(random, 6, 14)), type, unique, index);
    case "code":
      return textValue(`${pick(random, ["A", "B", "C", "X", "Z"])}${pad(int(random, 0, 9999), 4)}`, type, true, index);
    case "color":
      return textValue(pick(random, COLORS), type, unique, index);
    case "latitude":
      if (type.family === "text") return textValue((random() * 180 - 90).toFixed(6), type, false, index);
      return { t: "number", v: (random() * 180 - 90).toFixed(Math.min(6, type.scale ?? 6)) };
    case "longitude":
      if (type.family === "text") return textValue((random() * 360 - 180).toFixed(6), type, false, index);
      return { t: "number", v: (random() * 360 - 180).toFixed(Math.min(6, type.scale ?? 6)) };
    case "word":
      if (asNumber) return { t: "number", v: String(int(random, 1, Math.min(type.intMax, 1000))) };
      return textValue(pick(random, WORDS), type, unique, index);
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** What each column does, as the user left it. */
export interface ColumnPlan {
  column: FakeColumn;
  generator: GeneratorKind;
  /** First value of a `sequence` (or a unique `integer`). */
  start?: number;
}

/**
 * Parent keys a foreign key draws from, keyed by the parent table. `columns` are the parent's
 * columns in the order of `rows`; a composite key is sampled as tuples so the pair still exists.
 */
export interface ParentKeys {
  columns: string[];
  rows: (string | null)[][];
}

/** The parent a foreign key column points at, as one key — how `ParentKeys` are looked up. */
export function parentKeyOf(ref: { schema: string | null; table: string }): string {
  return `${ref.schema ?? ""}.${ref.table}`;
}

/**
 * Why the table can't be filled, when it can't: a required foreign key into a parent with no rows.
 * Nullable ones are set to NULL instead — returned as warnings by `planWarnings`.
 */
export function planProblems(plans: ColumnPlan[], parents: Record<string, ParentKeys>): string[] {
  const problems: string[] = [];
  for (const plan of plans) {
    if (plan.generator !== "fk" || !plan.column.ref) continue;
    const keys = parents[parentKeyOf(plan.column.ref)];
    if ((!keys || keys.rows.length === 0) && !plan.column.nullable) problems.push(plan.column.name);
  }
  return problems;
}

/** Nullable foreign keys whose parent is empty — they will be NULL. */
export function planWarnings(plans: ColumnPlan[], parents: Record<string, ParentKeys>): string[] {
  return plans
    .filter((plan) => plan.generator === "fk" && plan.column.ref && plan.column.nullable)
    .filter((plan) => {
      const keys = parents[parentKeyOf(plan.column.ref!)];
      return !keys || keys.rows.length === 0;
    })
    .map((plan) => plan.column.name);
}

/** The columns an `INSERT` names: every one not skipped. */
export function insertedColumns(plans: ColumnPlan[]): ColumnPlan[] {
  return plans.filter((plan) => plan.generator !== "skip");
}

/**
 * `count` rows for the plan, one value per inserted column. The same seed gives the same rows,
 * which is what lets the preview stand for the insert.
 */
export function generateRows(
  plans: ColumnPlan[],
  count: number,
  seed: number,
  parents: Record<string, ParentKeys> = {},
): FakeValue[][] {
  const random = prng(seed);
  const used = insertedColumns(plans);
  const rows: FakeValue[][] = [];
  for (let index = 0; index < count; index += 1) {
    const person = { first: pick(random, FIRST_NAMES), last: pick(random, LAST_NAMES) };
    const ctx: GenContext = { random, index, person };
    // One parent row per parent per generated row, so a composite key's columns stay a real pair.
    const chosen: Record<string, (string | null)[] | null> = {};
    rows.push(
      used.map((plan) => {
        if (plan.generator !== "fk") return generateValue(plan.generator, plan.column, ctx, plan.start ?? 1);
        const ref = plan.column.ref;
        if (!ref) return NULL;
        const key = parentKeyOf(ref);
        const keys = parents[key];
        if (!keys || keys.rows.length === 0) return NULL;
        if (!(key in chosen)) chosen[key] = pick(random, keys.rows);
        const at = keys.columns.indexOf(ref.column);
        const raw = chosen[key]?.[at < 0 ? 0 : at] ?? null;
        if (raw === null) return NULL;
        const family = parseType(plan.column.type).family;
        return family === "int" || family === "decimal" || family === "float" ? { t: "number", v: raw } : { t: "text", v: raw };
      }),
    );
  }
  return rows;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Rows per multi-row `INSERT`. SQL Server caps a `VALUES` list at 1000; a hundred keeps any one
 * failure's statement readable. */
export const INSERT_BATCH = 100;

/** One value as a literal of this dialect. */
export function sqlLiteral(value: FakeValue, dialect: SqlDialect): string {
  switch (value.t) {
    case "null":
      return "NULL";
    case "number":
      return value.v;
    case "bool":
      // Postgres has a real boolean; everywhere else here a flag is a bit / tinyint / NUMBER(1).
      if (dialect === "postgres") return value.v ? "TRUE" : "FALSE";
      return value.v ? "1" : "0";
    case "date":
      return dialect === "oracle" ? `DATE '${value.v}'` : `'${value.v}'`;
    case "timestamp":
      return dialect === "oracle" ? `TIMESTAMP '${value.v}'` : `'${value.v}'`;
    case "time":
      return `'${value.v}'`;
    case "text": {
      let text = value.v.replace(/'/g, "''");
      // MySQL reads backslash escapes inside string literals unless NO_BACKSLASH_ESCAPES is set.
      if (dialect === "mysql") text = text.replace(/\\/g, "\\\\");
      return dialect === "sqlserver" ? `N'${text}'` : `'${text}'`;
    }
  }
}

export interface FakeTable {
  schema: string | null;
  name: string;
}

/**
 * The `INSERT`s, batched where the dialect has a multi-row form: `VALUES (…), (…)` on Postgres,
 * MySQL, SQL Server and SQLite, `INSERT ALL … SELECT 1 FROM DUAL` on Oracle. IRIS and a generic
 * JDBC engine get one statement per row — the only spelling every one of them accepts.
 */
export function insertSql(
  table: FakeTable,
  plans: ColumnPlan[],
  rows: FakeValue[][],
  dialect: SqlDialect,
  batch = INSERT_BATCH,
): string {
  const kind = quotingKind(dialect);
  const target = table.schema
    ? `${quoteIdent(table.schema, kind)}.${quoteIdent(table.name, kind)}`
    : quoteIdent(table.name, kind);
  const used = insertedColumns(plans);
  const tuple = (row: FakeValue[]) => `(${row.map((value) => sqlLiteral(value, dialect)).join(", ")})`;
  const statements: string[] = [];

  if (used.length === 0) {
    // Every column left to the server: the one row shape that names none.
    const single =
      dialect === "mysql" ? `INSERT INTO ${target} () VALUES ()` : dialect === "oracle" ? `INSERT INTO ${target} VALUES (DEFAULT)` : `INSERT INTO ${target} DEFAULT VALUES`;
    for (let i = 0; i < rows.length; i += 1) statements.push(single);
    return statements.map((statement) => `${statement};`).join("\n");
  }

  const names = `(${used.map((plan) => quoteIdent(plan.column.name, kind)).join(", ")})`;
  const multi = dialect === "postgres" || dialect === "mysql" || dialect === "sqlserver" || dialect === "sqlite";
  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    if (multi) {
      statements.push(`INSERT INTO ${target} ${names} VALUES\n  ${chunk.map(tuple).join(",\n  ")}`);
    } else if (dialect === "oracle") {
      statements.push(`INSERT ALL\n${chunk.map((row) => `  INTO ${target} ${names} VALUES ${tuple(row)}`).join("\n")}\nSELECT 1 FROM DUAL`);
    } else {
      for (const row of chunk) statements.push(`INSERT INTO ${target} ${names} VALUES ${tuple(row)}`);
    }
  }
  return statements.map((statement) => `${statement};`).join("\n");
}

/** A value as the preview table shows it — the literal minus the quoting. */
export function displayValue(value: FakeValue): string | null {
  switch (value.t) {
    case "null":
      return null;
    case "bool":
      return value.v ? "true" : "false";
    default:
      return value.v;
  }
}
