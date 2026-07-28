/**
 * The GraphQL half of the API client: the introspection query, a typed model of its result, and
 * the two things the editor does with that model — build a skeleton for a root field, and answer
 * "which type is the cursor inside?" for completions.
 *
 * Deliberately dependency-free — no `graphql` package, no Monaco, no stores. A schema is a plain
 * JSON document, and the parsing here is a few hundred lines against ~500 kB of graphql-js for a
 * panel that only ever *reads* the schema. Keeping Monaco out is what lets the completion
 * provider live next to the component that owns the editor, where the tab→schema lookup is.
 */

// ---------------------------------------------------------------------------
// The schema model
// ---------------------------------------------------------------------------

export type GqlTypeKind =
  | "SCALAR"
  | "OBJECT"
  | "INTERFACE"
  | "UNION"
  | "ENUM"
  | "INPUT_OBJECT"
  | "LIST"
  | "NON_NULL";

/** A type *reference*: `[User!]!` is three of these nested through `ofType`. */
export interface GqlTypeRef {
  kind: GqlTypeKind;
  /** `null` for the LIST/NON_NULL wrappers — only the innermost node is named. */
  name: string | null;
  ofType: GqlTypeRef | null;
}

export interface GqlInputValue {
  name: string;
  description: string;
  type: GqlTypeRef;
  defaultValue: string | null;
}

export interface GqlField {
  name: string;
  description: string;
  args: GqlInputValue[];
  type: GqlTypeRef;
  isDeprecated: boolean;
}

export interface GqlEnumValue {
  name: string;
  description: string;
}

export interface GqlType {
  kind: GqlTypeKind;
  name: string;
  description: string;
  fields: GqlField[];
  inputFields: GqlInputValue[];
  enumValues: GqlEnumValue[];
  interfaces: string[];
  possibleTypes: string[];
}

export interface GraphqlSchema {
  queryType: string | null;
  mutationType: string | null;
  subscriptionType: string | null;
  /** Introspection order, minus the `__`-prefixed meta types nobody browses. */
  types: GqlType[];
  /** Name → type. The cursor walk resolves one type per nesting level, so a linear scan per hop
   * would be quadratic in a schema with a few thousand types. */
  byName: Record<string, GqlType>;
}

export type GqlOperation = "query" | "mutation" | "subscription";

export const GQL_OPERATIONS: GqlOperation[] = ["query", "mutation", "subscription"];

// ---------------------------------------------------------------------------
// Introspection
// ---------------------------------------------------------------------------

/**
 * The standard introspection query, trimmed to what this UI shows: no `directives`, no
 * `specifiedByURL`, no deprecation reasons. The `TypeRef` fragment is unrolled seven levels
 * deep because introspection has no recursive fragments — seven covers `[[Type!]!]!` and then
 * some, which is what every client ships.
 */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
  }
}
fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) { name description }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}
fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType { kind name ofType { kind name ofType { kind name } } }
        }
      }
    }
  }
}
`;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseTypeRef(value: unknown): GqlTypeRef {
  const row = record(value);
  if (!row) return { kind: "SCALAR", name: null, ofType: null };
  return {
    kind: (text(row.kind) || "SCALAR") as GqlTypeKind,
    name: typeof row.name === "string" ? row.name : null,
    ofType: row.ofType == null ? null : parseTypeRef(row.ofType),
  };
}

function parseInputValue(value: unknown): GqlInputValue {
  const row = record(value) ?? {};
  return {
    name: text(row.name),
    description: text(row.description),
    type: parseTypeRef(row.type),
    defaultValue: typeof row.defaultValue === "string" ? row.defaultValue : null,
  };
}

function parseField(value: unknown): GqlField {
  const row = record(value) ?? {};
  return {
    name: text(row.name),
    description: text(row.description),
    args: list(row.args).map(parseInputValue),
    type: parseTypeRef(row.type),
    isDeprecated: row.isDeprecated === true,
  };
}

function parseType(value: unknown): GqlType | null {
  const row = record(value);
  const name = text(row?.name);
  // An unnamed entry is a wrapper leaking out of a malformed response; there's nothing to browse.
  if (!row || !name) return null;
  return {
    kind: (text(row.kind) || "OBJECT") as GqlTypeKind,
    name,
    description: text(row.description),
    fields: list(row.fields).map(parseField),
    inputFields: list(row.inputFields).map(parseInputValue),
    enumValues: list(row.enumValues).map((entry) => {
      const enumRow = record(entry) ?? {};
      return { name: text(enumRow.name), description: text(enumRow.description) };
    }),
    interfaces: list(row.interfaces)
      .map((entry) => text(record(entry)?.name))
      .filter(Boolean),
    possibleTypes: list(row.possibleTypes)
      .map((entry) => text(record(entry)?.name))
      .filter(Boolean),
  };
}

/**
 * Turns an introspection response body into a schema, or throws with a message worth showing.
 *
 * A GraphQL server answers a rejected introspection with HTTP 200 and an `errors` array, so the
 * status code says nothing — the payload is the only place the failure is visible, and reporting
 * "introspection may be disabled" beats a silent empty explorer.
 */
export function parseIntrospection(bodyText: string): GraphqlSchema {
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error("the response is not JSON");
  }

  const root = record(payload);
  const errors = list(root?.errors)
    .map((entry) => text(record(entry)?.message))
    .filter(Boolean);
  if (errors.length > 0) throw new Error(errors.join("; "));

  const schema = record(record(root?.data)?.__schema);
  if (!schema) throw new Error("the response carries no __schema — introspection may be disabled");

  const types = list(schema.types)
    .map(parseType)
    .filter((type): type is GqlType => type !== null && !type.name.startsWith("__"));

  return {
    queryType: text(record(schema.queryType)?.name) || null,
    mutationType: text(record(schema.mutationType)?.name) || null,
    subscriptionType: text(record(schema.subscriptionType)?.name) || null,
    types,
    byName: Object.fromEntries(types.map((type) => [type.name, type])),
  };
}

// ---------------------------------------------------------------------------
// Reading the model
// ---------------------------------------------------------------------------

export function rootTypeName(schema: GraphqlSchema, operation: GqlOperation): string | null {
  switch (operation) {
    case "query":
      return schema.queryType;
    case "mutation":
      return schema.mutationType;
    case "subscription":
      return schema.subscriptionType;
  }
}

export function rootType(schema: GraphqlSchema, operation: GqlOperation): GqlType | null {
  const name = rootTypeName(schema, operation);
  return name ? (schema.byName[name] ?? null) : null;
}

/** `[User!]!` → `User`; `null` only for a reference with no named node at all. */
export function namedTypeOf(ref: GqlTypeRef): string | null {
  let current: GqlTypeRef | null = ref;
  while (current) {
    if (current.name) return current.name;
    current = current.ofType;
  }
  return null;
}

/** The reference as it is written in a schema — `[User!]!`. */
export function renderTypeRef(ref: GqlTypeRef): string {
  switch (ref.kind) {
    case "NON_NULL":
      return `${ref.ofType ? renderTypeRef(ref.ofType) : "?"}!`;
    case "LIST":
      return `[${ref.ofType ? renderTypeRef(ref.ofType) : "?"}]`;
    default:
      return ref.name ?? "?";
  }
}

/** A field that needs no sub-selection: its named type is a scalar, an enum, or unknown to us. */
function isLeafRef(schema: GraphqlSchema, ref: GqlTypeRef): boolean {
  const name = namedTypeOf(ref);
  const type = name ? schema.byName[name] : undefined;
  return !type || type.kind === "SCALAR" || type.kind === "ENUM";
}

// ---------------------------------------------------------------------------
// Skeleton generation
// ---------------------------------------------------------------------------

/** Enough to show the shape without pasting a 200-field object into the editor. */
const MAX_SKELETON_FIELDS = 12;

function capitalize(name: string): string {
  return name.length === 0 ? name : name[0].toUpperCase() + name.slice(1);
}

/**
 * One level of sub-selection: the leaf fields of `ref`'s type that take no required arguments.
 *
 * Only one level deep on purpose — expanding recursively hits the first self-referential type
 * (`User.friends: [User!]`) and never comes back, and a skeleton is a starting point, not the
 * query someone meant to write.
 */
function selectionFor(schema: GraphqlSchema, ref: GqlTypeRef, indent: string): string {
  if (isLeafRef(schema, ref)) return "";
  const name = namedTypeOf(ref);
  const type = name ? schema.byName[name] : undefined;
  const leaves = (type?.fields ?? [])
    .filter((field) => isLeafRef(schema, field.type))
    .filter((field) => field.args.every((arg) => arg.type.kind !== "NON_NULL"))
    .slice(0, MAX_SKELETON_FIELDS)
    .map((field) => field.name);
  // A union — or an object whose fields all need arguments — still needs *something* selected.
  const selected = leaves.length > 0 ? leaves : ["__typename"];
  const closing = indent.slice(2);
  return ` {\n${selected.map((field) => indent + field).join("\n")}\n${closing}}`;
}

/**
 * A runnable operation for one root field: required arguments become operation variables (an
 * inline literal would need a value we can't invent), optional ones are left out.
 */
export function fieldSkeleton(schema: GraphqlSchema, operation: GqlOperation, field: GqlField): string {
  const required = field.args.filter((arg) => arg.type.kind === "NON_NULL");
  const declarations = required.map((arg) => `$${arg.name}: ${renderTypeRef(arg.type)}`).join(", ");
  const passed = required.map((arg) => `${arg.name}: $${arg.name}`).join(", ");
  const name = `${capitalize(field.name)}${capitalize(operation)}`;
  return [
    `${operation} ${name}${declarations ? `(${declarations})` : ""} {`,
    `  ${field.name}${passed ? `(${passed})` : ""}${selectionFor(schema, field.type, "    ")}`,
    "}",
    "",
  ].join("\n");
}

/** The `{}` JSON object a skeleton's variables would go in, pre-filled with the argument names. */
export function variablesSkeleton(field: GqlField): string {
  const required = field.args.filter((arg) => arg.type.kind === "NON_NULL");
  if (required.length === 0) return "{}";
  return `{\n${required.map((arg) => `  "${arg.name}": null`).join(",\n")}\n}`;
}

// ---------------------------------------------------------------------------
// Where is the cursor?
// ---------------------------------------------------------------------------

/**
 * Block strings, strings, comments, the spread, names, and single-character punctuation — in that
 * order, so a `#` inside a string is never mistaken for a comment.
 */
const GRAPHQL_TOKEN = /"""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|#[^\n]*|\.\.\.|[A-Za-z_][A-Za-z0-9_]*|\S/g;

/**
 * The type whose fields are valid at the end of `textBeforeCursor`, or `null` when the cursor
 * isn't inside a selection set (or is inside one this schema can't explain).
 *
 * Walks the whole document rather than the current line because that's the only way to know which
 * operation — or which fragment's type condition — the cursor is in. Arguments are skipped
 * wholesale: nothing inside `( … )` can open a selection set, so tracking one paren depth is
 * enough to keep `first: 10` from being read as a field named `first`.
 */
export function typeAtCursor(schema: GraphqlSchema, textBeforeCursor: string): GqlType | null {
  const stack: (GqlType | null)[] = [];
  let parenDepth = 0;
  /** The last name seen at this level — the field whose type the next `{` descends into. */
  let lastName: string | null = null;
  /** `on` was just read, so the next name is a type condition rather than a field. */
  let expectingTypeCondition = false;
  /** An operation keyword or a type condition already decided what the next `{` opens. */
  let pending: { type: string | null } | null = null;

  for (const match of textBeforeCursor.matchAll(GRAPHQL_TOKEN)) {
    const token = match[0];
    if (token.startsWith("#") || token.startsWith('"')) continue;

    if (parenDepth > 0) {
      if (token === "(") parenDepth++;
      else if (token === ")") parenDepth--;
      continue;
    }

    switch (token) {
      case "(":
        parenDepth = 1;
        break;
      case "{":
        stack.push(resolveBrace(schema, stack, pending, lastName));
        lastName = null;
        pending = null;
        break;
      case "}":
        stack.pop();
        lastName = null;
        pending = null;
        break;
      default: {
        if (!/^[A-Za-z_]/.test(token)) break;
        if (expectingTypeCondition) {
          pending = { type: token };
          expectingTypeCondition = false;
        } else if (token === "on") {
          expectingTypeCondition = true;
        } else if (stack.length === 0 && isOperationKeyword(token)) {
          pending = { type: rootTypeName(schema, token) };
        } else {
          lastName = token;
        }
      }
    }
  }

  return stack.length === 0 ? null : stack[stack.length - 1];
}

function isOperationKeyword(token: string): token is GqlOperation {
  return token === "query" || token === "mutation" || token === "subscription";
}

function resolveBrace(
  schema: GraphqlSchema,
  stack: (GqlType | null)[],
  pending: { type: string | null } | null,
  lastName: string | null,
): GqlType | null {
  // An explicit operation keyword or `... on Type` outranks anything inferred: a `mutation {` in a
  // schema without a mutation root really does open nothing, and falling back to Query there would
  // suggest fields that don't exist.
  if (pending) return pending.type ? (schema.byName[pending.type] ?? null) : null;

  // A bare `{` at the top of a document is the shorthand for an anonymous query.
  if (stack.length === 0) {
    return schema.queryType ? (schema.byName[schema.queryType] ?? null) : null;
  }

  const parent = stack[stack.length - 1];
  if (!parent || !lastName) return null;
  const field = parent.fields.find((candidate) => candidate.name === lastName);
  if (!field) return null;
  const name = namedTypeOf(field.type);
  return name ? (schema.byName[name] ?? null) : null;
}
