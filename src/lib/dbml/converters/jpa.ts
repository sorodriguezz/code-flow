import type { DbmlSchema } from "../types";
import {
  banner,
  baseType,
  camel,
  codeName,
  codegenRefs,
  incoming,
  lengthOf,
  NOTHING_TO_CONVERT,
  outgoing,
  pascal,
} from "./shared";

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
    const mapped = new Set(out.filter((ref) => ref.kind !== "many-to-many").map((ref) => ref.fkField));

    for (const field of table.fields) {
      const type = javaType(field.type, field.notNull, field.pk);
      for (const entry of importsFor(field.type)) imports.add(entry);

      if (field.pk) {
        body.push("    @Id");
        if (field.increment) body.push("    @GeneratedValue(strategy = GenerationType.IDENTITY)");
        body.push(`    @Column(name = "${field.name}")`);
        body.push(`    private ${type} ${camel(field.name)};`, "");
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
      if (field.default !== null) body.push(`    // default: ${field.default}`);
      body.push(`    private ${type} ${camel(field.name)};`, "");
    }

    for (const ref of out) {
      const target = pascal(codeName(ref.pkTable));
      if (ref.kind === "many-to-many") {
        imports.add("java.util.List");
        body.push("    @ManyToMany");
        body.push("    @JoinTable(");
        body.push(`        name = "${table.name}_${ref.pkTable.name}",`);
        body.push(`        joinColumns = @JoinColumn(name = "${ref.fkField}"),`);
        body.push(`        inverseJoinColumns = @JoinColumn(name = "${ref.pkField}")`);
        body.push("    )");
        body.push(`    private List<${target}> ${camel(ref.pkTable.name)}List;`, "");
        continue;
      }
      body.push(`    @${ref.kind === "one-to-one" ? "OneToOne" : "ManyToOne"}(fetch = FetchType.LAZY)`);
      body.push(`    @JoinColumn(name = "${ref.fkField}", referencedColumnName = "${ref.pkField}")`);
      body.push(`    private ${target} ${camel(ref.fkField.replace(/_(id|fk|key)$/i, "")) || camel(ref.pkTable.name)};`, "");
    }

    for (const ref of back) {
      const source = pascal(codeName(ref.fkTable));
      const owner = camel(ref.fkField.replace(/_(id|fk|key)$/i, "")) || camel(table.name);
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
      `public class ${cls} implements Serializable {`,
      "",
      ...body,
      "",
      "    // Getters and setters omitted — use Lombok's @Data or generate them.",
      "}",
    ].join("\n");
  });

  return [banner("JPA entities"), "", classes.join(`\n\n// ${"─".repeat(64)}\n\n`)].join("\n") + "\n";
}
