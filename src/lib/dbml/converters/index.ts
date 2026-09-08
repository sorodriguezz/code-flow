import type { DbmlSchema } from "../types";
import { toDrizzle } from "./drizzle";
import { toGorm } from "./gorm";
import { toJpa } from "./jpa";
import { toLaravel } from "./laravel";
import { toPrisma } from "./prisma";
import { toSequelize } from "./sequelize";
import { toSql } from "./sql";
import { toTypeOrm } from "./typeorm";

export { toDrizzle, toGorm, toJpa, toLaravel, toPrisma, toSequelize, toSql, toTypeOrm };
export type { SqlDialect } from "./sql";

/**
 * Every target a schema can be turned into.
 *
 * The ids are stable — they are persisted as the panel's last choice — so a rename here is a
 * migration, not a rename.
 */
export type ConversionTarget =
  | "postgresql"
  | "sqlserver"
  | "mongodb"
  | "typeorm"
  | "prisma"
  | "drizzle"
  | "sequelize"
  | "jpa"
  | "gorm"
  | "laravel";

/**
 * What kind of thing a target is: a database's own DDL, an ORM's model file, or an ODM's schema.
 *
 * Here rather than in the panel because it is a fact about the target, not about how it is drawn —
 * and because ten flat buttons is a list you read, while three short ones is a choice you make. The
 * ids are the labels: SQL, ORM and ODM are the same three words in every language this app speaks.
 */
export type ConversionKind = "sql" | "orm" | "odm";

/** The groups, in the order the panel offers them. */
export const CONVERSION_KINDS: ConversionKind[] = ["sql", "orm", "odm"];

/**
 * What each target is called, what kind of thing it is, what its file is called, and which editor
 * language colours it.
 *
 * One table rather than four switch statements, because these facts are always wanted together: the
 * tab shows the label under its kind, the download uses the extension, and the viewer needs the
 * language. `label` is not translated — these are product names.
 */
export const CONVERSION_TARGETS: {
  id: ConversionTarget;
  label: string;
  kind: ConversionKind;
  extension: string;
  language: string;
}[] = [
  { id: "postgresql", label: "PostgreSQL", kind: "sql", extension: "sql", language: "sql" },
  { id: "sqlserver", label: "SQL Server", kind: "sql", extension: "sql", language: "sql" },
  { id: "mongodb", label: "Mongoose", kind: "odm", extension: "js", language: "javascript" },
  { id: "typeorm", label: "TypeORM", kind: "orm", extension: "ts", language: "typescript" },
  { id: "prisma", label: "Prisma", kind: "orm", extension: "prisma", language: "prisma" },
  { id: "drizzle", label: "Drizzle", kind: "orm", extension: "ts", language: "typescript" },
  { id: "sequelize", label: "Sequelize", kind: "orm", extension: "ts", language: "typescript" },
  { id: "jpa", label: "JPA", kind: "orm", extension: "java", language: "java" },
  { id: "gorm", label: "GORM", kind: "orm", extension: "go", language: "go" },
  { id: "laravel", label: "Laravel", kind: "orm", extension: "php", language: "php" },
];

/** Generates `target`'s code for `schema`. Pure, and cheap enough to run on every keystroke. */
export function convert(schema: DbmlSchema, target: ConversionTarget): string {
  switch (target) {
    case "postgresql":
      return toSql(schema, "postgresql");
    case "sqlserver":
      return toSql(schema, "sqlserver");
    case "mongodb":
      return toSql(schema, "mongodb");
    case "typeorm":
      return toTypeOrm(schema);
    case "prisma":
      return toPrisma(schema);
    case "drizzle":
      return toDrizzle(schema);
    case "sequelize":
      return toSequelize(schema);
    case "jpa":
      return toJpa(schema);
    case "gorm":
      return toGorm(schema);
    case "laravel":
      return toLaravel(schema);
    default:
      return "";
  }
}
