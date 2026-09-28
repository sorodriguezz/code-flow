import { describe, expect, it } from "vitest";
import { parseDbml } from "./parse";
import { migrationSql } from "./migration";

/**
 * The ALTER script "Comparar" offers. Both schemas are read through the real parser, for the reason
 * every DBML suite here gives: what the parser hands back is exactly what the fixture author would
 * otherwise have guessed wrong.
 */

const BEFORE = `
Enum status {
  draft
  gone
}

Table users {
  id integer [pk, increment]
  email varchar(100) [not null]
  nickname varchar
  age int
}

Table legacy {
  id int [pk]
  user_id int [ref: > users.id]
}

Table posts {
  id int [pk]
  user_id int
  state status
}
`;

const AFTER = `
Enum status {
  draft
  published
}

Table users {
  id integer [pk, increment]
  email varchar(255) [not null, unique]
  age int [not null, default: 0]
  created_at timestamp [default: \`now()\`]
}

Table posts {
  id int [pk]
  user_id int [ref: > users.id]
  state status [default: 'draft']
}

Table tags {
  post_id int [not null]
  tag varchar [not null]
  indexes {
    (post_id, tag) [pk]
  }
}

Ref: tags.post_id > posts.id
`;

const before = parseDbml(BEFORE);
const after = parseDbml(AFTER);

describe("migrationSql", () => {
  it("parses both fixtures", () => {
    expect(before.error).toBeNull();
    expect(after.error).toBeNull();
  });

  it("is empty when nothing changed", () => {
    expect(migrationSql(before, parseDbml(BEFORE), "postgresql")).toBe("");
  });

  describe("for PostgreSQL", () => {
    const sql = migrationSql(before, after, "postgresql");

    it("orders statements the way the database needs them", () => {
      const at = (needle: string) => {
        const index = sql.indexOf(needle);
        expect(index, needle).toBeGreaterThanOrEqual(0);
        return index;
      };
      expect(at('DROP TABLE "legacy" CASCADE;')).toBeLessThan(at('CREATE TABLE "tags"'));
      expect(at('CREATE TABLE "tags"')).toBeLessThan(at('ALTER TABLE "tags" ADD CONSTRAINT "fk_tags_post_id"'));
      expect(at('ALTER TYPE "status" ADD VALUE')).toBeLessThan(at('ALTER TABLE "posts" ALTER COLUMN "state" SET DEFAULT'));
    });

    it("alters, adds and drops columns", () => {
      expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "email" TYPE VARCHAR(255) USING "email"::VARCHAR(255);');
      expect(sql).toContain('ALTER TABLE "users" ADD CONSTRAINT "uq_users_email" UNIQUE ("email");');
      expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "age" SET NOT NULL;');
      expect(sql).toContain('ALTER TABLE "users" ALTER COLUMN "age" SET DEFAULT 0;');
      expect(sql).toContain('ALTER TABLE "users" ADD COLUMN "created_at" TIMESTAMP DEFAULT now();');
      expect(sql).toContain("-- drops users.nickname and everything in it");
      expect(sql).toContain('ALTER TABLE "users" DROP COLUMN "nickname";');
      expect(sql).toContain(`ALTER TABLE "posts" ALTER COLUMN "state" SET DEFAULT 'draft';`);
    });

    it("creates a new table with its composite key, and wires the new references", () => {
      expect(sql).toContain('CREATE TABLE "tags" (\n  "post_id" INT NOT NULL,\n  "tag" VARCHAR NOT NULL,\n  PRIMARY KEY ("post_id", "tag")\n);');
      expect(sql).toContain(
        'ALTER TABLE "posts" ADD CONSTRAINT "fk_posts_user_id" FOREIGN KEY ("user_id") REFERENCES "users" ("id");',
      );
    });

    it("adds an enum value and says why it cannot drop one", () => {
      expect(sql).toContain(`ALTER TYPE "status" ADD VALUE IF NOT EXISTS 'published';`);
      expect(sql).toContain("-- status lost 'gone': PostgreSQL cannot drop an enum value");
    });
  });

  describe("for MySQL", () => {
    const sql = migrationSql(before, after, "mysql");

    it("restates a changed column whole with MODIFY", () => {
      expect(sql).toContain("ALTER TABLE `users` MODIFY COLUMN `email` VARCHAR(255) NOT NULL;");
      expect(sql).toContain("ALTER TABLE `users` MODIFY COLUMN `age` INT NOT NULL DEFAULT 0;");
      expect(sql).toContain("ALTER TABLE `users` ADD CONSTRAINT `uq_users_email` UNIQUE (`email`);");
    });

    it("gives a bare varchar the length MySQL requires", () => {
      expect(sql).toContain("  `tag` VARCHAR(255) NOT NULL,");
    });

    it("spells expressions and enums the MySQL way", () => {
      expect(sql).toContain("ALTER TABLE `users` ADD COLUMN `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP;");
      expect(sql).toContain("ALTER TABLE `posts` MODIFY COLUMN `state` ENUM('draft', 'published') DEFAULT 'draft';");
      expect(sql).not.toContain("CREATE TYPE");
    });

    it("drops a table and adds keys with MySQL's syntax", () => {
      expect(sql).toContain("DROP TABLE `legacy`;");
      expect(sql).toContain(
        "ALTER TABLE `tags` ADD CONSTRAINT `fk_tags_post_id` FOREIGN KEY (`post_id`) REFERENCES `posts` (`id`);",
      );
    });
  });

  it("drops a removed foreign key by the name the generator gives it, and says so", () => {
    const withKey = parseDbml("Table a {\n  id int [pk]\n}\nTable b {\n  id int [pk]\n  a_id int [ref: > a.id]\n}");
    const withoutKey = parseDbml("Table a {\n  id int [pk]\n}\nTable b {\n  id int [pk]\n  a_id int\n}");
    const pg = migrationSql(withKey, withoutKey, "postgresql");
    expect(pg).toContain('ALTER TABLE "b" DROP CONSTRAINT IF EXISTS "fk_b_a_id";');
    expect(pg).toContain("a database created another way may call it something else");
    expect(migrationSql(withKey, withoutKey, "mysql")).toContain("ALTER TABLE `b` DROP FOREIGN KEY `fk_b_a_id`;");
  });
});
