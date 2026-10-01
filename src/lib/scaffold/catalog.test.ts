import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_TEMPLATE, TEMPLATES, gitSteps, type Options, type PackageManager, type TemplateContext } from "./catalog";
import { buildScript } from "./script";

function context(opts: Options, extra: Partial<TemplateContext> = {}): TemplateContext {
  return {
    name: "demo",
    parent: "/tmp/projects",
    root: "/tmp/projects/demo",
    sep: "/",
    platform: "macos",
    version: null,
    engines: null,
    opts,
    pm: "npm" as PackageManager,
    present: new Set(),
    label: (key) => key,
    ...extra,
  } as TemplateContext;
}

const template = (id: string) => {
  const found = TEMPLATES.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`no template ${id}`);
  return found;
};

describe("NestJS", () => {
  const nest12 = { line: "12", version: "12.0.1", channel: "latest" } as TemplateContext["version"];

  it("on Fastify, adds the adapter at the project's own major, the Fastify flavours, and the switch", () => {
    const plan = template("nest").plan(
      context({ language: "ts", platform: "fastify", nestHelmet: true, nestCompression: true, nestWebsockets: true }, { version: nest12 }),
    );
    const deps = plan.steps.find((step) => step.title === "scaffold.step.deps");
    expect(deps?.argv).toEqual([
      "npm",
      "install",
      "@nestjs/platform-fastify@^12",
      "@fastify/helmet",
      "@fastify/compress",
      "@nestjs/websockets@^12",
      "@nestjs/platform-socket.io@^12",
    ]);
    // `@types/compression` is Express's: nothing to type on Fastify.
    expect(plan.steps.some((step) => step.title === "scaffold.step.devDeps")).toBe(false);
    expect(plan.steps[plan.steps.length - 1]?.title).toBe("scaffold.step.fastify");
  });

  it("on Express, installs only what was ticked — and nothing at all when nothing was", () => {
    const plan = template("nest").plan(context({ language: "ts", platform: "express", nestCompression: true, nestJwt: true }));
    expect(plan.steps.find((step) => step.title === "scaffold.step.deps")?.argv).toEqual([
      "npm",
      "install",
      "@nestjs/jwt",
      "@nestjs/passport",
      "passport",
      "passport-jwt",
      "compression",
    ]);
    expect(plan.steps.find((step) => step.title === "scaffold.step.devDeps")?.argv).toEqual([
      "npm",
      "install",
      "--save-dev",
      "@types/passport-jwt",
      "@types/compression",
    ]);
    expect(plan.steps.some((step) => step.title === "scaffold.step.fastify")).toBe(false);

    const bare = template("nest").plan(context({ language: "ts", platform: "express" }));
    expect(bare.steps.map((step) => step.title)).toEqual(["scaffold.step.generate"]);
  });

  /** The switch as the runner will execute it: through the sh script, on the `main.ts` NestJS 12
   *  generates (ESM, `.js` imports, top-level await) — and loudly refused on one it does not know. */
  it("puts the generated application on Fastify, quoted as the script quotes it", () => {
    const patch = template("nest")
      .plan(context({ language: "ts", platform: "fastify" }, { version: nest12 }))
      .steps.find((step) => step.title === "scaffold.step.fastify");
    const dir = mkdtempSync(join(tmpdir(), "nest-fastify-"));
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(
        join(dir, "src", "main.ts"),
        [
          "import { NestFactory } from '@nestjs/core';",
          "import { AppModule } from './app.module.js';",
          "",
          "async function bootstrap() {",
          "  const app = await NestFactory.create(AppModule);",
          "  await app.listen(process.env.PORT ?? 3000);",
          "}",
          "await bootstrap();",
          "",
        ].join("\n"),
      );
      const script = buildScript("sh", [{ ...patch!, cwd: dir }], { skipped: "skipped", done: "done" });
      execFileSync("sh", ["-c", script], { stdio: "pipe" });
      const main = readFileSync(join(dir, "src", "main.ts"), "utf8");
      expect(main.split("\n")[0]).toBe("import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';");
      expect(main).toContain("NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())");

      writeFileSync(join(dir, "src", "main.ts"), "export const nothing = 1;\n");
      expect(() => execFileSync("sh", ["-c", script], { stdio: "pipe" })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Fastify", () => {
  it("writes one server file and adds the version picked", () => {
    const plan = template("fastify").plan(
      context({ language: "ts" }, { version: { line: "5", version: "5.6.1", channel: "latest" } as TemplateContext["version"] }),
    );
    const server = plan.files?.find((file) => file.path === "src/index.ts");
    expect(server?.content).toContain('import Fastify from "fastify";');
    expect(plan.steps[0].argv).toEqual(["npm", "install", "fastify@^5.6.1"]);
    expect(plan.run).toBe("npm run dev");
  });
});

describe("Hono", () => {
  it("runs create-hono with every answer as a flag, on Bun's own tools for Bun", () => {
    const node = template("hono").plan(context({ runtime: "nodejs" }));
    expect(node.steps[0].argv).toEqual([
      "npx",
      "--yes",
      "create-hono@latest",
      "demo",
      "--template",
      "nodejs",
      "--pm",
      "npm",
      "--install",
    ]);
    const bun = template("hono").plan(context({ runtime: "bun" }, { pm: "pnpm" }));
    expect(bun.steps[0].argv?.slice(0, 3)).toEqual(["bun", "x", "create-hono@latest"]);
    expect(bun.steps[0].argv).toContain("bun");
    expect(bun.run).toBe("bun dev");
    expect(template("hono").requirements(context({ runtime: "bun" }))).toEqual([{ tool: "bun" }]);
  });
});

describe("Empty", () => {
  /** As the runner does it: the folder made by writing no files at all, then the script — which is
   *  git's steps alone. Isolated from the machine's git config, so a signing or hook setting there
   *  cannot fail it. */
  it("leaves a folder holding a repository and nothing else, with a first commit to branch from", () => {
    const parent = mkdtempSync(join(tmpdir(), "scaffold-empty-"));
    const root = join(parent, "new-project");
    try {
      const plan = template("empty").plan(context({}, { name: "new-project", parent, root }));
      expect(plan.files).toEqual([]);
      expect(plan.steps).toEqual([]);
      expect(template("empty").requirements(context({}))).toEqual([]);
      mkdirSync(root); // `scaffold_write_files` with an empty list
      const script = buildScript("sh", [...plan.steps, ...gitSteps(root, (key) => key, true, plan.emptyCommit)], {
        skipped: "skipped",
        done: "done",
      });
      const env = {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      };
      const output = execFileSync("sh", ["-c", script], { cwd: parent, env, encoding: "utf8" });
      expect(output).not.toContain("skipped");
      expect(readdirSync(root)).toEqual([".git"]);
      expect(execFileSync("git", ["log", "--format=%s"], { cwd: root, env, encoding: "utf8" }).trim()).toBe("Initial commit");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("commits empty only when the plan asks: a generator's own commit (Expo's) gets no empty twin", () => {
    const label = (key: string) => key;
    expect(gitSteps("/p", label, true)[1].sh).toBe("git add -A && git commit -q -m 'Initial commit'");
    const [, empty] = gitSteps("/p", label, true, true);
    expect(empty.sh).toBe("git add -A && git commit -q --allow-empty -m 'Initial commit'");
    expect(empty.ps).toContain("git commit -q --allow-empty -m 'Initial commit'");
    // Unticked, it stays a bare `git init`.
    expect(gitSteps("/p", label, false, true).map((step) => step.argv)).toEqual([["git", "init", "-q"]]);
  });

  it("is the top of the list, where the dialog opens", () => {
    expect(FIRST_TEMPLATE.id).toBe("empty");
  });
});
