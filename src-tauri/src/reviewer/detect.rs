//! What a repository is built with, and the commands a company's pipeline would run on it.
//!
//! The Reviewer's stages — prepare, build, test — are commands the user owns and can edit; this only
//! proposes them, from the files at the repository's root. Every proposal writes its reports where
//! [`super::reports`] looks: `CODEFLOW_REPORTS_DIR`, an environment variable each stage gets, set to a
//! folder of the app's — so measuring a project never adds a file to it.
//!
//! Coverage is asked for without touching the project: Maven runs JaCoCo by its full plugin
//! coordinates, Vitest and Jest take reporter flags. Where that can't be done without a dependency
//! the project doesn't have, the proposal goes without coverage and a note says what's missing.

use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::services::detect::{build_tool, declared_manager, venv_python, Host};

/// A note for the UI, as a stable code — the sentence is the frontend's, in the user's language.
pub type Note = &'static str;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    /// What was recognised, in display form: "Maven", "Node · pnpm", "Vitest".
    pub stacks: Vec<String>,
    pub prepare: String,
    pub build: String,
    pub test: String,
    pub notes: Vec<Note>,
    /// The SonarQube project key this repository is analysed under.
    pub project_key: String,
    /// The repository carries its own `sonar-project.properties`, which wins over CodeFlow's defaults.
    pub has_properties: bool,
}

/// `$CODEFLOW_REPORTS_DIR` as the platform's shell spells it.
fn reports_var(host: &Host) -> &'static str {
    if host.windows { "%CODEFLOW_REPORTS_DIR%" } else { "$CODEFLOW_REPORTS_DIR" }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// `sonar-project.properties`, as key → value. Only what a properties file can say on one line.
pub fn project_properties(repo: &Path) -> std::collections::BTreeMap<String, String> {
    let mut map = std::collections::BTreeMap::new();
    let Ok(text) = std::fs::read_to_string(repo.join("sonar-project.properties")) else { return map };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with('!') {
            continue;
        }
        if let Some((key, value)) = line.split_once(['=', ':']) {
            map.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    map
}

/// The key a repository is analysed under: the one its `sonar-project.properties` declares, the
/// override from the project's settings, or its folder's name plus a short hash of its path — two
/// clones named alike must not share one project and overwrite each other's results.
pub fn project_key(repo: &Path, name: &str, override_key: &str) -> String {
    if let Some(key) = project_properties(repo).get("sonar.projectKey").filter(|k| !k.is_empty()) {
        return key.clone();
    }
    let custom = sanitize_key(override_key);
    if !custom.is_empty() {
        return custom;
    }
    let display = if name.trim().is_empty() {
        repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    } else {
        name.to_string()
    };
    let base = sanitize_key(&display);
    let canonical = std::fs::canonicalize(repo).unwrap_or_else(|_| repo.to_path_buf());
    let hash = hex::encode(Sha256::digest(canonical.to_string_lossy().as_bytes()));
    let base = if base.is_empty() { "project".to_string() } else { base };
    format!("{base}-{}", &hash[..6])
}

/// SonarQube keys allow letters, digits, `-`, `_`, `.` and `:`, and need one character that isn't a digit.
pub fn sanitize_key(raw: &str) -> String {
    let mut key = String::new();
    for c in raw.trim().chars() {
        let c = if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ':') { c.to_ascii_lowercase() } else { '-' };
        if !(c == '-' && key.ends_with('-')) {
            key.push(c);
        }
    }
    let key = key.trim_matches('-').to_string();
    if !key.is_empty() && key.chars().all(|c| c.is_ascii_digit()) {
        return format!("p-{key}");
    }
    key.chars().take(200).collect()
}

pub fn suggest(repo: &Path, name: &str, override_key: &str) -> Suggestion {
    suggest_on(repo, name, override_key, &Host::current())
}

pub fn suggest_on(repo: &Path, name: &str, override_key: &str, host: &Host) -> Suggestion {
    let mut suggestion = Suggestion {
        stacks: Vec::new(),
        prepare: String::new(),
        build: String::new(),
        test: String::new(),
        notes: Vec::new(),
        project_key: project_key(repo, name, override_key),
        has_properties: repo.join("sonar-project.properties").is_file(),
    };
    let reports = reports_var(host);

    if repo.join("pom.xml").is_file() {
        let mvn = build_tool(repo, host, "mvnw", "mvnw.cmd", "mvn");
        let jacoco = format!("org.jacoco:jacoco-maven-plugin:{}", super::catalog::JACOCO_VERSION);
        suggestion.stacks.push("Maven".into());
        suggestion.build = format!("{mvn} -B -DskipTests compile");
        suggestion.test = format!("{mvn} -B {jacoco}:prepare-agent test {jacoco}:report");
    } else if repo.join("build.gradle").is_file() || repo.join("build.gradle.kts").is_file() {
        let gradle = build_tool(repo, host, "gradlew", "gradlew.bat", "gradle");
        let script = std::fs::read_to_string(repo.join("build.gradle"))
            .or_else(|_| std::fs::read_to_string(repo.join("build.gradle.kts")))
            .unwrap_or_default();
        suggestion.stacks.push("Gradle".into());
        suggestion.build = format!("{gradle} classes testClasses");
        if script.contains("jacoco") {
            suggestion.test = format!("{gradle} test jacocoTestReport");
        } else {
            suggestion.test = format!("{gradle} test");
            suggestion.notes.push("gradle-no-jacoco");
        }
    } else if let Some(package) = read_json(&repo.join("package.json")) {
        let manager = declared_manager(repo).unwrap_or_else(|| "npm".to_string());
        let exec = match manager.as_str() {
            "pnpm" => "pnpm exec",
            "yarn" => "yarn",
            "bun" => "bunx",
            _ => "npx",
        };
        let run = |script: &str| match manager.as_str() {
            "npm" => format!("npm run {script}"),
            "bun" => format!("bun run {script}"),
            other => format!("{other} {script}"),
        };
        let mut dependencies: Vec<String> = Vec::new();
        for field in ["dependencies", "devDependencies"] {
            if let Some(map) = package.get(field).and_then(Value::as_object) {
                dependencies.extend(map.keys().cloned());
            }
        }
        let has = |name: &str| dependencies.iter().any(|d| d == name);
        let scripts = package.get("scripts").and_then(Value::as_object).cloned().unwrap_or_default();
        suggestion.stacks.push(format!("Node · {manager}"));

        if !repo.join("node_modules").is_dir() {
            suggestion.prepare = match manager.as_str() {
                "pnpm" => "pnpm install --frozen-lockfile".into(),
                "yarn" => "yarn install --frozen-lockfile".into(),
                "bun" => "bun install".into(),
                _ => if repo.join("package-lock.json").is_file() { "npm ci".into() } else { "npm install".into() },
            };
        }
        if let Some(script) = ["typecheck", "type-check", "check-types", "tsc"].iter().find(|s| scripts.contains_key(**s)) {
            suggestion.build = run(script);
        } else if has("typescript") && repo.join("tsconfig.json").is_file() {
            suggestion.stacks.push("TypeScript".into());
            suggestion.build = format!("{exec} tsc --noEmit");
        }

        if has("vitest") {
            suggestion.stacks.push("Vitest".into());
            let mut command = format!(
                "{exec} vitest run --reporter=default --reporter=junit --outputFile.junit=\"{reports}/junit.xml\""
            );
            if has("@vitest/coverage-v8") || has("@vitest/coverage-istanbul") {
                command.push_str(&format!(
                    " --coverage --coverage.reporter=lcov --coverage.reporter=text-summary --coverage.reportsDirectory=\"{reports}/coverage\""
                ));
            } else {
                suggestion.notes.push("vitest-no-coverage");
            }
            suggestion.test = command;
        } else if has("jest") {
            suggestion.stacks.push("Jest".into());
            let mut command = format!(
                "{exec} jest --ci --coverage --coverageReporters=lcov --coverageReporters=text-summary --coverageDirectory=\"{reports}/coverage\""
            );
            if has("jest-junit") {
                // jest-junit reads JEST_JUNIT_OUTPUT_DIR, which every stage gets.
                command.push_str(" --reporters=default --reporters=jest-junit");
            }
            suggestion.test = command;
        } else if let Some(test) = scripts.get("test").and_then(Value::as_str) {
            // npm's placeholder for "no tests" fails on purpose; proposing it would fail every review.
            if !test.contains("no test specified") {
                suggestion.test = run("test");
            }
        }
    } else if repo.join("pyproject.toml").is_file() || repo.join("requirements.txt").is_file() || repo.join("setup.py").is_file() {
        let python = venv_python(repo, host.windows).unwrap_or_else(|| host.system_python.to_string());
        let manifest = ["pyproject.toml", "requirements.txt", "requirements-dev.txt", "setup.cfg"]
            .iter()
            .filter_map(|f| std::fs::read_to_string(repo.join(f)).ok())
            .collect::<String>();
        suggestion.stacks.push("Python".into());
        let mut command = format!("{python} -m pytest --junitxml=\"{reports}/junit.xml\"");
        if manifest.contains("pytest-cov") {
            command.push_str(&format!(" --cov=. --cov-report=xml:\"{reports}/coverage.xml\""));
        } else {
            suggestion.notes.push("pytest-no-coverage");
        }
        suggestion.test = command;
    } else if repo.join("go.mod").is_file() {
        suggestion.stacks.push("Go".into());
        suggestion.build = "go build ./...".into();
        suggestion.test = format!("go test ./... -coverprofile=\"{reports}/coverage.out\"");
    } else if repo.join("Cargo.toml").is_file() {
        suggestion.stacks.push("Rust".into());
        suggestion.build = "cargo check --all-targets".into();
        suggestion.test = "cargo test".into();
        suggestion.notes.push("rust-no-coverage");
    }

    let has_dotnet = std::fs::read_dir(repo)
        .map(|entries| {
            entries.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                name.ends_with(".sln") || name.ends_with(".csproj") || name.ends_with(".fsproj") || name.ends_with(".vbproj")
            })
        })
        .unwrap_or(false);
    if has_dotnet {
        suggestion.stacks.push(".NET".into());
        if suggestion.test.is_empty() {
            suggestion.build = "dotnet build".into();
            suggestion.test = "dotnet test".into();
        }
        // The CLI scanner doesn't analyse C# or VB.NET: that takes SonarScanner for .NET wrapped around
        // an MSBuild build. The rest of the repository is still analysed.
        suggestion.notes.push("dotnet-needs-msbuild");
    }
    if repo.join("CMakeLists.txt").is_file() || (repo.join("Makefile").is_file() && has_c_sources(repo)) {
        // C and C++ are commercial-edition languages; Community Build skips them.
        suggestion.notes.push("cpp-not-in-community");
    }
    suggestion
}

fn has_c_sources(repo: &Path) -> bool {
    std::fs::read_dir(repo)
        .map(|entries| {
            entries.flatten().any(|e| {
                let name = e.file_name().to_string_lossy().to_lowercase();
                [".c", ".cc", ".cpp", ".cxx", ".h", ".hpp"].iter().any(|ext| name.ends_with(ext))
            })
        })
        .unwrap_or(false)
}

/// Whether the repository has Java sources — the Java analyzer refuses to run without compiled
/// classes to go with them.
pub fn has_java(repo: &Path) -> bool {
    !super::reports::find(repo, None, &|p| p.extension().is_some_and(|e| e == "java")).is_empty()
}

/// Compiled-class folders the Java analyzer can read, wherever Maven or Gradle put them.
pub fn java_binaries(repo: &Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    let mut stack = vec![(repo.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if matches!(name.as_str(), "node_modules" | ".git" | ".gradle" | ".idea") {
                continue;
            }
            let classes = (name == "classes" && dir.file_name().is_some_and(|n| n == "target"))
                || (name == "main" && dir.ends_with(Path::new("build").join("classes").join("java")))
                || (name == "main" && dir.ends_with(Path::new("build").join("classes").join("kotlin")));
            if classes {
                found.push(path);
            } else if depth < 7 {
                stack.push((path, depth + 1));
            }
        }
    }
    found.sort();
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("cf-reviewer-detect-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn unix() -> Host {
        Host { windows: false, system_python: "python3" }
    }

    #[test]
    fn keys_are_sanitized_and_never_all_digits() {
        assert_eq!(sanitize_key("My App (v2)"), "my-app-v2");
        assert_eq!(sanitize_key("  "), "");
        assert_eq!(sanitize_key("2026"), "p-2026");
        assert_eq!(sanitize_key("acme:api"), "acme:api");
    }

    #[test]
    fn the_properties_file_names_the_key_when_it_has_one() {
        let dir = temp();
        assert!(project_key(&dir, "Demo App", "").starts_with("demo-app-"));
        assert_eq!(project_key(&dir, "Demo App", "custom key"), "custom-key");
        std::fs::write(dir.join("sonar-project.properties"), "# x\nsonar.projectKey=acme_api\nsonar.sources=src\n").unwrap();
        assert_eq!(project_key(&dir, "Demo App", "custom"), "acme_api");
        assert_eq!(project_properties(&dir).get("sonar.sources").map(String::as_str), Some("src"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn maven_measures_coverage_without_touching_the_pom() {
        let dir = temp();
        std::fs::write(dir.join("pom.xml"), "<project/>").unwrap();
        std::fs::write(dir.join("mvnw"), "").unwrap();
        let s = suggest_on(&dir, "x", "", &unix());
        assert_eq!(s.stacks, vec!["Maven"]);
        assert!(s.test.starts_with("./mvnw -B org.jacoco:jacoco-maven-plugin:"));
        assert!(s.test.ends_with(":report"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vitest_writes_junit_and_lcov_to_the_reports_folder() {
        let dir = temp();
        std::fs::write(
            dir.join("package.json"),
            r#"{"devDependencies":{"vitest":"3","@vitest/coverage-v8":"3","typescript":"5"},"scripts":{"typecheck":"tsc --noEmit"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("pnpm-lock.yaml"), "").unwrap();
        let s = suggest_on(&dir, "x", "", &unix());
        assert_eq!(s.prepare, "pnpm install --frozen-lockfile");
        assert_eq!(s.build, "pnpm typecheck");
        assert!(s.test.contains("--outputFile.junit=\"$CODEFLOW_REPORTS_DIR/junit.xml\""));
        assert!(s.test.contains("--coverage.reporter=lcov"));
        assert!(s.notes.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn vitest_without_a_coverage_provider_runs_without_coverage_and_says_so() {
        let dir = temp();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"devDependencies":{"vitest":"3"}}"#).unwrap();
        let s = suggest_on(&dir, "x", "", &unix());
        assert_eq!(s.prepare, "");
        assert!(!s.test.contains("--coverage"));
        assert_eq!(s.notes, vec!["vitest-no-coverage"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn npms_placeholder_test_script_is_not_proposed() {
        let dir = temp();
        std::fs::create_dir_all(dir.join("node_modules")).unwrap();
        std::fs::write(dir.join("package.json"), r#"{"scripts":{"test":"echo \"Error: no test specified\" && exit 1"}}"#).unwrap();
        assert_eq!(suggest_on(&dir, "x", "", &unix()).test, "");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn windows_spells_the_reports_variable_its_way() {
        let dir = temp();
        std::fs::write(dir.join("go.mod"), "module x").unwrap();
        let s = suggest_on(&dir, "x", "", &Host { windows: true, system_python: "python" });
        assert!(s.test.contains("%CODEFLOW_REPORTS_DIR%"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compiled_classes_are_found_where_maven_and_gradle_put_them() {
        let dir = temp();
        std::fs::create_dir_all(dir.join("api/target/classes")).unwrap();
        std::fs::create_dir_all(dir.join("web/build/classes/java/main")).unwrap();
        std::fs::create_dir_all(dir.join("web/build/classes/java/test")).unwrap();
        let found = java_binaries(&dir);
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|p| p.ends_with("api/target/classes")));
        assert!(found.iter().any(|p| p.ends_with("web/build/classes/java/main")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
