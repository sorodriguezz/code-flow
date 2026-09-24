import { listDir, readFileText } from "../tauri/commands";

/**
 * Which shipped icon pack a repository looks like, read off its root.
 *
 * This is what makes the packs apply "by default" (the user's words): a repository that never chose
 * a profile gets the one its stack calls for — a Spring checkout draws its controllers and its
 * `application.yml` as Spring's, without anyone opening Settings. A choice made in the panel still
 * wins over this, always; see `iconRulesStore`.
 *
 * Only the root is read, and only a handful of small files: a directory listing, and then at most
 * the manifest that can settle the question (`package.json`, `pom.xml`, `composer.json`, a Python
 * requirements file). Nothing recursive — a monorepo whose stacks live one level down gets General,
 * which is the honest answer for a root that is several things at once.
 *
 * **Backends are asked first.** A Laravel, Django or Spring app very often carries a `package.json`
 * for its frontend assets — with Vue or React in it — and the stack that decides what the tree is
 * made of is still the backend's. The file that proves a backend (`artisan`, `manage.py`, a `.sln`,
 * a Spring Boot build) is specific enough that its presence at the root is the answer.
 */

export interface RepoProbe {
  /** The names at the repository's root, files and folders. */
  names: string[];
  /** A root file's text, `null` when it cannot be read. */
  read: (name: string) => Promise<string | null>;
}

/** The shipped pack id for this root, or `null` when nothing is recognised. */
export async function detectProfileId(probe: RepoProbe): Promise<string | null> {
  const byLower = new Map(probe.names.map((name) => [name.toLowerCase(), name]));
  const has = (name: string) => byLower.has(name);
  const read = (name: string) => probe.read(byLower.get(name) ?? name);
  const any = (test: RegExp) => probe.names.some((name) => test.test(name));

  // .NET: a solution or a project file is the whole signal.
  if (any(/\.(sln|slnx|csproj|fsproj|vbproj)$/i)) return "dotnet";

  // Spring Boot: a Maven or Gradle build that pulls in Boot.
  for (const build of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
    if (!has(build)) continue;
    const text = await read(build);
    if (text && /spring-boot|org\.springframework\.boot/.test(text)) return "spring";
  }

  // Laravel: `artisan` is the tell; the framework in `composer.json` is the backup.
  if (has("artisan")) return "laravel";
  if (has("composer.json") && (await read("composer.json"))?.includes("laravel/framework")) return "laravel";

  // Python: Django has its own entry point; otherwise the dependency list says which framework.
  if (has("manage.py")) return "django";
  const manifests = probe.names
    .filter((name) => /^(requirements[^/]*\.(txt|in)|pyproject\.toml|pipfile|setup\.py|setup\.cfg)$/i.test(name))
    .slice(0, 4);
  for (const name of manifests) {
    const text = ((await probe.read(name)) ?? "").toLowerCase();
    if (/\bfastapi\b/.test(text)) return "fastapi";
    if (/\bdjango\b/.test(text)) return "django";
  }

  // JavaScript and TypeScript: the CLIs' own config files, then the dependencies.
  if (has("angular.json")) return "angular";
  if (has("nest-cli.json")) return "nestjs";
  if (has("package.json")) {
    const deps = dependenciesOf(await read("package.json"));
    // Angular before Nest: a workspace holding both is mostly components by file count.
    if (deps.has("@angular/core")) return "angular";
    if (deps.has("@nestjs/core")) return "nestjs";
    if (deps.has("next")) return "nextjs";
    if (deps.has("nuxt") || deps.has("vue")) return "vue";
    if (deps.has("react")) return "react";
  }
  if (any(/^next\.config\./i)) return "nextjs";
  if (any(/^nuxt\.config\./i)) return "vue";
  return null;
}

function dependenciesOf(json: string | null): Set<string> {
  if (!json) return new Set();
  try {
    const manifest = JSON.parse(json) as Record<string, unknown>;
    const names = new Set<string>();
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const block = manifest[field];
      if (block && typeof block === "object") for (const name of Object.keys(block)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

/** `detectProfileId` against a real checkout. Never throws: an unreadable root is "not recognised". */
export async function detectRepoProfile(repoPath: string): Promise<string | null> {
  const entries = await listDir(repoPath).catch(() => []);
  return detectProfileId({
    names: entries.map((entry) => entry.name),
    read: (name) => readFileText(repoPath, name).catch(() => null),
  }).catch(() => null);
}
