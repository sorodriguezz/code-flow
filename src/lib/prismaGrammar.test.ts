import { describe, expect, it } from "vitest";
import {
  PRISMA_ATTRIBUTE,
  PRISMA_CONFIG_HEAD,
  PRISMA_ENUM_HEAD,
  PRISMA_FIELD,
  PRISMA_FUNCTION,
  PRISMA_GRAMMAR,
  PRISMA_MODEL_HEAD,
  PRISMA_NAMED_ARG,
} from "./prismaGrammar";

/** What Monarch does with a rule's pattern: match it anchored at the current position. */
const whole = (pattern: RegExp, text: string) => new RegExp(`^(?:${pattern.source})`).exec(text)?.[0] ?? null;
const groups = (pattern: RegExp, text: string) => new RegExp(`^(?:${pattern.source})`).exec(text)?.slice(1) ?? null;

type Rule = [RegExp, unknown, string?] | { include: string };

/** The first rule of a state (includes followed) whose pattern matches `text` at its start. */
function ruleFor(state: string, text: string): [RegExp, unknown, string?] | null {
  const states = PRISMA_GRAMMAR.tokenizer as Record<string, Rule[]>;
  for (const rule of states[state]) {
    if ("include" in rule) {
      const found = ruleFor(rule.include.replace(/^@/, ""), text);
      if (found) return found;
      continue;
    }
    if (new RegExp(`^(?:${rule[0].source})`).test(text)) return rule;
  }
  return null;
}

describe("the Prisma grammar", () => {
  it("opens each kind of block into its own state", () => {
    expect(groups(PRISMA_MODEL_HEAD, "model User {")).toEqual(["model", " ", "User", " ", "{"]);
    expect(groups(PRISMA_MODEL_HEAD, "type Address {")?.[2]).toBe("Address");
    expect(groups(PRISMA_ENUM_HEAD, "enum Role {")?.[2]).toBe("Role");
    expect(groups(PRISMA_CONFIG_HEAD, "datasource db {")?.[2]).toBe("db");
    expect(groups(PRISMA_CONFIG_HEAD, "generator client {")?.[2]).toBe("client");
    const actions = ruleFor("root", "model User {")?.[1] as { next?: string }[];
    expect(actions[4].next).toBe("@model");
  });

  it("reads a field's name and type only at the start of a model line", () => {
    expect(groups(PRISMA_FIELD, "  email String @unique")).toEqual(["  ", "email", " ", "String"]);
    expect(groups(PRISMA_FIELD, "  posts Post[]")).toEqual(["  ", "posts", " ", "Post"]);
    // `type` is a field name inside a model, not the composite-type keyword.
    expect(groups(PRISMA_FIELD, "  type String")).toEqual(["  ", "type", " ", "String"]);
    expect(groups(PRISMA_FIELD, "  @@index([email])")).toBeNull();
    expect(ruleFor("model", "  role Role @default(USER)")?.[0]).toBe(PRISMA_FIELD);
  });

  it("tells a scalar from a related model", () => {
    const action = (ruleFor("model", "  id Int")?.[1] as unknown[])[3] as { cases: Record<string, string> };
    expect(action.cases["@scalars"]).toBe("type");
    expect(action.cases["@default"]).toBe("type.identifier");
    expect(PRISMA_GRAMMAR.scalars).toEqual(expect.arrayContaining(["String", "Int", "DateTime", "Json", "Decimal"]));
  });

  it("reads attributes, native types, functions and named arguments", () => {
    expect(whole(PRISMA_ATTRIBUTE, "@id @default(autoincrement())")).toBe("@id");
    expect(whole(PRISMA_ATTRIBUTE, "@@unique([a, b])")).toBe("@@unique");
    expect(whole(PRISMA_ATTRIBUTE, "@db.VarChar(255)")).toBe("@db.VarChar");
    // Monarch rewrites `@name` and `@@` in a pattern's source; this one must reach it unchanged.
    expect(PRISMA_ATTRIBUTE.source).not.toMatch(/@@|@\w/);
    expect(whole(PRISMA_ATTRIBUTE, "autoincrement()")).toBeNull();
    expect(whole(PRISMA_FUNCTION, "autoincrement()")).toBe("autoincrement");
    expect(whole(PRISMA_FUNCTION, 'env("DATABASE_URL")')).toBe("env");
    expect(whole(PRISMA_FUNCTION, 'Unsupported("circle")')).toBeNull();
    expect(whole(PRISMA_NAMED_ARG, "fields: [authorId]")).toBe("fields");
    expect(whole(PRISMA_NAMED_ARG, "onDelete: Cascade")).toBe("onDelete");
  });

  it("colours enum values, config keys and doc comments", () => {
    expect((ruleFor("enum", "  ADMIN")?.[1] as string[])[1]).toBe("constant");
    expect(ruleFor("config", 'provider = "postgresql"')?.[1]).toBe("attribute.name");
    expect(ruleFor("model", "/// The user's handle")?.[1]).toBe("comment.doc");
    expect(ruleFor("model", "// plain")?.[1]).toBe("comment");
    expect(ruleFor("model", "}")?.[2]).toBe("@pop");
  });
});
