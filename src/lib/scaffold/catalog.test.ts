import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FIRST_TEMPLATE, TEMPLATES, enginesFor, gitSteps, planFor, type Options, type PackageManager, type TemplateContext } from "./catalog";
import { SCAFFOLD_LOGOS } from "./logos";
import { buildScript } from "./script";
import { translations } from "../i18n/translations";
import { es } from "../i18n/translations.es";

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

  it("adds @nestjs/resilience on Nest 12, and leaves it out of a project generated at an older major", () => {
    const deps = (version?: TemplateContext["version"]) =>
      template("nest")
        .plan(context({ language: "ts", platform: "express", nestResilience: true, nestConfig: true }, version ? { version } : {}))
        .steps.find((step) => step.title === "scaffold.step.deps")?.argv;
    expect(deps(nest12)).toEqual(["npm", "install", "@nestjs/config", "@nestjs/resilience"]);
    // No version known (no picker, or it failed): the CLI's latest, which is 12 — kept.
    expect(deps()).toEqual(["npm", "install", "@nestjs/config", "@nestjs/resilience"]);
    const nest11 = { line: "11", version: "11.0.10", channel: "latest" } as TemplateContext["version"];
    expect(deps(nest11)).toEqual(["npm", "install", "@nestjs/config"]);
  });

  describe("the core team's other packages", () => {
    const nest11 = { line: "11", version: "11.0.10", channel: "latest" } as TemplateContext["version"];
    const option = (id: string) => template("nest").options.find((o) => o.id === id)!;
    const offered = (id: string, line: number, platform = "express") => option(id).when?.({ platform }, line) ?? true;
    const planned = (opts: Record<string, string | boolean>, version?: TemplateContext["version"]) =>
      template("nest").plan(context({ language: "ts", platform: "express", ...opts }, version ? { version } : {}));
    const deps = (opts: Record<string, string | boolean>, version?: TemplateContext["version"]) =>
      planned(opts, version).steps.find((step) => step.title === "scaffold.step.deps")?.argv;

    it("offers each only on the Nest lines its peer range accepts", () => {
      // Azure has not moved past 11; CQRS and authentication start at 12.
      expect(offered("nestAzureDatabase", 11)).toBe(true);
      expect(offered("nestAzureDatabase", 12)).toBe(false);
      expect(offered("nestCqrs", 11)).toBe(false);
      expect(offered("nestCqrs", 12)).toBe(true);
      // Not knowing the version reads as the CLI's current major.
      expect(offered("nestCqrs", Number.NaN)).toBe(true);
      expect(offered("nestAzureDatabase", Number.NaN)).toBe(false);
      // And a pick the form would hide is not installed either.
      expect(deps({ nestAzureDatabase: true, nestCqrs: true }, nest12)).toEqual(["npm", "install", "@nestjs/cqrs"]);
      expect(deps({ nestAzureDatabase: true, nestCqrs: true }, nest11)).toEqual(["npm", "install", "@nestjs/azure-database"]);
    });

    it("keeps Mercurius to Fastify, and gives Apollo its platform's integration on GraphQL 16", () => {
      expect(offered("nestMercurius", 12, "express")).toBe(false);
      expect(offered("nestMercurius", 12, "fastify")).toBe(true);
      expect(deps({ nestApollo: true }, nest12)).toEqual([
        "npm",
        "install",
        "@nestjs/graphql",
        "@nestjs/apollo",
        "@apollo/server",
        "@as-integrations/express5",
        "graphql@^16",
      ]);
    });

    it("installs a package two picks share once", () => {
      // Outbox is picked on its own and is also what Webhooks need: one install, in catalogue order.
      expect(deps({ nestWebhooks: true, nestOutbox: true }, nest12)).toEqual(["npm", "install", "@nestjs/outbox", "@nestjs/webhooks"]);
      expect(deps({ nestWebhooks: true }, nest12)).toEqual(["npm", "install", "@nestjs/webhooks", "@nestjs/outbox"]);
    });

    it("lets the CLI set Observe up on Nest 12, and installs it before", () => {
      const generate = (version: TemplateContext["version"], observe: boolean) =>
        planned({ nestObserve: observe }, version).steps.find((step) => step.title === "scaffold.step.generate")?.argv ?? [];
      expect(generate(nest12, true)).toContain("--observe");
      expect(generate(nest12, false)).toContain("--no-observe");
      expect(deps({ nestObserve: true }, nest12)).toBeUndefined();
      expect(deps({ nestObserve: true }, nest11)).toEqual(["npm", "install", "@nestjs/observe"]);
      expect(generate(nest11, true).some((arg) => arg.includes("observe"))).toBe(false);
    });
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

describe("pnpm's unapproved build scripts", () => {
  const nest12 = { line: "12", version: "12.0.8", channel: "latest" } as TemplateContext["version"];
  const opts = { language: "js", platform: "fastify", nestConfig: true, nestCache: true };

  it("keeps every pnpm step from failing over them, then settles them in the project", () => {
    const plan = planFor(template("nest"), context(opts, { version: nest12, pm: "pnpm" }));
    const pnpmSteps = plan.steps.filter((step) => step.argv?.[0] === "pnpm");
    expect(pnpmSteps.map((step) => step.title)).toEqual(["scaffold.step.generate", "scaffold.step.deps"]);
    for (const step of pnpmSteps) expect(step.env?.pnpm_config_strict_dep_builds).toBe("false");
    // The generator's own answer survives the merge.
    expect(pnpmSteps[0].env?.NG_FORCE_TTY).toBe("false");
    // Last, after everything that installs; optional, since the project is whole without it.
    const settle = plan.steps[plan.steps.length - 1];
    expect(settle).toMatchObject({ title: "scaffold.step.builds", cwd: "/tmp/projects/demo", optional: true });
    expect(settle.argv?.slice(0, 2)).toEqual(["node", "-e"]);
  });

  it("leaves a plan that runs no pnpm exactly as the template made it", () => {
    const nest = context(opts, { version: nest12, pm: "npm" });
    expect(planFor(template("nest"), nest)).toEqual(template("nest").plan(nest));
    // Picked pnpm, runs on Bun's tools.
    const hono = context({ runtime: "bun" }, { pm: "pnpm" });
    expect(planFor(template("hono"), hono)).toEqual(template("hono").plan(hono));
  });

  /** As the runner runs it, through the sh script, on the file pnpm 11+ writes: only its placeholders
   *  are decided — a choice already made, by the user or in their global config, is left alone. */
  it("writes `false` over pnpm's placeholders and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "pnpm-builds-"));
    try {
      const plan = planFor(template("nest"), context(opts, { version: nest12, pm: "pnpm", root: dir }));
      const script = buildScript("sh", [plan.steps[plan.steps.length - 1]], { skipped: "skipped", done: "done" });
      const run = () => execFileSync("sh", ["-c", script], { encoding: "utf8" });
      const file = join(dir, "pnpm-workspace.yaml");

      expect(run()).not.toContain("skipped");
      expect(readdirSync(dir)).toEqual([]);

      writeFileSync(
        file,
        [
          "packages:",
          "  - .",
          "allowBuilds:",
          "  esbuild: true",
          "  core-js: set this to true or false",
          "  '@scope/native': set this to true or false",
          "  sharp: false",
          "",
        ].join("\n"),
      );
      const output = run();
      expect(readFileSync(file, "utf8")).toBe(
        ["packages:", "  - .", "allowBuilds:", "  esbuild: true", "  core-js: false", "  '@scope/native': false", "  sharp: false", ""].join("\n"),
      );
      expect(output).toContain("core-js: false");
      expect(output).toContain("'@scope/native': false");
      expect(output).not.toContain("esbuild");
      // Settled, a second run has nothing to say.
      expect(run()).not.toContain("allowBuilds");

      // Windows line endings stay Windows line endings.
      writeFileSync(file, "allowBuilds:\r\n  core-js: set this to true or false\r\n  unrs-resolver: set this to true or false\r\n");
      run();
      expect(readFileSync(file, "utf8")).toBe("allowBuilds:\r\n  core-js: false\r\n  unrs-resolver: false\r\n");
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

describe("every template", () => {
  it("has a mark and a description in both languages", () => {
    for (const each of TEMPLATES) {
      expect(SCAFFOLD_LOGOS[each.logo], each.id).toBeDefined();
      expect(translations.en[each.descriptionKey], each.id).toBeTruthy();
      expect((es as Record<string, string>)[each.descriptionKey], each.id).toBeTruthy();
    }
  });
});

describe("Solid", () => {
  it("passes the kind, the starter and the language as flags, and drops the starter's lockfile", () => {
    const plan = template("solid").plan(context({ kind: "solidstart", startTemplate: "with-tailwindcss", language: "ts" }, { pm: "pnpm" }));
    expect(plan.steps[0].argv).toEqual(["pnpm", "dlx", "create-solid@latest", "demo", "--solidstart", "--v2", "-t", "with-tailwindcss", "--ts"]);
    expect(plan.steps.map((step) => step.title)).toEqual([
      "scaffold.step.generate",
      "scaffold.step.lockfile",
      "scaffold.step.name",
      "scaffold.step.install",
    ]);
    expect(plan.steps[1].sh).toBe("rm -f pnpm-lock.yaml");
    const vite = template("solid").plan(context({ kind: "vanilla", viteTemplate: "bare", language: "js" }));
    expect(vite.steps[0].argv).toEqual(["npx", "--yes", "create-solid@latest", "demo", "--vanilla", "-t", "bare", "--js"]);
  });

  it("reads its Node requirement where the kind picked says", () => {
    expect(enginesFor(template("solid"), {})).toEqual({ kind: "npm", package: "vite" });
    expect(enginesFor(template("solid"), { kind: "solidstart" })).toEqual({ kind: "npm", package: "@solidjs/start" });
    // A template with a fixed source is handed back as it is.
    expect(enginesFor(template("nuxt"), {})).toEqual({ kind: "npm", package: "nuxt" });
  });

  /** As the runner runs it: the folder's name over the starter's own, whatever else is in the file. */
  it("names the package after the folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "solid-name-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "example-basic", scripts: { dev: "vite" } }, null, 2));
      const step = template("solid").plan(context({}, { name: "my-app", root: dir })).steps.find((each) => each.title === "scaffold.step.name");
      execFileSync("sh", ["-c", buildScript("sh", [step!], { skipped: "skipped", done: "done" })], { stdio: "pipe" });
      expect(JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))).toEqual({ name: "my-app", scripts: { dev: "vite" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Qwik", () => {
  it("puts the starter before the folder, at the version picked, and reads Node from Vite", () => {
    const plan = template("qwik").plan(
      context({ starter: "playground" }, { version: { line: "1", version: "1.20.1", channel: "latest" } as TemplateContext["version"] }),
    );
    expect(plan.steps[0].argv).toEqual(["npx", "--yes", "create-qwik@1.20.1", "playground", "demo"]);
    const engines = { line: "7", version: "7.3.1", channel: "latest", requires: "^20.19.0 || >=22.12.0" } as TemplateContext["engines"];
    const version = { line: "1", version: "1.20.1", channel: "latest", requires: "^18.17.0" } as TemplateContext["version"];
    expect(template("qwik").requirements(context({}, { engines, version }))[0].range).toBe("^20.19.0 || >=22.12.0");
  });
});

describe("AdonisJS", () => {
  it("tells create-adonisjs the kit and the manager, then checks what it says it did", () => {
    const plan = template("adonis").plan(context({ kit: "api" }, { pm: "yarn" }));
    expect(plan.steps[0].argv).toEqual(["npx", "--yes", "create-adonisjs@latest", "demo", "--kit=api", "--pkg=yarn", "--verbose"]);
    expect(plan.steps[1].title).toBe("scaffold.step.verify");
    expect(plan.run).toBe("yarn dev");
  });

  /** It exits 0 when it failed; the check is what fails the script — and only then. */
  it("fails the script when the project has no .env, and passes when it does", () => {
    const dir = mkdtempSync(join(tmpdir(), "adonis-check-"));
    try {
      const check = (kit: string) => {
        const step = template("adonis").plan(context({ kit }, { root: dir })).steps[1];
        return () => execFileSync("sh", ["-c", buildScript("sh", [step], { skipped: "skipped", done: "done" })], { stdio: "pipe" });
      };
      expect(check("api")).toThrow();
      writeFileSync(join(dir, ".env"), "APP_KEY=x\n");
      expect(check("api")).not.toThrow();
      // The monorepo kit's backend keeps its own.
      expect(check("api-monorepo")).toThrow();
      mkdirSync(join(dir, "apps", "backend"), { recursive: true });
      writeFileSync(join(dir, "apps", "backend", ".env"), "APP_KEY=x\n");
      expect(check("api-monorepo")).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Angular Native", () => {
  it("is Expo's generator with the ng-native template, quiet, and installs after", () => {
    const plan = template("angularNative").plan(context({}, { pm: "pnpm" }));
    expect(plan.steps[0].argv).toEqual([
      "pnpm",
      "dlx",
      "create-expo-app@latest",
      "demo",
      "--template",
      "@ng-native/template",
      "--no-install",
      "--no-agents-md",
      "--yes",
    ]);
    expect(plan.steps[1].argv).toEqual(["pnpm", "install"]);
    expect(plan.run).toBe("pnpm start");
  });
});

describe("Ruby on Rails", () => {
  const rails = { line: "8.1", version: "8.1.4", channel: "latest", requires: ">= 3.2.0" } as TemplateContext["version"];

  it("installs the Rails picked, runs exactly that one, and checks the bundle it made", () => {
    const plan = template("rails").plan(context({ database: "postgresql", api: false, tailwind: true }, { version: rails }));
    expect(plan.steps.map((step) => step.title)).toEqual([
      "scaffold.step.gems",
      "scaffold.step.rails",
      "scaffold.step.generate",
      "scaffold.step.verify",
    ]);
    expect(plan.steps[1].argv).toEqual(["gem", "install", "rails", "-v", "8.1.4", "--no-document"]);
    expect(plan.steps[2].argv).toEqual([
      "ruby",
      "-e",
      "load Gem.activate_bin_path('railties', 'rails', ARGV.shift)",
      "8.1.4",
      "new",
      "demo",
      "--database=postgresql",
      "--css=tailwind",
    ]);
    // Never `--skip-git`: it takes `.gitignore` with it, and `config/master.key` would be committed.
    expect(plan.steps[2].argv).not.toContain("--skip-git");
    expect(plan.steps[3].argv).toEqual(["bundle", "check"]);
    expect(plan.run).toBe("bin/rails server");
    expect(template("rails").requirements(context({}, { version: rails }))).toEqual([
      { tool: "ruby", range: ">= 3.2.0", because: "Rails 8.1.4" },
    ]);
  });

  it("is an API without Tailwind when asked, and moves GEM_HOME only on sh", () => {
    const plan = template("rails").plan(context({ database: "sqlite3", api: true, tailwind: true }, { version: rails, platform: "windows" }));
    expect(plan.steps[2].argv?.slice(-2)).toEqual(["--database=sqlite3", "--api"]);
    expect(plan.steps[0].ps).toBeUndefined();
    expect(buildScript("ps", plan.steps, { skipped: "s", done: "d" })).not.toContain("GEM_HOME");
    expect(plan.run).toBe("ruby bin\\rails server");
  });
});

describe("Quarkus", () => {
  it("asks code.quarkus.io for the stream, build and extensions picked, and runs dev mode", () => {
    const plan = template("quarkus").plan(
      context(
        { buildTool: "GRADLE", groupId: "com.acme", qRest: true, qHealth: true, qPanache: false },
        { version: { line: "3.33", version: "3.33.4", channel: "lts", requires: ">=17" } as TemplateContext["version"] },
      ),
    );
    expect(plan.quarkus).toEqual({
      stream: "3.33",
      groupId: "com.acme",
      buildTool: "GRADLE",
      extensions: ["io.quarkus:quarkus-rest", "io.quarkus:quarkus-smallrye-health"],
    });
    expect(plan.steps).toEqual([]);
    expect(plan.run).toBe("./gradlew --console=plain quarkusDev");
    expect(template("quarkus").plan(context({ buildTool: "MAVEN" }, { platform: "windows" })).run).toBe("mvnw.cmd quarkus:dev");
  });
});

describe("Koa and hapi", () => {
  it("Koa: one server file on @koa/router, the version picked, and Koa's types for TypeScript", () => {
    const plan = template("koa").plan(
      context({ language: "ts" }, { version: { line: "3", version: "3.2.1", channel: "latest" } as TemplateContext["version"] }),
    );
    const server = plan.files?.find((file) => file.path === "src/index.ts");
    expect(server?.content).toContain('import Router from "@koa/router";');
    expect(server?.content).toContain('ctx.body = { message: "Hello from demo!" };');
    expect(plan.steps[0].argv).toEqual(["npm", "install", "koa@^3.2.1", "@koa/router"]);
    // The router ships its own types; Koa does not.
    expect(plan.steps[1].argv).toEqual(["npm", "install", "--save-dev", "typescript", "tsx", "@types/node", "@types/koa"]);
    expect(plan.run).toBe("npm run dev");
  });

  it("hapi: its own types, so JavaScript and TypeScript differ only by the compiler", () => {
    const js = template("hapi").plan(context({ language: "js" }, { pm: "pnpm" }));
    expect(js.files?.map((file) => file.path)).toEqual(["package.json", ".gitignore", "src/index.js"]);
    expect(js.files?.[2].content).toContain("await server.start();");
    expect(js.steps.map((step) => step.argv)).toEqual([["pnpm", "add", "@hapi/hapi"]]);
    expect(js.run).toBe("pnpm dev");
    const typed = template("hapi").plan(context({ language: "ts" }));
    expect(typed.steps[1].argv).toEqual(["npm", "install", "--save-dev", "typescript", "tsx", "@types/node"]);
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
