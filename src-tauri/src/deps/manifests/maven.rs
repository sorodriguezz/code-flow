//! Maven: `<dependency>` blocks of a `pom.xml`, with `${property}` versions resolved from the same
//! file's `<properties>`. A version inherited from a parent POM or a BOM is not in this file and is
//! left out — guessing it would report a version the build does not use. Gradle is not read.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;

use super::{read, rel, Files};
use crate::deps::{version, Declared, Ecosystem, Scan};

pub fn dependency_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?s)<dependency>(.*?)</dependency>").unwrap())
}

pub fn element(body: &str, tag: &str) -> Option<String> {
    let re = Regex::new(&format!(r"(?s)<{tag}>\s*([^<]*?)\s*</{tag}>")).ok()?;
    re.captures(body).map(|c| c[1].to_string())
}

pub fn properties(text: &str) -> HashMap<String, String> {
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    static PROP: OnceLock<Regex> = OnceLock::new();
    let block = BLOCK.get_or_init(|| Regex::new(r"(?s)<properties>(.*?)</properties>").unwrap());
    let prop = PROP.get_or_init(|| Regex::new(r"<([A-Za-z0-9_.\-]+)>\s*([^<]*?)\s*</([A-Za-z0-9_.\-]+)>").unwrap());
    let mut out = HashMap::new();
    for b in block.captures_iter(text) {
        for p in prop.captures_iter(&b[1]) {
            if p[1] == p[3] {
                out.insert(p[1].to_string(), p[2].to_string());
            }
        }
    }
    out
}

pub fn parse_pom(text: &str, manifest: &str) -> Vec<Declared> {
    let props = properties(text);
    let mut out = Vec::new();
    for caps in dependency_re().captures_iter(text) {
        let body = &caps[1];
        let (Some(group), Some(artifact), Some(raw)) = (element(body, "groupId"), element(body, "artifactId"), element(body, "version")) else {
            continue;
        };
        let (requirement, property) = match raw.strip_prefix("${").and_then(|r| r.strip_suffix('}')) {
            Some(name) => match props.get(name) {
                Some(v) => (v.clone(), Some(name.to_string())),
                None => continue,
            },
            None => (raw.clone(), None),
        };
        if version::parse(&requirement).is_none() {
            continue;
        }
        let name = format!("{group}:{artifact}");
        out.push(Declared {
            ecosystem: Ecosystem::Maven,
            key: name.clone(),
            name,
            manifest: manifest.to_string(),
            section: element(body, "scope").unwrap_or_else(|| "compile".into()),
            resolved: Some(requirement.clone()),
            requirement,
            property,
        });
    }
    out
}

pub fn scan(root: &Path, files: &Files, out: &mut Scan) {
    for path in files.named("pom.xml") {
        let Some(text) = read(path) else { continue };
        let manifest = rel(root, path);
        out.declared.extend(parse_pom(&text, &manifest));
        out.manifests.push(manifest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_literal_and_property_versions() {
        let pom = r#"<project>
  <parent><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-parent</artifactId><version>3.2.0</version></parent>
  <properties>
    <jackson.version>2.15.2</jackson.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.google.guava</groupId>
      <artifactId>guava</artifactId>
      <version>32.1.2-jre</version>
    </dependency>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope>
    </dependency>
  </dependencies>
</project>"#;
        let rows: Vec<_> = parse_pom(pom, "pom.xml").into_iter().map(|d| (d.name, d.requirement, d.property, d.section)).collect();
        assert_eq!(
            rows,
            vec![
                ("com.google.guava:guava".into(), "32.1.2-jre".into(), None, "compile".into()),
                ("com.fasterxml.jackson.core:jackson-databind".into(), "2.15.2".into(), Some("jackson.version".into()), "compile".into()),
                ("junit:junit".into(), "4.13.2".into(), None, "test".into()),
            ]
        );
    }
}
