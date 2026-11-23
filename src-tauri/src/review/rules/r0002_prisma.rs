//! R-0002 — a Prisma schema change without its migration.
//!
//! For each `schema.prisma` the PR changes: does the PR also ADD something under the schema's
//! `migrations/`? If it does, nothing to report. If the project has no
//! `migrations/migration_lock.toml` at the source commit it does not use migrations
//! (`prisma db push`): nothing to report either. Otherwise the facts name the schema and the
//! migrations the PR only edited, and the reviewer judges whether the change reaches the database
//! (a comment or a generator tweak does not). Port of the reference tool's `rules/R-0002.py`.

use futures_util::future::BoxFuture;
use serde_json::json;

use super::{capped, Facts, Rule, RuleCx, RuleMeta};

const SCHEMA_NAME: &str = "schema.prisma";

static META: RuleMeta = RuleMeta {
    id: "R-0002",
    title: "Cambio en schema.prisma sin su migración",
    severity: "Mayor",
    categories: &["missing-migration"],
    paths: &["**/schema.prisma"],
    levels: &["completo", "ultra"],
    enabled: true,
    timeout_secs: 60,
    instruction: "Los hechos listan cada schema de Prisma que este PR cambia SIN una carpeta nueva bajo su migrations/, \
en un proyecto que usa migraciones (existe migration_lock.toml). Si el cambio altera la base de datos (un model, un campo, \
un tipo, un atributo como @unique/@default/@relation/@@index, un valor de enum) reporta UN hallazgo por schema: tipo Bug, \
severidad Mayor, confianza 85, anclado en sus líneas cambiadas — desplegarlo deja la base desincronizada del cliente. \
Un cambio que no llega a la base (comentarios, formato, generator o datasource) no es hallazgo. migrations_edited: una \
migración ya aplicada que se editó nunca se vuelve a correr; dilo en el porqué.",
};

pub struct Prisma;

impl Rule for Prisma {
    fn meta(&self) -> &'static RuleMeta {
        &META
    }

    fn evaluate<'a>(&'a self, cx: &'a RuleCx<'a>) -> BoxFuture<'a, Result<Facts, String>> {
        Box::pin(collect(cx))
    }
}

async fn collect(cx: &RuleCx<'_>) -> Result<Facts, String> {
    let schemas: Vec<&String> = cx.matched.iter().filter(|p| p.as_str() == SCHEMA_NAME || p.ends_with(&format!("/{SCHEMA_NAME}"))).collect();
    if schemas.is_empty() {
        return Ok(Facts::NotApplicable("el PR no cambia un schema.prisma".into()));
    }
    let mut out = Vec::new();
    for schema in schemas {
        let base = schema.rsplit_once('/').map(|(dir, _)| format!("{dir}/")).unwrap_or_default();
        let prefix = format!("{base}migrations/");
        if cx.files.iter().any(|f| f.added && f.path.starts_with(&prefix)) {
            continue;
        }
        let lock = format!("{prefix}migration_lock.toml");
        match cx.source.read(&lock).await {
            Ok(None) => continue, // no migrations in this project: `prisma db push`
            Ok(Some(_)) => {}
            Err(e) => return Err(format!("no se pudo leer {lock}: {e}")),
        }
        let edited: Vec<String> = cx.files.iter().filter(|f| !f.added && f.path.starts_with(&prefix)).map(|f| f.path.clone()).collect();
        let mut entry = json!({ "schema": schema, "migrations_dir": prefix.trim_end_matches('/'), "migration_added": false });
        if !edited.is_empty() {
            entry["migrations_edited"] = json!(capped(edited));
        }
        out.push(entry);
    }
    if out.is_empty() {
        return Ok(Facts::NotApplicable("cada schema cambiado trae su migración (o el proyecto no usa migraciones)".into()));
    }
    Ok(Facts::Found(json!({ "schemas": out })))
}

#[cfg(test)]
mod tests {
    use super::super::source::fake::{FakeNet, Files};
    use super::super::PrFile;
    use super::*;

    fn file(path: &str, added: bool) -> PrFile {
        PrFile { path: path.into(), added, ..Default::default() }
    }

    async fn run(files: &[PrFile], source: &Files) -> Result<Facts, String> {
        let matched: Vec<String> = files.iter().filter(|f| f.path.ends_with("schema.prisma")).map(|f| f.path.clone()).collect();
        let net = FakeNet::default();
        let cx = RuleCx { matched: &matched, files, source, net: &net, today: chrono::NaiveDate::MIN, now: 0 };
        collect(&cx).await
    }

    #[tokio::test]
    async fn a_schema_without_its_migration_is_a_fact() {
        let lock = Files::with(&[("prisma/migrations/migration_lock.toml", "provider = \"postgresql\"")]);
        let files = [file("prisma/schema.prisma", false), file("prisma/migrations/2024_init/migration.sql", false)];
        let Ok(Facts::Found(facts)) = run(&files, &lock).await else { panic!("expected facts") };
        assert_eq!(
            facts,
            json!({ "schemas": [{ "schema": "prisma/schema.prisma", "migrations_dir": "prisma/migrations", "migration_added": false,
                                   "migrations_edited": ["prisma/migrations/2024_init/migration.sql"] }] })
        );
    }

    #[tokio::test]
    async fn an_added_migration_or_no_migrations_at_all_is_fine() {
        let lock = Files::with(&[("prisma/migrations/migration_lock.toml", "x")]);
        let with_migration = [file("prisma/schema.prisma", false), file("prisma/migrations/2025_add/migration.sql", true)];
        assert!(matches!(run(&with_migration, &lock).await, Ok(Facts::NotApplicable(_))));
        let db_push = [file("schema.prisma", false)];
        assert!(matches!(run(&db_push, &Files::default()).await, Ok(Facts::NotApplicable(_))));
    }
}
