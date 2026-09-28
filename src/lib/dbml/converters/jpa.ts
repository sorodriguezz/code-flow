import type { DbmlSchema } from "../types";
import {
  banner,
  baseType,
  camel,
  codeName,
  codegenRefs,
  compositeKey,
  defaultOf,
  findingLines,
  incoming,
  isComposite,
  isKeyColumn,
  lengthOf,
  NOTHING_TO_CONVERT,
  outgoing,
  pascal,
  relationStem,
  type CodegenRef,
} from "./shared";
import { sqlDefault } from "./sql";

/** The field a relation is held in: `author_id` → `author`. */
function property(ref: CodegenRef): string {
  return camel(relationStem(ref).replace(/_(id|fk|key)$/i, "")) || camel(ref.pkTable.name);
}

/**
 * The join annotation: one `@JoinColumn`, or `@JoinColumns` for a composite key. `readOnly` when a
 * column of the join is also an `@Id` field: JPA refuses a column mapped writable twice, so the
 * relation reads it and the key writes it.
 */
function joinAnnotation(ref: CodegenRef, readOnly: boolean): string[] {
  const extra = readOnly ? ", insertable = false, updatable = false" : "";
  if (!isComposite(ref)) {
    return [`    @JoinColumn(name = "${ref.fkFields[0]}", referencedColumnName = "${ref.pkFields[0]}"${extra})`];
  }
  return [
    "    @JoinColumns({",
    ...ref.fkFields.map(
      (name, at) =>
        `        @JoinColumn(name = "${name}", referencedColumnName = "${ref.pkFields[at]}"${extra})${at < ref.fkFields.length - 1 ? "," : ""}`,
    ),
    "    })",
  ];
}

function javaType(type: string, notNull: boolean, pk: boolean): string {
  switch (baseType(type)) {
    case "int": case "integer": case "smallint": case "serial":
      // A primitive cannot be null, so a nullable column must be the boxed type — getting this
      // backwards is how a JPA entity silently turns a missing value into a zero.
      return pk || notNull ? "int" : "Integer";
    case "bigint": case "bigserial":
      return pk || notNull ? "long" : "Long";
    case "float": case "real":
      return notNull ? "float" : "Float";
    case "double": case "decimal": case "numeric":
      return "BigDecimal";
    case "boolean": case "bool":
      return notNull ? "boolean" : "Boolean";
    case "date":
      return "LocalDate";
    case "datetime": case "timestamp":
      return "LocalDateTime";
    case "uuid":
      return "UUID";
    default:
      return "String";
  }
}

function importsFor(type: string): string[] {
  switch (baseType(type)) {
    case "double": case "decimal": case "numeric": return ["java.math.BigDecimal"];
    case "date": return ["java.time.LocalDate"];
    case "datetime": case "timestamp": return ["java.time.LocalDateTime"];
    case "uuid": return ["java.util.UUID"];
    default: return [];
  }
}

/**
 * JPA entities.
 *
 * **A foreign-key column is emitted once, as a relationship, not twice.** A `@ManyToOne` already
 * maps `author_id`; declaring an `Integer authorId` beside it maps the same column a second time,
 * and Hibernate refuses the entity unless one of them is marked read-only. So the raw column is
 * skipped wherever a join takes its place.
 */
export function toJpa(schema: DbmlSchema): string {
  if (schema.tables.length === 0) return NOTHING_TO_CONVERT;
  const refs = codegenRefs(schema);

  const classes = schema.tables.map((table) => {
    const cls = pascal(codeName(table));
    const imports = new Set<string>(["jakarta.persistence.*", "java.io.Serializable"]);
    const body: string[] = [];

    const out = outgoing(refs, table);
    const back = incoming(refs, table);
    const mapped = new Set(
      out.filter((ref) => ref.kind !== "many-to-many").flatMap((ref) => ref.fkFields),
    );
    const composite = compositeKey(table);
    const keyFields: string[] = [];

    for (const field of table.fields) {
      const key = isKeyColumn(table, field);
      const type = javaType(field.type, field.notNull, key);
      for (const entry of importsFor(field.type)) imports.add(entry);

      // A key column is always its own `@Id` field, even when a relation also joins on it — see
      // `joinAnnotation`'s `readOnly`.
      if (key) {
        body.push("    @Id");
        if (field.increment) body.push("    @GeneratedValue(strategy = GenerationType.IDENTITY)");
        body.push(`    @Column(name = "${field.name}")`);
        body.push(`    private ${type} ${camel(field.name)};`, "");
        keyFields.push(`        private ${type} ${camel(field.name)};`);
        continue;
      }
      if (mapped.has(field.name)) continue;

      const attributes = [`name = "${field.name}"`];
      if (field.notNull) attributes.push("nullable = false");
      if (field.unique) attributes.push("unique = true");
      const base = baseType(field.type);
      const length = lengthOf(field.type);
      if (length && (base === "varchar" || base === "char")) attributes.push(`length = ${length}`);
      if (base === "text") attributes.push('columnDefinition = "TEXT"');
      body.push(`    @Column(${attributes.join(", ")})`);
      // JPA has no portable way to declare a default, so it is noted rather than dropped — written
      // as the SQL it is, not with DBML's backticks.
      const value = defaultOf(field);
      if (value) body.push(`    // default: ${sqlDefault(value, "postgresql")}`);
      body.push(`    private ${type} ${camel(field.name)};`, "");
    }

    for (const ref of out) {
      const target = pascal(codeName(ref.pkTable));
      if (ref.kind === "many-to-many") {
        imports.add("java.util.List");
        body.push("    @ManyToMany");
        body.push("    @JoinTable(");
        body.push(`        name = "${table.name}_${ref.pkTable.name}",`);
        body.push(`        joinColumns = @JoinColumn(name = "${ref.fkFields[0]}"),`);
        body.push(`        inverseJoinColumns = @JoinColumn(name = "${ref.pkFields[0]}")`);
        body.push("    )");
        body.push(`    private List<${target}> ${camel(ref.pkTable.name)}List;`, "");
        continue;
      }
      body.push(`    @${ref.kind === "one-to-one" ? "OneToOne" : "ManyToOne"}(fetch = FetchType.LAZY)`);
      body.push(
        ...joinAnnotation(
          ref,
          ref.fkFields.some((name) => {
            const field = table.fields.find((entry) => entry.name === name);
            return field !== undefined && isKeyColumn(table, field);
          }),
        ),
      );
      body.push(`    private ${target} ${property(ref)};`, "");
    }

    for (const ref of back) {
      const source = pascal(codeName(ref.fkTable));
      const owner = property(ref);
      if (ref.kind === "many-to-many") {
        imports.add("java.util.List");
        body.push(`    @ManyToMany(mappedBy = "${camel(table.name)}List")`);
        body.push(`    private List<${source}> ${camel(ref.fkTable.name)}List;`, "");
      } else if (ref.kind === "one-to-one") {
        body.push(`    @OneToOne(mappedBy = "${owner}")`);
        body.push(`    private ${source} ${camel(ref.fkTable.name)};`, "");
      } else {
        imports.add("java.util.List");
        body.push(`    @OneToMany(mappedBy = "${owner}", cascade = CascadeType.ALL, orphanRemoval = true)`);
        body.push(`    private List<${source}> ${camel(ref.fkTable.name)}List;`, "");
      }
    }

    // JPA declares a key over several columns as a class of its own, named by `@IdClass`.
    if (composite) {
      body.push(
        "",
        "    /** The composite key, as `@IdClass` requires. Give it equals() and hashCode() over every field. */",
        "    public static class Key implements Serializable {",
        ...keyFields,
        "    }",
      );
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();

    return [
      `// ${cls}.java`,
      "package com.example.model;",
      "",
      ...[...imports].sort().map((entry) => `import ${entry};`),
      "",
      "@Entity",
      table.schema === "public"
        ? `@Table(name = "${table.name}")`
        : `@Table(name = "${table.name}", schema = "${table.schema}")`,
      ...(composite ? [`@IdClass(${cls}.Key.class)`] : []),
      `public class ${cls} implements Serializable {`,
      "",
      ...body,
      "",
      "    // Getters and setters omitted — use Lombok's @Data or generate them.",
      "}",
    ].join("\n");
  });

  return (
    [banner("JPA entities"), "", ...findingLines(schema), classes.join(`\n\n// ${"─".repeat(64)}\n\n`)].join(
      "\n",
    ) + "\n"
  );
}
