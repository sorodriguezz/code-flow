//! NuGet: `PackageReference` in project files, central versions in `Directory.Packages.props`, the
//! legacy `packages.config`, and `packages.lock.json` for what was actually restored.
//!
//! Read with patterns rather than an XML parser on purpose: the bump has to edit the attribute in
//! place (`bump.rs`), so reading and writing must agree on exactly which text a reference is.

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value as Json;

use super::{read, rel, Files};
use crate::deps::{version, Declared, Ecosystem, LockKind, Locked, Lockfile, Scan};

/// `<PackageReference …>`, `<PackageVersion …>`, `<package …>` — the opening tag, attributes and
/// all, plus (for the first two) a `<Version>` child before the closing tag.
pub fn tag_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?s)<(PackageReference|PackageVersion|GlobalPackageReference|package)\b([^>]*?)(/?)>"#).unwrap())
}

pub fn attr(attrs: &str, name: &str) -> Option<String> {
    let re = Regex::new(&format!(r#"(?i)\b{name}\s*=\s*"([^"]*)""#)).ok()?;
    re.captures(attrs).map(|c| c[1].to_string())
}

fn child_version(after: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"(?s)^(.*?)</PackageReference>"#).unwrap());
    let body = re.captures(after)?.get(1)?.as_str();
    static V: OnceLock<Regex> = OnceLock::new();
    let v = V.get_or_init(|| Regex::new(r#"<Version>\s*([^<]*?)\s*</Version>"#).unwrap());
    v.captures(body).map(|c| c[1].to_string())
}

pub fn parse_project(text: &str, manifest: &str) -> Vec<Declared> {
    let mut out = Vec::new();
    for caps in tag_re().captures_iter(text) {
        let element = &caps[1];
        let attrs = &caps[2];
        let self_closing = &caps[3] == "/";
        let Some(name) = attr(attrs, "Include").or_else(|| attr(attrs, "Update")).or_else(|| attr(attrs, "id")) else { continue };
        let mut req = attr(attrs, "Version");
        if req.is_none() && !self_closing && element == "PackageReference" {
            let end = caps.get(0).map(|m| m.end()).unwrap_or(0);
            req = child_version(&text[end..]);
        }
        // No version here means central package management — the row comes from the props file.
        let Some(req) = req else { continue };
        if req.contains("$(") || version::requirement(Ecosystem::Nuget, &req).is_none() {
            continue;
        }
        out.push(Declared {
            ecosystem: Ecosystem::Nuget,
            key: name.clone(),
            name,
            manifest: manifest.to_string(),
            section: element.to_string(),
            requirement: req,
            resolved: None,
            property: None,
        });
    }
    out
}

/// `packages.lock.json`: every target framework's packages → (name, resolved, direct).
pub fn parse_lock(text: &str) -> Vec<(String, String, bool)> {
    let Ok(json) = serde_json::from_str::<Json>(text) else { return vec![] };
    let mut out = Vec::new();
    let Some(frameworks) = json.get("dependencies").and_then(Json::as_object) else { return out };
    for packages in frameworks.values().filter_map(Json::as_object) {
        for (name, entry) in packages {
            let kind = entry.get("type").and_then(Json::as_str).unwrap_or("");
            if kind == "Project" {
                continue;
            }
            if let Some(v) = entry.get("resolved").and_then(Json::as_str) {
                out.push((name.clone(), v.to_string(), kind == "Direct"));
            }
        }
    }
    out
}

pub fn scan(root: &Path, files: &Files, out: &mut Scan) {
    let projects = files.matching(|n| {
        let l = n.to_ascii_lowercase();
        l.ends_with(".csproj") || l.ends_with(".fsproj") || l.ends_with(".vbproj") || l == "directory.packages.props" || l == "packages.config"
    });
    for path in projects {
        let Some(text) = read(path) else { continue };
        let manifest = rel(root, path);
        let mut declared = parse_project(&text, &manifest);
        // A project restored with a lock file says what it got; otherwise the pinned version is it.
        let lock_path = path.parent().map(|d| d.join("packages.lock.json"));
        let locked: HashMap<String, String> = lock_path
            .as_ref()
            .filter(|p| p.is_file())
            .and_then(|p| read(p))
            .map(|t| parse_lock(&t).into_iter().map(|(n, v, _)| (n.to_ascii_lowercase(), v)).collect())
            .unwrap_or_default();
        for d in &mut declared {
            d.resolved = locked.get(&d.name.to_ascii_lowercase()).cloned();
        }
        if !declared.is_empty() || !manifest.to_ascii_lowercase().ends_with("packages.config") {
            out.manifests.push(manifest);
        }
        out.declared.extend(declared);
    }
    for path in files.named("packages.lock.json") {
        let Some(text) = read(path) else { continue };
        let lockfile = rel(root, path);
        out.lockfiles.push(Lockfile { path: lockfile.clone(), kind: LockKind::NugetLock });
        for (name, v, _) in parse_lock(&text) {
            out.locked.push(Locked { ecosystem: Ecosystem::Nuget, name, version: v, lockfile: lockfile.clone() });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_attribute_child_and_central_forms() {
        let csproj = r#"<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <PackageReference Version="[7.0.0]" Include="Serilog"/>
    <PackageReference Include="Dapper">
      <Version>2.0.123</Version>
    </PackageReference>
    <PackageReference Include="Central.Only" />
    <PackageReference Include="Prop.Based" Version="$(PropVersion)" />
  </ItemGroup>
</Project>"#;
        let d = parse_project(csproj, "src/App/App.csproj");
        let rows: Vec<_> = d.iter().map(|d| (d.name.as_str(), d.requirement.as_str())).collect();
        assert_eq!(rows, vec![("Newtonsoft.Json", "13.0.1"), ("Serilog", "[7.0.0]"), ("Dapper", "2.0.123")]);

        let props = r#"<Project><ItemGroup><PackageVersion Include="Central.Only" Version="1.2.3" /></ItemGroup></Project>"#;
        let d = parse_project(props, "Directory.Packages.props");
        assert_eq!((d[0].name.as_str(), d[0].section.as_str()), ("Central.Only", "PackageVersion"));

        let legacy = r#"<packages><package id="jQuery" version="3.6.0" targetFramework="net48" /></packages>"#;
        assert_eq!(parse_project(legacy, "packages.config")[0].requirement, "3.6.0");
    }

    #[test]
    fn reads_packages_lock_json() {
        let lock = r#"{"version":1,"dependencies":{"net8.0":{
          "Newtonsoft.Json":{"type":"Direct","requested":"[13.0.1, )","resolved":"13.0.1"},
          "System.Memory":{"type":"Transitive","resolved":"4.5.5"},
          "MyLib":{"type":"Project"}
        }}}"#;
        let mut rows = parse_lock(lock);
        rows.sort();
        assert_eq!(rows, vec![("Newtonsoft.Json".into(), "13.0.1".into(), true), ("System.Memory".into(), "4.5.5".into(), false)]);
    }
}
