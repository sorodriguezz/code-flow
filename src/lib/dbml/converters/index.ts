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
 * What each target is called, what its file is called, and which editor language colours it.
 *
 * One table rather than three switch statements, because these three facts are always wanted
 * together: the tab shows the label, the download uses the extension, and the viewer needs the
 * language. `label` is not translated — these are product names.
 */
export const CONVERSION_TARGETS: {
  id: ConversionTarget;
  label: string;
  extension: string;
  language: string;
}[] = [
  { id: "postgresql", label: "PostgreSQL", extension: "sql", language: "sql" },
  { id: "sqlserver", label: "SQL Server", extension: "sql", language: "sql" },
  { id: "mongodb", label: "Mongoose", extension: "js", language: "javascript" },
  { id: "typeorm", label: "TypeORM", extension: "ts", language: "typescript" },
  { id: "prisma", label: "Prisma", extension: "prisma", language: "prisma" },
  { id: "drizzle", label: "Drizzle", extension: "ts", language: "typescript" },
  { id: "sequelize", label: "Sequelize", extension: "ts", language: "typescript" },
  { id: "jpa", label: "JPA", extension: "java", language: "java" },
  { id: "gorm", label: "GORM", extension: "go", language: "go" },
  { id: "laravel", label: "Laravel", extension: "php", language: "php" },
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
