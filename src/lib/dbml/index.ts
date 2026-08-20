/**
 * Everything about DBML that costs nothing to import.
 *
 * **The parser is deliberately not here.** `@dbml/core` is ~15 MB of JavaScript, and this module is
 * reached from the Database workspace, the editor's file preview and the Diagrams gallery — none of
 * which should pull it in. Anything needing to *read* DBML imports `./parse` dynamically; everything
 * that works on an already-parsed schema imports this.
 *
 * See `parse.ts` for the other half of that rule, written from its side.
 */

export * from "./types";
export * from "./layout";
export * from "./format";
export * from "./diff";
export * from "./merge";
export * from "./errors";
export { sqlToDbml } from "./sqlToDbml";
export { schemaToDbml } from "./fromSchema";
export {
  convert,
  CONVERSION_TARGETS,
  type ConversionTarget,
  type SqlDialect,
} from "./converters";
