import { describe, expect, it } from "vitest";
import vscodeIcons from "@iconify-json/vscode-icons/icons.json";
import { customIconFor, ruleMatches, sameRuleTarget, type IconRule } from "./rules";
import { BUILT_IN_PROFILES, DEFAULT_PROFILE_ID, shippedProfile, type IconProfile } from "./profiles";
import { previewIcons } from "./packs";
import { upgradeShippedProfiles, V1_OFFERED_IDS } from "./profileUpgrade";
import { detectProfileId } from "./detectProfile";
import { LOCAL_ICON_SET } from "./localSet";
import { MARKS } from "./frameworkMarks";

const set = vscodeIcons as { icons: Record<string, unknown>; aliases?: Record<string, unknown> };

/** Whether a catalogue id names a glyph that exists: in vscode-icons, or in this repo's own set. */
function exists(id: string): boolean {
  const [prefix, name] = id.split(":");
  if (prefix === LOCAL_ICON_SET.prefix) return name in LOCAL_ICON_SET.icons;
  return prefix === "vscode-icons" && (name in set.icons || name in (set.aliases ?? {}));
}

/** A name the rule matches, built from the rule alone — what its author meant it to claim. */
function sampleFor(rule: IconRule): string {
  switch (rule.match) {
    case "name":
      return rule.pattern;
    case "suffix":
      return `sample${rule.pattern}`;
    case "prefix":
      return `${rule.pattern}sample`;
    case "contains":
      return `a${rule.pattern}b`;
  }
}

function iconOf(profile: IconProfile, name: string, folder = false): string | null {
  return customIconFor(profile.rules, name, folder);
}

function pack(id: string): IconProfile {
  const found = shippedProfile(id);
  if (!found) throw new Error(`no shipped pack ${id}`);
  return found;
}

describe("shipped icon packs", () => {
  it("ship General, the frameworks the user named, and fall back to General", () => {
    expect(BUILT_IN_PROFILES.map((profile) => profile.id)).toEqual([
      "base",
      "angular",
      "react",
      "nextjs",
      "vue",
      "nestjs",
      "bun",
      "spring",
      "dotnet",
      "fastapi",
      "django",
      "laravel",
    ]);
    expect(DEFAULT_PROFILE_ID).toBe("base");
  });

  it("name only glyphs that exist, in vscode-icons or in this repo's own set", () => {
    const missing: string[] = [];
    for (const profile of BUILT_IN_PROFILES) {
      for (const rule of profile.rules) {
        if (!exists(rule.icon)) missing.push(`${profile.id}: ${rule.pattern} → ${rule.icon}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("give every NestJS folder an opened twin, so an expanded folder still looks open", () => {
    const folders = BUILT_IN_PROFILES.flatMap((profile) => profile.rules)
      .filter((rule) => rule.target === "folder" && rule.icon.startsWith("cf:"))
      .map((rule) => rule.icon);
    expect(folders.length).toBeGreaterThan(0);
    for (const id of folders) expect(exists(`${id}-opened`), id).toBe(true);
  });

  it("preview each pack with four glyphs the set has and the packs already draw", () => {
    const drawn = new Set(BUILT_IN_PROFILES.flatMap((profile) => profile.rules.map((rule) => rule.icon)));
    for (const profile of BUILT_IN_PROFILES) {
      const preview = previewIcons(profile);
      expect(preview, profile.id).toHaveLength(4);
      for (const id of preview) {
        expect(exists(id), `${profile.id}: ${id}`).toBe(true);
        // Already declared to the catalogue, so a preview never waits on a widened re-read.
        expect(drawn.has(id), `${profile.id}: ${id}`).toBe(true);
      }
    }
  });

  it("give every rule an id of its own and never claim the same target twice", () => {
    for (const profile of BUILT_IN_PROFILES) {
      const ids = new Set(profile.rules.map((rule) => rule.id));
      expect(ids.size, profile.id).toBe(profile.rules.length);
      const duplicates = profile.rules.filter((rule, index) =>
        profile.rules.slice(0, index).some((earlier) => sameRuleTarget(earlier, rule)),
      );
      expect(duplicates.map((rule) => `${profile.id}: ${rule.pattern}`)).toEqual([]);
    }
  });

  it("never shadow a rule with one above it — the list is first-match-wins", () => {
    const shadowed: string[] = [];
    for (const profile of BUILT_IN_PROFILES) {
      profile.rules.forEach((rule, index) => {
        const sample = sampleFor(rule);
        const folder = rule.target === "folder";
        const winner = profile.rules.find((candidate) => ruleMatches(candidate, sample, folder));
        if (winner && winner !== rule && winner.icon !== rule.icon) {
          shadowed.push(`${profile.id}: ${rule.pattern} (#${index}) loses "${sample}" to ${winner.pattern}`);
        }
      });
    }
    expect(shadowed).toEqual([]);
  });

  it("make General a whole theme, not seven rules", () => {
    const general = pack("base");
    expect(general.rules.length).toBeGreaterThan(300);
    expect(iconOf(general, "index.ts")).toBe("vscode-icons:file-type-typescript");
    expect(iconOf(general, "App.tsx")).toBe("vscode-icons:file-type-reactts");
    expect(iconOf(general, "types.d.ts")).toBe("vscode-icons:file-type-typescriptdef");
    expect(iconOf(general, "user.spec.ts")).toBe("vscode-icons:file-type-testts");
    expect(iconOf(general, "Button.stories.tsx")).toBe("vscode-icons:file-type-storybook");
    expect(iconOf(general, "package.json")).toBe("vscode-icons:file-type-npm");
    expect(iconOf(general, "tsconfig.app.json")).toBe("vscode-icons:file-type-tsconfig");
    expect(iconOf(general, "vite.config.ts")).toBe("vscode-icons:file-type-vite");
    expect(iconOf(general, "vitest.config.ts")).toBe("vscode-icons:file-type-vitest");
    expect(iconOf(general, "Dockerfile.dev")).toBe("vscode-icons:file-type-docker");
    expect(iconOf(general, ".env.local")).toBe("vscode-icons:file-type-dotenv");
    expect(iconOf(general, ".gitignore")).toBe("vscode-icons:file-type-git");
    expect(iconOf(general, ".gitlab-ci.yml")).toBe("vscode-icons:file-type-gitlab");
    expect(iconOf(general, "main.py")).toBe("vscode-icons:file-type-python");
    expect(iconOf(general, "Main.java")).toBe("vscode-icons:file-type-java");
    expect(iconOf(general, "Program.cs")).toBe("vscode-icons:file-type-csharp");
    expect(iconOf(general, "main.go")).toBe("vscode-icons:file-type-go");
    expect(iconOf(general, "report.csv")).toBe("vscode-icons:file-type-excel");
    expect(iconOf(general, "logo.png")).toBe("vscode-icons:file-type-image");
    expect(iconOf(general, "src", true)).toBe("vscode-icons:folder-type-src");
    expect(iconOf(general, "node_modules", true)).toBe("vscode-icons:folder-type-node");
    expect(iconOf(general, "hooks", true)).toBe("vscode-icons:folder-type-hook");
    // A file named like a folder rule is still a file.
    expect(iconOf(general, "src")).toBeNull();
  });

  it("let each framework read its own conventions over the base", () => {
    expect(iconOf(pack("angular"), "user.service.ts")).toBe("cf:angular-service");
    expect(iconOf(pack("angular"), "app-routing.module.ts")).toBe("cf:angular-route");
    expect(iconOf(pack("angular"), "card.component.html")).toBe("cf:angular-template");
    expect(iconOf(pack("nestjs"), "user.service.ts")).toBe("cf:nest-service");
    expect(iconOf(pack("nestjs"), "create-user.dto.ts")).toBe("cf:nest-dto");
    expect(iconOf(pack("nestjs"), "user.entity.ts")).toBe("cf:nest-entity");
    expect(iconOf(pack("react"), "components.json")).toBe("vscode-icons:file-type-shadcn");
    expect(iconOf(pack("nextjs"), "layout.tsx")).toBe("vscode-icons:file-type-layout");
    expect(iconOf(pack("nextjs"), "route.ts")).toBe("vscode-icons:file-type-rest");
    expect(iconOf(pack("nextjs"), "[slug]", true)).toBe("vscode-icons:folder-type-route");
    expect(iconOf(pack("spring"), "UserController.java")).toBe("vscode-icons:file-type-rest");
    expect(iconOf(pack("spring"), "application-dev.yml")).toBe("vscode-icons:file-type-config");
    expect(iconOf(pack("spring"), "UserRepository.java")).toBe("vscode-icons:file-type-db");
    expect(iconOf(pack("dotnet"), "appsettings.Development.json")).toBe("vscode-icons:file-type-config");
    expect(iconOf(pack("dotnet"), "OrdersController.cs")).toBe("vscode-icons:file-type-rest");
    expect(iconOf(pack("dotnet"), "Data", true)).toBe("vscode-icons:folder-type-db");
    expect(iconOf(pack("fastapi"), "test_users.py")).toBe("vscode-icons:file-type-pytest");
    expect(iconOf(pack("fastapi"), "schemas.py")).toBe("vscode-icons:file-type-json-schema");
    expect(iconOf(pack("django"), "manage.py")).toBe("vscode-icons:file-type-django");
    expect(iconOf(pack("laravel"), "vendor", true)).toBe("vscode-icons:folder-type-composer");
    expect(iconOf(pack("laravel"), "welcome.blade.php")).toBe("vscode-icons:file-type-blade");
    // And every pack still draws everything General draws.
    for (const profile of BUILT_IN_PROFILES) {
      expect(iconOf(profile, "logo.svg"), profile.id).toBe("vscode-icons:file-type-svg");
    }
  });
});

describe("the NestJS pack", () => {
  const nest = () => pack("nestjs");

  it("gives every kind a glyph of its own", () => {
    const cases: [string, string][] = [
      ["main.ts", "cf:nest-main"],
      ["app.module.ts", "cf:nest-module"],
      ["users.controller.ts", "cf:nest-controller"],
      ["users.service.ts", "cf:nest-service"],
      ["users.repository.ts", "cf:nest-repository"],
      ["users.controller.spec.ts", "cf:nest-spec"],
      ["users.service.test.ts", "cf:nest-spec"],
      ["app.e2e-spec.ts", "cf:nest-e2e"],
      ["jwt-auth.guard.ts", "cf:nest-guard"],
      ["jwt.strategy.ts", "cf:nest-strategy"],
      ["parse-id.pipe.ts", "cf:nest-pipe"],
      ["http-exception.filter.ts", "cf:nest-filter"],
      ["logging.interceptor.ts", "cf:nest-interceptor"],
      ["logger.middleware.ts", "cf:nest-middleware"],
      ["roles.decorator.ts", "cf:nest-decorator"],
      ["events.gateway.ts", "cf:nest-gateway"],
      ["users.resolver.ts", "cf:nest-resolver"],
      ["user.schema.ts", "cf:nest-schema"],
      ["create-user.input.ts", "cf:nest-dto"],
      ["user.interface.ts", "cf:nest-interface"],
      ["role.enum.ts", "cf:nest-enum"],
      ["user-created.event.ts", "cf:nest-event"],
      ["create-user.handler.ts", "cf:nest-listener"],
      ["audio.processor.ts", "cf:nest-processor"],
      ["cleanup.task.ts", "cf:nest-task"],
      ["users.health.ts", "cf:nest-health"],
      ["user-not-found.exception.ts", "cf:nest-exception"],
      ["app.constants.ts", "cf:nest-constants"],
      ["database.config.ts", "cf:nest-config"],
    ];
    for (const [name, icon] of cases) expect(iconOf(nest(), name), name).toBe(icon);
  });

  it("leaves a tool's own config file to the tool", () => {
    expect(iconOf(nest(), "vitest.config.ts")).toBe("vscode-icons:file-type-vitest");
    expect(iconOf(nest(), "jest.config.ts")).toBe("vscode-icons:file-type-jest");
    expect(iconOf(nest(), "nest-cli.json")).toBe("vscode-icons:file-type-nestjs");
    expect(iconOf(nest(), "index.d.ts")).toBe("vscode-icons:file-type-typescriptdef");
    expect(iconOf(nest(), "index.ts")).toBe("vscode-icons:file-type-typescript");
  });

  it("draws the folders a feature is split into", () => {
    expect(iconOf(nest(), "guards", true)).toBe("cf:folder-guard");
    expect(iconOf(nest(), "dto", true)).toBe("cf:folder-dto");
    expect(iconOf(nest(), "entities", true)).toBe("cf:folder-entity");
    expect(iconOf(nest(), "src", true)).toBe("vscode-icons:folder-type-src");
  });

  it("draws every file as the cat", () => {
    const files = Object.keys(LOCAL_ICON_SET.icons).filter((name) => name.startsWith("nest-"));
    expect(files.length).toBeGreaterThan(30);
  });

  it("keeps Angular's reading of the same suffixes in the Angular pack", () => {
    expect(iconOf(pack("angular"), "auth.guard.ts")).toBe("cf:angular-guard");
    expect(iconOf(pack("base"), "user.service.ts")).toBe("vscode-icons:file-type-typescript");
  });
});

describe("the framework glyphs", () => {
  const glyphs = Object.entries(LOCAL_ICON_SET.icons);

  it("draw each framework's files on its own mark, and nothing with an id", () => {
    for (const framework of Object.keys(MARKS)) {
      const files = glyphs.filter(([name]) => name.startsWith(`${framework}-`));
      expect(files.length, framework).toBeGreaterThan(5);
      for (const [name, glyph] of files) {
        expect(glyph.body, name).not.toContain("undefined");
        expect(glyph.body, name).not.toContain("TINT");
        expect(glyph.body.match(/ d="([^"]+)"/)?.[1], name).toBe(MARKS[framework][0].d);
      }
    }
    // An id repeated in every row resolves to whichever copy comes first — see `emblems.ts`.
    for (const [name, glyph] of glyphs) expect(glyph.body, name).not.toMatch(/\bid=/);
  });

  it("are made for what the packs name, and nothing else", () => {
    const named = new Set(BUILT_IN_PROFILES.flatMap((profile) => profile.rules.map((rule) => rule.icon)));
    for (const [name] of glyphs) {
      if (name === "iris") continue;
      const id = `cf:${name.replace(/-opened$/, "")}`;
      expect(named.has(id), id).toBe(true);
    }
  });

  it("give React its kinds, with every .tsx a component", () => {
    const react = pack("react");
    expect(iconOf(react, "UserCard.tsx")).toBe("cf:react-component");
    expect(iconOf(react, "main.tsx")).toBe("cf:react-main");
    expect(iconOf(react, "use-mobile.tsx")).toBe("cf:react-hook");
    expect(iconOf(react, "AuthContext.tsx")).toBe("cf:react-context");
    expect(iconOf(react, "ThemeProvider.tsx")).toBe("cf:react-provider");
    expect(iconOf(react, "useCartStore.ts")).toBe("cf:react-store");
    expect(iconOf(react, "cartSlice.ts")).toBe("cf:react-store");
    expect(iconOf(react, "Button.test.tsx")).toBe("cf:react-spec");
    expect(iconOf(react, "Button.stories.tsx")).toBe("vscode-icons:file-type-storybook");
    expect(iconOf(react, "Button.styled.tsx")).toBe("cf:react-style");
    expect(iconOf(react, "login.schema.ts")).toBe("cf:react-validator");
    expect(iconOf(react, "hooks", true)).toBe("cf:folder-hook");
    expect(iconOf(react, "components", true)).toBe("cf:folder-react-component");
    // A camel-case name that only starts like a hook is not one.
    expect(iconOf(react, "users.ts")).toBe("vscode-icons:file-type-typescript");
    expect(iconOf(react, "vite.config.ts")).toBe("vscode-icons:file-type-vite");
    // Next.js draws React's kinds too, under its own reserved names.
    expect(iconOf(pack("nextjs"), "Header.tsx")).toBe("cf:react-component");
    expect(iconOf(pack("nextjs"), "layout.tsx")).toBe("vscode-icons:file-type-layout");
  });

  it("give Angular and Vue theirs", () => {
    const ng = pack("angular");
    expect(iconOf(ng, "card.component.ts")).toBe("cf:angular-component");
    expect(iconOf(ng, "card.component.scss")).toBe("cf:angular-style");
    expect(iconOf(ng, "auth.effects.ts")).toBe("cf:angular-effect");
    expect(iconOf(ng, "environment.prod.ts")).toBe("cf:angular-config");
    expect(iconOf(ng, "components", true)).toBe("cf:folder-angular-component");
    const vue = pack("vue");
    expect(iconOf(vue, "UserCard.vue")).toBe("cf:vue-component");
    expect(iconOf(vue, "use-auth.ts")).toBe("cf:vue-composable");
    expect(iconOf(vue, "cart.store.ts")).toBe("cf:vue-store");
    expect(iconOf(vue, "users.get.ts")).toBe("cf:vue-api");
    expect(iconOf(vue, "composables", true)).toBe("cf:folder-composable");
  });

  it("give Bun its pack, and its lockfile and config to every pack", () => {
    const bun = pack("bun");
    expect(iconOf(bun, "server.ts")).toBe("cf:bun-server");
    expect(iconOf(bun, "build.ts")).toBe("cf:bun-build");
    expect(iconOf(bun, "env.macro.ts")).toBe("cf:bun-macro");
    expect(iconOf(bun, "users.test.ts")).toBe("cf:bun-spec");
    expect(iconOf(bun, "index.ts")).toBe("vscode-icons:file-type-typescript");
    for (const profile of BUILT_IN_PROFILES) {
      expect(iconOf(profile, "bun.lock"), profile.id).toBe("cf:bun-lockfile");
      expect(iconOf(profile, "bunfig.toml"), profile.id).toBe("cf:bun-config");
    }
  });
});

describe("customIconFor", () => {
  it("answers from a new list when the rules change, not from the old list's cache", () => {
    const rules: IconRule[] = [
      { id: "a", target: "file", match: "suffix", pattern: ".ts", icon: "x:ts", enabled: true },
    ];
    expect(customIconFor(rules, "a.ts", false)).toBe("x:ts");
    expect(customIconFor(rules, "a.ts", false)).toBe("x:ts");
    const off = rules.map((rule) => ({ ...rule, enabled: false }));
    expect(customIconFor(off, "a.ts", false)).toBeNull();
    expect(customIconFor(rules, "src/deep/A.TS", false)).toBe("x:ts");
  });
});

describe("upgradeShippedProfiles", () => {
  const v1 = (id: string): IconProfile => {
    // The shape an older install stored: exactly what the previous version shipped.
    const common: IconRule[] = [
      { id: "d-spec", target: "file", match: "suffix", pattern: ".spec.ts", icon: "vscode-icons:file-type-testts", enabled: true },
      { id: "d-test", target: "file", match: "suffix", pattern: ".test.ts", icon: "vscode-icons:file-type-testts", enabled: true },
      { id: "d-src", target: "folder", match: "name", pattern: "src", icon: "vscode-icons:folder-type-src", enabled: true },
      { id: "d-components", target: "folder", match: "name", pattern: "components", icon: "vscode-icons:folder-type-component", enabled: true },
      { id: "d-tests", target: "folder", match: "name", pattern: "tests", icon: "vscode-icons:folder-type-test", enabled: true },
      { id: "d-node-modules", target: "folder", match: "name", pattern: "node_modules", icon: "vscode-icons:folder-type-node", enabled: true },
      { id: "d-git", target: "folder", match: "name", pattern: ".git", icon: "vscode-icons:folder-type-git", enabled: true },
    ];
    return { id, name: id === "base" ? "General" : id, rules: common, defaultFolderIcon: null };
  };

  it("replaces an untouched old General, keeps its name, and adds the packs it never had", () => {
    const stored = [{ ...v1("base"), name: "Mi General" }];
    const result = upgradeShippedProfiles(stored, null, null);
    expect(result.changed).toBe(true);
    expect(result.profiles[0].name).toBe("Mi General");
    expect(result.profiles[0].rules).toEqual(pack("base").rules);
    // Angular and Nest were given to every install before packs, when only the user removed profiles —
    // absent there means deleted on purpose, and that becomes the record.
    expect(result.removed).toEqual(["angular", "nestjs"]);
    expect(result.profiles.map((profile) => profile.id)).toEqual([
      "base",
      "react",
      "nextjs",
      "vue",
      "bun",
      "spring",
      "dotnet",
      "fastapi",
      "django",
      "laravel",
    ]);
    expect(new Set(result.offered)).toEqual(new Set(BUILT_IN_PROFILES.map((profile) => profile.id)));
    expect(result.offered).toEqual(expect.arrayContaining([...V1_OFFERED_IDS]));
  });

  it("leaves an edited copy alone", () => {
    const edited = v1("base");
    edited.rules = edited.rules.map((rule, index) => (index === 0 ? { ...rule, enabled: false } : rule));
    const result = upgradeShippedProfiles([edited], null, null);
    expect(result.profiles[0]).toBe(edited);
  });

  it("is idempotent, so re-reading its own output writes nothing", () => {
    const first = upgradeShippedProfiles([v1("base")], null, null);
    const second = upgradeShippedProfiles(first.profiles, first.offered, first.removed);
    expect(second.changed).toBe(false);
    expect(second.offeredChanged).toBe(false);
    expect(second.removedChanged).toBe(false);
    expect(second.profiles).toEqual(first.profiles);
  });

  it("does not bring back a pack the user deleted", () => {
    const first = upgradeShippedProfiles([v1("base")], null, null);
    const withoutReact = first.profiles.filter((profile) => profile.id !== "react");
    // What `removeProfile` records before it writes the shorter list.
    const second = upgradeShippedProfiles(withoutReact, first.offered, [...first.removed, "react"]);
    expect(second.profiles.some((profile) => profile.id === "react")).toBe(false);
    expect(second.changed).toBe(false);
    expect(second.removedChanged).toBe(false);
  });

  // The row an install was left with on 2026-09-24, verbatim in shape: v2.0.0, opened after a newer
  // build, could not read the eleven references, rewrote the list with its own three, and `offered`
  // still named all eleven. Nobody deleted anything — so nothing may stay missing, whether or not
  // the deletion record exists yet.
  it.each([
    ["before the deletion record existed", null],
    ["after it", [] as string[]],
  ])("brings back packs an older build dropped, %s", (_label, removed) => {
    const stored = ["angular", "nestjs", "base"].map((id) => pack(id));
    const all = BUILT_IN_PROFILES.map((profile) => profile.id);
    const result = upgradeShippedProfiles(stored, all, removed);
    expect(result.profiles.map((profile) => profile.id).sort()).toEqual([...all].sort());
    expect(result.changed).toBe(true);
    expect(result.removed).toEqual([]);
    expect(result.removedChanged).toBe(removed === null);
  });

  it("stops counting a pack as deleted once it is back in the list", () => {
    const stored = BUILT_IN_PROFILES.map((profile) => pack(profile.id));
    const result = upgradeShippedProfiles(stored, BUILT_IN_PROFILES.map((profile) => profile.id), ["react"]);
    expect(result.removed).toEqual([]);
    expect(result.removedChanged).toBe(true);
    expect(result.changed).toBe(false);
  });
});

describe("detectProfileId", () => {
  const probe = (files: Record<string, string>) => ({
    names: Object.keys(files),
    read: async (name: string) => files[name] ?? null,
  });

  it("recognises each stack from its root", async () => {
    expect(await detectProfileId(probe({ "package.json": '{"dependencies":{"@angular/core":"19"}}' }))).toBe("angular");
    expect(await detectProfileId(probe({ "package.json": '{"dependencies":{"@nestjs/core":"11"}}' }))).toBe("nestjs");
    expect(await detectProfileId(probe({ "package.json": '{"dependencies":{"next":"15","react":"19"}}' }))).toBe("nextjs");
    expect(await detectProfileId(probe({ "package.json": '{"dependencies":{"react":"19"}}' }))).toBe("react");
    expect(await detectProfileId(probe({ "package.json": '{"devDependencies":{"nuxt":"3"}}' }))).toBe("vue");
    expect(await detectProfileId(probe({ "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>" }))).toBe("spring");
    expect(await detectProfileId(probe({ "build.gradle.kts": 'id("org.springframework.boot")' }))).toBe("spring");
    expect(await detectProfileId(probe({ "Api.sln": "", "README.md": "" }))).toBe("dotnet");
    expect(await detectProfileId(probe({ "requirements.txt": "fastapi==0.115\nuvicorn" }))).toBe("fastapi");
    expect(await detectProfileId(probe({ "pyproject.toml": 'dependencies = ["Django>=5"]' }))).toBe("django");
    expect(await detectProfileId(probe({ "manage.py": "" }))).toBe("django");
    expect(await detectProfileId(probe({ artisan: "", "composer.json": "{}" }))).toBe("laravel");
    expect(await detectProfileId(probe({ "bun.lock": "", "index.ts": "" }))).toBe("bun");
    expect(await detectProfileId(probe({ "package.json": '{"devDependencies":{"@types/bun":"1"}}' }))).toBe("bun");
  });

  it("reads a React or Vue app that installs with Bun as React or Vue", async () => {
    expect(await detectProfileId(probe({ "bun.lock": "", "package.json": '{"dependencies":{"react":"19"}}' }))).toBe("react");
    expect(await detectProfileId(probe({ "bunfig.toml": "", "package.json": '{"dependencies":{"vue":"3"}}' }))).toBe("vue");
  });

  it("puts the backend ahead of the frontend assets it carries", async () => {
    const laravel = probe({ artisan: "", "package.json": '{"devDependencies":{"vue":"3"}}' });
    expect(await detectProfileId(laravel)).toBe("laravel");
    const django = probe({ "manage.py": "", "package.json": '{"dependencies":{"react":"19"}}' });
    expect(await detectProfileId(django)).toBe("django");
  });

  it("says nothing when nothing is recognised, or a manifest cannot be read", async () => {
    expect(await detectProfileId(probe({ "README.md": "", "main.go": "" }))).toBeNull();
    expect(await detectProfileId(probe({ "package.json": "not json" }))).toBeNull();
    expect(await detectProfileId(probe({ "pom.xml": "<project/>" }))).toBeNull();
  });
});
