//! What one file says about itself: the symbols it declares, the modules it imports and the names
//! it uses.
//!
//! **Two extractors, one shape.** TypeScript/JavaScript, Java, C# and Python — most of what is
//! opened here — are parsed with tree-sitter: exact symbol ranges, a method nested in its class,
//! imports read off the syntax and names taken only from code, never from a comment or a string.
//! Every other language the review outline knows keeps its regex extractor
//! ([`crate::review::outline::declarations`]): ranges run to the next declaration, imports come from
//! a pattern per language, and a name is any identifier on a line that is not a comment. `precise`
//! says which of the two produced a file, so nothing downstream has to know the list.
//!
//! A file is facts about its *content*: nothing here reads the disk or knows the path's repository,
//! which is what lets [`super`] cache the result by git blob id and reuse it for every branch that
//! carries the same bytes.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use tree_sitter::{Node, Parser};

use crate::review::outline;

/// Bumped whenever what an extractor produces changes, so a cache written by an older build is
/// re-read instead of trusted.
pub const VERSION: u32 = 1;

/// A file bigger than this is generated, vendored or minified in practice — the same ceiling the
/// review's blast radius always used.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;

/// Names a file uses, at most. A generated table or a long test file can mention thousands; the
/// point is "this file uses that symbol", and the first few hundred distinct names cover it.
const MAX_REFS: usize = 1_200;

/// Characters of a declaration's signature kept for comparing two versions of it.
const MAX_SIGNATURE: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Class,
    Interface,
    Type,
    Enum,
    Function,
    Method,
    Const,
    Module,
}

impl Kind {
    pub fn is_container(self) -> bool {
        matches!(self, Kind::Class | Kind::Interface | Kind::Enum | Kind::Module)
    }

    pub fn word(self) -> &'static str {
        match self {
            Kind::Class => "class",
            Kind::Interface => "interface",
            Kind::Type => "type",
            Kind::Enum => "enum",
            Kind::Function => "function",
            Kind::Method => "method",
            Kind::Const => "const",
            Kind::Module => "module",
        }
    }
}

/// One declaration.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Sym {
    pub name: String,
    pub kind: Kind,
    /// 1-based, inclusive.
    pub start: u32,
    /// 1-based, inclusive.
    pub end: u32,
    /// The declaration's first line, trimmed and elided — what a list shows.
    pub label: String,
    /// The declaration up to its body, whitespace collapsed — what two versions are compared by. A
    /// parameter added on the third line of a signature changes this and not the label.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub signature: String,
    /// The symbol this one is declared inside (a method's class), by index in the same file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<u32>,
}

/// Everything one file says about itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Facts {
    /// The language family — `ts`, `java`, `cs`, `py`, or the regex family (`rs`, `go`, `sql`…).
    pub lang: String,
    pub lines: u32,
    /// Parsed with tree-sitter rather than matched with regexes.
    pub precise: bool,
    pub symbols: Vec<Sym>,
    /// Module specifiers as written — `./cart`, `com.acme.Pago`, `System.Linq`, `..models`.
    pub imports: Vec<String>,
    /// Imports this file re-exports for others (`export … from`, a package's `__init__.py`,
    /// `pub use`): whoever imports this file reaches these too.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reexports: Vec<String>,
    /// The package or namespace the file declares (Java, Kotlin, C#, Go, PHP).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub namespace: Option<String>,
    /// Each distinct name the file uses, with the first line it appears on, sorted by name.
    pub refs: Vec<(String, u32)>,
}

/// How a path's content is read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    TypeScript,
    Tsx,
    Java,
    CSharp,
    Python,
    /// Any other language the review outline has declaration patterns for.
    Other,
}

fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map(|(_, ext)| ext.to_ascii_lowercase()).unwrap_or_default()
}

/// How `path` is read, or `None` for a file that is not code (configuration, docs, images).
pub fn language_of(path: &str) -> Option<Lang> {
    let ext = extension(path);
    Some(match ext.as_str() {
        "ts" | "mts" | "cts" => Lang::TypeScript,
        // TSX's grammar reads JavaScript and JSX as well — a React project's `.js` files are JSX.
        "tsx" | "js" | "jsx" | "mjs" | "cjs" => Lang::Tsx,
        "java" => Lang::Java,
        "cs" => Lang::CSharp,
        "py" | "pyi" => Lang::Python,
        _ if outline::has_patterns(path) => Lang::Other,
        _ => return None,
    })
}

/// The language family a path belongs to — what [`Facts::lang`] holds, and what decides whether
/// two files can import each other.
pub fn family_of(path: &str) -> String {
    let ext = extension(path);
    match ext.as_str() {
        "ts" | "mts" | "cts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "vue" | "svelte" => "ts",
        "java" | "kt" | "kts" | "scala" | "groovy" => "java",
        "cs" => "cs",
        "py" | "pyi" => "py",
        "rs" => "rs",
        "go" => "go",
        "php" => "php",
        "rb" => "rb",
        "swift" => "swift",
        "dart" => "dart",
        "c" | "h" | "cpp" | "hpp" | "cc" | "hh" | "cxx" | "m" | "mm" => "c",
        "sql" | "pks" | "pkb" => "sql",
        "cls" | "mac" | "int" | "inc" => "cos",
        "sh" | "bash" | "zsh" => "sh",
        "ps1" | "psm1" => "ps",
        other => return other.to_string(),
    }
    .to_string()
}

/// Reads one file. Never fails: content no extractor understands comes back with no symbols.
pub fn extract(path: &str, content: &str) -> Facts {
    let lang = language_of(path);
    let parsed = match lang {
        Some(Lang::Other) | None => None,
        Some(lang) => parse(lang, path, content),
    };
    let mut facts = parsed.unwrap_or_else(|| by_regex(path, content));
    facts.lang = family_of(path);
    facts.lines = content.lines().count() as u32;
    facts
}

// ------------------------------------------------------------------------------------ tree-sitter

thread_local! {
    /// One parser per thread, re-pointed at each file's language — building a parser is cheap, but
    /// a scan reads thousands of files.
    static PARSER: RefCell<Parser> = RefCell::new(Parser::new());
}

fn grammar(lang: Lang) -> Option<tree_sitter::Language> {
    Some(match lang {
        Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
        Lang::Java => tree_sitter_java::LANGUAGE.into(),
        Lang::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
        Lang::Python => tree_sitter_python::LANGUAGE.into(),
        Lang::Other => return None,
    })
}

fn parse(lang: Lang, path: &str, content: &str) -> Option<Facts> {
    let language = grammar(lang)?;
    let tree = PARSER.with(|parser| {
        let mut parser = parser.borrow_mut();
        parser.set_language(&language).ok()?;
        parser.parse(content, None)
    })?;
    let mut walk = Walk { lang, src: content, lines: content.lines().collect(), facts: Facts::default(), refs: BTreeMap::new() };
    walk.facts.precise = true;
    walk.run(tree.root_node(), path);
    let mut facts = walk.facts;
    facts.refs = walk.refs.into_iter().take(MAX_REFS).collect();
    Some(facts)
}

struct Walk<'s> {
    lang: Lang,
    src: &'s str,
    lines: Vec<&'s str>,
    facts: Facts,
    refs: BTreeMap<String, u32>,
}

impl<'s> Walk<'s> {
    fn text(&self, node: Node) -> &'s str {
        node.utf8_text(self.src.as_bytes()).unwrap_or_default()
    }

    fn run(&mut self, root: Node, path: &str) {
        let python_package = self.lang == Lang::Python && path.rsplit('/').next() == Some("__init__.py");
        // An explicit stack rather than recursion: a deeply nested generated file must not be able to
        // overflow the thread's stack.
        let mut stack: Vec<(Node, Option<u32>)> = vec![(root, None)];
        while let Some((node, parent)) = stack.pop() {
            let mut inner = parent;
            if let Some(sym) = self.declaration(node, parent) {
                self.facts.symbols.push(sym);
                inner = Some(self.facts.symbols.len() as u32 - 1);
            }
            self.imports(node, python_package);
            if self.is_name(node) {
                let name = self.text(node);
                if name.len() >= 3 && !self.refs.contains_key(name) {
                    self.refs.insert(name.to_string(), node.start_position().row as u32 + 1);
                }
            }
            let mut cursor = node.walk();
            let children: Vec<Node> = node.children(&mut cursor).collect();
            for child in children.into_iter().rev() {
                stack.push((child, inner));
            }
        }
        if let Some(namespace) = &self.facts.namespace {
            let namespace = namespace.trim().to_string();
            self.facts.namespace = (!namespace.is_empty()).then_some(namespace);
        }
    }

    fn is_name(&self, node: Node) -> bool {
        match self.lang {
            Lang::TypeScript | Lang::Tsx => matches!(
                node.kind(),
                "identifier" | "type_identifier" | "property_identifier" | "shorthand_property_identifier"
            ),
            Lang::Java => matches!(node.kind(), "identifier" | "type_identifier"),
            Lang::CSharp | Lang::Python => node.kind() == "identifier",
            Lang::Other => false,
        }
    }

    fn declaration(&self, node: Node, parent: Option<u32>) -> Option<Sym> {
        let parent_kind = parent.and_then(|i| self.facts.symbols.get(i as usize)).map(|s| s.kind);
        let in_class = parent_kind.is_some_and(Kind::is_container);
        let (kind, name_node, span) = match (self.lang, node.kind()) {
            (Lang::TypeScript | Lang::Tsx, kind) => match kind {
                "class_declaration" | "abstract_class_declaration" => (Kind::Class, node.child_by_field_name("name")?, node),
                "interface_declaration" => (Kind::Interface, node.child_by_field_name("name")?, node),
                "type_alias_declaration" => (Kind::Type, node.child_by_field_name("name")?, node),
                "enum_declaration" => (Kind::Enum, node.child_by_field_name("name")?, node),
                "function_declaration" | "generator_function_declaration" => {
                    (Kind::Function, node.child_by_field_name("name")?, node)
                }
                "method_definition" => (Kind::Method, node.child_by_field_name("name")?, node),
                "internal_module" | "module" => (Kind::Module, node.child_by_field_name("name")?, node),
                "public_field_definition" => {
                    let value = node.child_by_field_name("value")?;
                    if !matches!(value.kind(), "arrow_function" | "function_expression" | "function") {
                        return None;
                    }
                    (Kind::Method, node.child_by_field_name("name")?, node)
                }
                // A function-valued property of an object a module-level const builds — a zustand
                // store's actions (`openInEditor: (path) => set(…)`), an API object's methods.
                "pair" => {
                    let value = node.child_by_field_name("value")?;
                    if !matches!(value.kind(), "arrow_function" | "function_expression" | "function") || parent_kind != Some(Kind::Const) {
                        return None;
                    }
                    let key = node.child_by_field_name("key").filter(|k| matches!(k.kind(), "property_identifier" | "identifier"))?;
                    (Kind::Method, key, node)
                }
                "variable_declarator" => {
                    let name = node.child_by_field_name("name").filter(|n| n.kind() == "identifier")?;
                    let value = node.child_by_field_name("value");
                    let kind = match value.map(|v| v.kind()) {
                        Some("arrow_function" | "function_expression" | "function" | "generator_function") => Kind::Function,
                        Some("class") => Kind::Class,
                        _ if self.top_level(node) => Kind::Const,
                        _ => return None,
                    };
                    // The whole statement, so `export const x = () => {` keeps its `export`.
                    let span = node.parent().filter(|p| matches!(p.kind(), "lexical_declaration" | "variable_declaration")).unwrap_or(node);
                    (kind, name, span)
                }
                _ => return None,
            },
            (Lang::Java, kind) => match kind {
                "class_declaration" | "record_declaration" => (Kind::Class, node.child_by_field_name("name")?, node),
                "interface_declaration" | "annotation_type_declaration" => (Kind::Interface, node.child_by_field_name("name")?, node),
                "enum_declaration" => (Kind::Enum, node.child_by_field_name("name")?, node),
                "method_declaration" | "constructor_declaration" => (Kind::Method, node.child_by_field_name("name")?, node),
                _ => return None,
            },
            (Lang::CSharp, kind) => match kind {
                "class_declaration" | "struct_declaration" | "record_declaration" | "record_struct_declaration" => {
                    (Kind::Class, node.child_by_field_name("name")?, node)
                }
                "interface_declaration" => (Kind::Interface, node.child_by_field_name("name")?, node),
                "enum_declaration" => (Kind::Enum, node.child_by_field_name("name")?, node),
                "delegate_declaration" => (Kind::Type, node.child_by_field_name("name")?, node),
                "method_declaration" | "constructor_declaration" | "local_function_statement" => {
                    (Kind::Method, node.child_by_field_name("name")?, node)
                }
                _ => return None,
            },
            (Lang::Python, kind) => match kind {
                "class_definition" => (Kind::Class, node.child_by_field_name("name")?, decorated(node)),
                "function_definition" => {
                    (if in_class { Kind::Method } else { Kind::Function }, node.child_by_field_name("name")?, decorated(node))
                }
                _ => return None,
            },
            (Lang::Other, _) => return None,
        };
        let name = self.text(name_node).trim().to_string();
        if name.is_empty() {
            return None;
        }
        let start = span.start_position().row as u32 + 1;
        let end = (span.end_position().row as u32 + 1).max(start);
        let label = self.lines.get(start as usize - 1).map(|line| outline::label_of(line)).unwrap_or_default();
        let signature = self.signature(span, node);
        Some(Sym { name, kind, start, end, label, signature, parent })
    }

    /// The declaration's text up to its body, whitespace collapsed.
    fn signature(&self, span: Node, node: Node) -> String {
        let body_start = node
            .child_by_field_name("body")
            .or_else(|| node.child_by_field_name("value").and_then(|v| v.child_by_field_name("body")))
            .map(|body| body.start_byte())
            .unwrap_or_else(|| span.end_byte().min(span.start_byte() + MAX_SIGNATURE * 2));
        let end = body_start.max(span.start_byte()).min(self.src.len());
        let raw = self.src.get(span.start_byte()..end).unwrap_or_default();
        let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
        let collapsed = collapsed.trim_end_matches(['{', ':', '=', '>']).trim().to_string();
        collapsed.chars().take(MAX_SIGNATURE).collect()
    }

    /// Whether a TS/JS declarator sits at module level — `const store = create(…)` is worth naming,
    /// a `const i = 0` inside a function is not.
    fn top_level(&self, declarator: Node) -> bool {
        let Some(statement) = declarator.parent() else { return false };
        match statement.parent() {
            Some(p) if p.kind() == "program" => true,
            Some(p) if p.kind() == "export_statement" => p.parent().is_some_and(|g| g.kind() == "program"),
            _ => false,
        }
    }

    fn imports(&mut self, node: Node, python_package: bool) {
        match (self.lang, node.kind()) {
            (Lang::TypeScript | Lang::Tsx, "import_statement") => {
                if let Some(source) = node.child_by_field_name("source") {
                    self.facts.imports.push(unquote(self.text(source)));
                }
            }
            (Lang::TypeScript | Lang::Tsx, "export_statement") => {
                if let Some(source) = node.child_by_field_name("source") {
                    self.facts.reexports.push(unquote(self.text(source)));
                }
            }
            (Lang::TypeScript | Lang::Tsx, "call_expression") => {
                let callee = node.child_by_field_name("function").map(|f| self.text(f));
                if matches!(callee, Some("require" | "import")) {
                    let first = node
                        .child_by_field_name("arguments")
                        .and_then(|args| args.named_child(0))
                        .filter(|arg| arg.kind() == "string");
                    if let Some(arg) = first {
                        self.facts.imports.push(unquote(self.text(arg)));
                    }
                }
            }
            (Lang::Java, "package_declaration") => {
                let name = node.named_child(0).map(|n| self.text(n).to_string());
                if self.facts.namespace.is_none() {
                    self.facts.namespace = name;
                }
            }
            (Lang::Java, "import_declaration") => {
                let mut cursor = node.walk();
                let mut name = String::new();
                let mut wildcard = false;
                for child in node.children(&mut cursor) {
                    match child.kind() {
                        "scoped_identifier" | "identifier" => name = self.text(child).to_string(),
                        "asterisk" => wildcard = true,
                        _ => {}
                    }
                }
                if !name.is_empty() {
                    self.facts.imports.push(if wildcard { format!("{name}.*") } else { name });
                }
            }
            (Lang::CSharp, "namespace_declaration" | "file_scoped_namespace_declaration") => {
                if self.facts.namespace.is_none() {
                    self.facts.namespace = node.child_by_field_name("name").map(|n| self.text(n).to_string());
                }
            }
            (Lang::CSharp, "using_directive") => {
                let mut cursor = node.walk();
                let name = node
                    .children(&mut cursor)
                    .filter(|child| matches!(child.kind(), "qualified_name" | "identifier"))
                    .last()
                    .map(|child| self.text(child).to_string());
                if let Some(name) = name {
                    self.facts.imports.push(name);
                }
            }
            (Lang::Python, "import_statement") => {
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    let module = match child.kind() {
                        "dotted_name" => Some(child),
                        "aliased_import" => child.child_by_field_name("name"),
                        _ => None,
                    };
                    if let Some(module) = module {
                        self.push_python(self.text(module).to_string(), python_package);
                    }
                }
            }
            (Lang::Python, "import_from_statement") => {
                let Some(module) = node.child_by_field_name("module_name") else { return };
                let module = self.text(module).to_string();
                // `from . import utils` names the modules after `import`, not the package itself.
                if !module.chars().all(|c| c == '.') {
                    self.push_python(module.clone(), python_package);
                }
                // `from pkg import models` imports a module as often as it imports a name: offer
                // both, and resolution keeps whichever is a file.
                let mut cursor = node.walk();
                for child in node.children_by_field_name("name", &mut cursor) {
                    let name = match child.kind() {
                        "aliased_import" => child.child_by_field_name("name").map(|n| self.text(n)),
                        _ => Some(self.text(child)),
                    };
                    if let Some(name) = name.filter(|n| !n.is_empty()) {
                        let joined = if module.ends_with('.') { format!("{module}{name}") } else { format!("{module}.{name}") };
                        self.push_python(joined, python_package);
                    }
                }
            }
            _ => {}
        }
    }

    fn push_python(&mut self, module: String, python_package: bool) {
        if python_package {
            self.facts.reexports.push(module);
        } else {
            self.facts.imports.push(module);
        }
    }
}

/// A Python definition's span includes its decorators — a reviewer reading `@app.route` above a
/// handler needs to see it.
fn decorated(node: Node) -> Node {
    node.parent().filter(|p| p.kind() == "decorated_definition").unwrap_or(node)
}

fn unquote(text: &str) -> String {
    text.trim().trim_matches(['"', '\'', '`']).to_string()
}

// ------------------------------------------------------------------------------------------ regex

fn by_regex(path: &str, content: &str) -> Facts {
    let mut facts = Facts::default();
    for decl in outline::declarations(path, content) {
        let Some((name, kind)) = regex_symbol(&decl.label) else { continue };
        facts.symbols.push(Sym {
            name,
            kind,
            start: decl.start as u32,
            end: decl.end as u32,
            signature: decl.label.clone(),
            label: decl.label,
            parent: None,
        });
    }
    let family = family_of(path);
    regex_imports(&family, content, &mut facts);
    facts.refs = regex_refs(content);
    facts
}

/// The name and kind of a regex-matched declaration, or `None` for one that declares nothing new
/// (a Rust `impl` block).
fn regex_symbol(label: &str) -> Option<(String, Kind)> {
    static OBJECTSCRIPT_CLASS: OnceLock<Regex> = OnceLock::new();
    let trimmed = label.trim_start();
    if trimmed.starts_with("impl") && trimmed[4..].starts_with([' ', '<']) {
        return None;
    }
    // `Class Pkg.Sub.Name Extends …` — named by its last segment, which is what other code writes.
    let cos = OBJECTSCRIPT_CLASS.get_or_init(|| Regex::new(r"(?i)^Class\s+([\w.%]+)").expect("valid regex"));
    if let Some(caps) = cos.captures(trimmed) {
        let full = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        let last = full.rsplit('.').next().unwrap_or(full).to_string();
        return (!last.is_empty()).then_some((last, Kind::Class));
    }
    // `fn scoped<F: Future>(app: …)`: the word after the keyword, before any generics — the outline's
    // "first word followed by a parenthesis" finds nothing there, or the wrong word.
    static KEYWORD_FN: OnceLock<Regex> = OnceLock::new();
    let keyword_fn = KEYWORD_FN.get_or_init(|| {
        Regex::new(r"\b(?:fn|func|def|function|fun)\s*(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)").expect("valid regex")
    });
    let name = match keyword_fn.captures(trimmed) {
        Some(caps) => caps[1].to_string(),
        None => outline::symbol_name(label)?,
    };
    let words: Vec<String> = label.split(|c: char| !c.is_alphanumeric() && c != '_').map(str::to_ascii_lowercase).collect();
    let has = |w: &str| words.iter().any(|x| x == w);
    let kind = if has("class") || has("struct") || has("record") || has("object") {
        Kind::Class
    } else if has("interface") || has("trait") || has("protocol") {
        Kind::Interface
    } else if has("enum") {
        Kind::Enum
    } else if has("type") && !label.contains('(') {
        Kind::Type
    } else if has("mod") || has("module") || has("namespace") || has("package") {
        Kind::Module
    } else if has("table") || has("view") || has("procedure") || has("trigger") {
        Kind::Type
    } else {
        Kind::Function
    };
    Some((name, kind))
}

fn regex_imports(family: &str, content: &str, facts: &mut Facts) {
    struct Patterns {
        ts: Vec<Regex>,
        rust_use: Regex,
        rust_mod: Regex,
        go_block: Regex,
        go_quoted: Regex,
        go_single: Regex,
        go_package: Regex,
        jvm_import: Regex,
        jvm_package: Regex,
        php_use: Regex,
        php_namespace: Regex,
        ruby: Regex,
        c_include: Regex,
        dart: Regex,
    }
    static PATTERNS: OnceLock<Patterns> = OnceLock::new();
    let p = PATTERNS.get_or_init(|| {
        let r = |s: &str| Regex::new(s).expect("valid import regex");
        Patterns {
            ts: vec![
                r(r#"(?m)^\s*(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]"#),
                r(r#"(?m)^\s*import\s*['"]([^'"]+)['"]"#),
                r(r#"\brequire\(\s*['"]([^'"]+)['"]\s*\)"#),
                r(r#"\bimport\(\s*['"]([^'"]+)['"]\s*\)"#),
            ],
            rust_use: r(r"(?m)^\s*(pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)"),
            rust_mod: r(r"(?m)^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;"),
            go_block: r(r"(?s)\bimport\s*\(([^)]*)\)"),
            go_quoted: r(r#""([^"]+)""#),
            go_single: r(r#"(?m)^\s*import\s+(?:[\w.]+\s+)?"([^"]+)""#),
            go_package: r(r"(?m)^\s*package\s+(\w+)"),
            jvm_import: r(r"(?m)^\s*import\s+(?:static\s+)?([\w.]+)(\.\*)?"),
            jvm_package: r(r"(?m)^\s*package\s+([\w.]+)"),
            php_use: r(r"(?m)^\s*use\s+([\w\\]+)"),
            php_namespace: r(r"(?m)^\s*namespace\s+([\w\\]+)"),
            ruby: r(r#"(?m)^\s*require(_relative)?\s*\(?\s*['"]([^'"]+)['"]"#),
            c_include: r(r#"(?m)^\s*#\s*(?:include|import)\s*"([^"]+)""#),
            dart: r(r#"(?m)^\s*(?:import|export)\s+['"]([^'"]+)['"]"#),
        }
    });
    let mut push = |spec: &str| {
        let spec = spec.trim();
        if !spec.is_empty() && !facts.imports.iter().any(|known| known == spec) {
            facts.imports.push(spec.to_string());
        }
    };
    match family {
        "ts" => {
            for pattern in &p.ts {
                for caps in pattern.captures_iter(content) {
                    push(&caps[1]);
                }
            }
        }
        "rs" => {
            for caps in p.rust_use.captures_iter(content) {
                let path = caps[2].trim_end_matches("::").to_string();
                if caps.get(1).is_some() {
                    facts.reexports.push(path);
                } else {
                    push(&path);
                }
            }
            for caps in p.rust_mod.captures_iter(content) {
                facts.reexports.push(format!("mod:{}", &caps[1]));
            }
        }
        "go" => {
            for block in p.go_block.captures_iter(content) {
                for caps in p.go_quoted.captures_iter(&block[1]) {
                    push(&caps[1]);
                }
            }
            for caps in p.go_single.captures_iter(content) {
                push(&caps[1]);
            }
            facts.namespace = p.go_package.captures(content).map(|c| c[1].to_string());
        }
        "java" | "swift" => {
            for caps in p.jvm_import.captures_iter(content) {
                let wildcard = caps.get(2).is_some();
                push(&if wildcard { format!("{}.*", &caps[1]) } else { caps[1].to_string() });
            }
            facts.namespace = p.jvm_package.captures(content).map(|c| c[1].to_string());
        }
        "php" => {
            for caps in p.php_use.captures_iter(content) {
                push(&caps[1]);
            }
            facts.namespace = p.php_namespace.captures(content).map(|c| c[1].to_string());
        }
        "rb" => {
            for caps in p.ruby.captures_iter(content) {
                let spec = &caps[2];
                push(&if caps.get(1).is_some() && !spec.starts_with('.') { format!("./{spec}") } else { spec.to_string() });
            }
        }
        "c" => {
            for caps in p.c_include.captures_iter(content) {
                push(&caps[1]);
            }
        }
        "dart" => {
            for caps in p.dart.captures_iter(content) {
                push(&caps[1]);
            }
        }
        _ => {}
    }
}

/// Every distinct identifier on a line that is not a comment, with its first line.
fn regex_refs(content: &str) -> Vec<(String, u32)> {
    static WORD: OnceLock<Regex> = OnceLock::new();
    let word = WORD.get_or_init(|| Regex::new(r"[A-Za-z_][A-Za-z0-9_]{2,}").expect("valid word regex"));
    let mut refs: BTreeMap<String, u32> = BTreeMap::new();
    for (index, line) in content.lines().enumerate() {
        let trimmed = line.trim_start();
        if ["//", "#", "--", "*", "/*", ";", "'"].iter().any(|marker| trimmed.starts_with(marker)) && !trimmed.starts_with("#include") {
            continue;
        }
        for found in word.find_iter(line) {
            refs.entry(found.as_str().to_string()).or_insert(index as u32 + 1);
        }
    }
    refs.into_iter().take(MAX_REFS).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(facts: &Facts) -> Vec<(&str, Kind)> {
        facts.symbols.iter().map(|s| (s.name.as_str(), s.kind)).collect()
    }

    fn uses(facts: &Facts, name: &str) -> bool {
        facts.refs.iter().any(|(n, _)| n == name)
    }

    const TS: &str = "\
import { PagoRepository } from './repo';
import type { Pago } from '../models/pago';
export * from './util';
const fs = require('fs');

// guardarPago is mentioned here, in a comment
export async function pagar(dto: PagoDto,
                            opts: Options): Promise<number> {
  const repo = new PagoRepository();
  return repo.guardar(dto);
}

export const useCart = create(() => ({ items: [] }));

export const total = (items: Item[]) => items.length;

export class Servicio extends Base {
  private nombre = 'x';
  procesar(pago: Pago) {
    if (pago) {
      return this.repo.guardar(pago);
    }
  }
  handler = () => {
    return 1;
  };
}

interface Opciones { a: number }
type Id = string;
enum Estado { A, B }
";

    #[test]
    fn typescript_symbols_are_exact_and_nested() {
        let facts = extract("src/pago.ts", TS);
        assert!(facts.precise);
        assert_eq!(facts.lang, "ts");
        let got = names(&facts);
        for expected in [
            ("pagar", Kind::Function),
            ("useCart", Kind::Const),
            ("total", Kind::Function),
            ("Servicio", Kind::Class),
            ("procesar", Kind::Method),
            ("handler", Kind::Method),
            ("Opciones", Kind::Interface),
            ("Id", Kind::Type),
            ("Estado", Kind::Enum),
        ] {
            assert!(got.contains(&expected), "missing {expected:?} in {got:?}");
        }
        let pagar = facts.symbols.iter().find(|s| s.name == "pagar").unwrap();
        assert_eq!((pagar.start, pagar.end), (7, 11), "the whole function, signature on two lines");
        assert!(pagar.label.starts_with("export async function pagar"));
        assert!(pagar.signature.contains("opts: Options"), "the signature spans lines: {}", pagar.signature);
        let procesar = facts.symbols.iter().find(|s| s.name == "procesar").unwrap();
        let class = facts.symbols.iter().position(|s| s.name == "Servicio").unwrap() as u32;
        assert_eq!(procesar.parent, Some(class));
        assert!(!got.iter().any(|(n, _)| *n == "repo"), "a local const is not a symbol");
    }

    #[test]
    fn typescript_imports_and_names_come_from_code_only() {
        let facts = extract("src/pago.ts", TS);
        let store = facts.symbols.iter().find(|s| s.name == "useCart").unwrap();
        assert_eq!(store.kind, Kind::Const);
        assert_eq!(facts.imports, vec!["./repo", "../models/pago", "fs"]);
        assert_eq!(facts.reexports, vec!["./util"]);
        assert!(uses(&facts, "PagoRepository"));
        assert!(uses(&facts, "guardar"), "a method call is a use");
        assert!(!uses(&facts, "guardarPago"), "a comment is not a use");
    }

    #[test]
    fn a_stores_actions_are_its_members() {
        let src = "export const useUi = create<Ui>((set) => ({\n  open: false,\n  openInEditor: (path: string) => set({ path }),\n  close() { set({ open: false }); },\n}));\nfunction local() {\n  const handlers = { onClick: () => 1 };\n}\n";
        let facts = extract("src/ui.ts", src);
        let got = names(&facts);
        assert!(got.contains(&("openInEditor", Kind::Method)), "{got:?}");
        assert!(got.contains(&("close", Kind::Method)));
        assert!(!got.iter().any(|(n, _)| *n == "open"), "a value is not a member worth naming");
        assert!(!got.iter().any(|(n, _)| *n == "onClick"), "an object inside a function is not a store");
        let action = facts.symbols.iter().find(|s| s.name == "openInEditor").unwrap();
        assert_eq!(facts.symbols[action.parent.unwrap() as usize].name, "useUi");
    }

    #[test]
    fn javascript_with_jsx_parses() {
        let src = "import Button from './Button';\nexport default function App() {\n  return <Button onClick={go}>Hi</Button>;\n}\n";
        let facts = extract("src/App.jsx", src);
        assert!(facts.precise);
        assert!(names(&facts).contains(&("App", Kind::Function)));
        assert!(uses(&facts, "Button"));
        assert_eq!(facts.imports, vec!["./Button"]);
    }

    #[test]
    fn java_reads_package_imports_and_members() {
        let src = "\
package com.acme.pagos;

import com.acme.repo.PagoRepository;
import com.acme.util.*;

@Service
public class PagoService {
    private final PagoRepository repo;

    public PagoService(PagoRepository repo) {
        this.repo = repo;
    }

    public void pagar(Pago pago) {
        repo.guardar(pago);
    }
}
";
        let facts = extract("src/main/java/com/acme/pagos/PagoService.java", src);
        assert!(facts.precise);
        assert_eq!(facts.namespace.as_deref(), Some("com.acme.pagos"));
        assert_eq!(facts.imports, vec!["com.acme.repo.PagoRepository", "com.acme.util.*"]);
        let got = names(&facts);
        assert!(got.contains(&("PagoService", Kind::Class)));
        assert!(got.contains(&("pagar", Kind::Method)));
        assert!(uses(&facts, "guardar"));
        let class = facts.symbols.iter().find(|s| s.name == "PagoService" && s.kind == Kind::Class).unwrap();
        assert_eq!(class.start, 6, "the annotation belongs to the class");
    }

    #[test]
    fn csharp_reads_namespace_and_usings() {
        let src = "\
using System.Linq;
using Acme.Data;

namespace Acme.Pagos
{
    public class PagoService : IPagoService
    {
        public async Task<int> Pagar(PagoDto dto)
        {
            return await _repo.Guardar(dto);
        }
    }
}
";
        let facts = extract("Pagos/PagoService.cs", src);
        assert!(facts.precise);
        assert_eq!(facts.namespace.as_deref(), Some("Acme.Pagos"));
        assert_eq!(facts.imports, vec!["System.Linq", "Acme.Data"]);
        assert!(names(&facts).contains(&("Pagar", Kind::Method)));
        assert!(uses(&facts, "Guardar"));
        assert!(uses(&facts, "IPagoService"));
    }

    #[test]
    fn python_reads_relative_imports_methods_and_decorators() {
        let src = "\
from .models import Pago
from . import utils
import os.path as p

class Servicio(Base):
    @property
    def total(self):
        return calcular(self.items)

@app.route('/x')
def handler():
    pass
";
        let facts = extract("app/servicio.py", src);
        assert!(facts.precise);
        assert!(facts.imports.contains(&".models".to_string()));
        assert!(facts.imports.contains(&".models.Pago".to_string()));
        assert!(facts.imports.contains(&".utils".to_string()));
        assert!(!facts.imports.contains(&".".to_string()), "the bare package is not an import of its own");
        assert!(facts.imports.contains(&"os.path".to_string()));
        let got = names(&facts);
        assert!(got.contains(&("total", Kind::Method)));
        assert!(got.contains(&("handler", Kind::Function)));
        let handler = facts.symbols.iter().find(|s| s.name == "handler").unwrap();
        assert_eq!(handler.start, 10, "the decorator is part of the definition");
        assert!(uses(&facts, "calcular"));
    }

    #[test]
    fn a_package_init_re_exports_what_it_imports() {
        let facts = extract("app/__init__.py", "from .servicio import Servicio\n");
        assert!(facts.imports.is_empty());
        assert!(facts.reexports.contains(&".servicio".to_string()));
    }

    #[test]
    fn other_languages_fall_back_to_the_outline() {
        let rs = "use crate::db::queries;\npub use self::model::Pago;\nmod model;\n\npub fn alpha() -> u32 {\n    queries::count()\n}\n\nimpl Pago {\n    fn beta(&self) {}\n}\n";
        let facts = extract("src/lib.rs", rs);
        assert!(!facts.precise);
        assert_eq!(facts.lang, "rs");
        let got = names(&facts);
        assert!(got.contains(&("alpha", Kind::Function)));
        assert!(got.contains(&("beta", Kind::Function)));
        assert!(!got.iter().any(|(n, _)| *n == "Pago"), "an impl block declares nothing");
        assert_eq!(facts.imports, vec!["crate::db::queries"]);
        assert!(facts.reexports.contains(&"self::model::Pago".to_string()));
        assert!(facts.reexports.contains(&"mod:model".to_string()));
        let generic = extract("src/run.rs", "pub async fn scoped<F: Future>(app: AppHandle, run_id: Option<String>, fut: F) -> F::Output {\n}\n");
        assert_eq!(names(&generic), vec![("scoped", Kind::Function)]);
        let method = extract("a.go", "func (r *Repo) Guardar(p Pago) error {\n\treturn nil\n}\n");
        assert_eq!(names(&method), vec![("Guardar", Kind::Function)]);
        assert!(uses(&facts, "queries"));

        let cls = "Class Acme.Pagos.Servicio Extends %Persistent\n{\nClassMethod Pagar() As %Status\n{\n quit ##class(Acme.Repo).Guardar()\n}\n}\n";
        let facts = extract("src/Acme/Pagos/Servicio.cls", cls);
        let got = names(&facts);
        assert!(got.contains(&("Servicio", Kind::Class)));
        assert!(got.contains(&("Pagar", Kind::Function)));
        assert!(uses(&facts, "Guardar"));
    }

    #[test]
    fn go_reads_its_import_block_and_package() {
        let src = "package pagos\n\nimport (\n\t\"fmt\"\n\t\"github.com/acme/app/internal/repo\"\n)\n\nfunc Pagar() {\n\trepo.Guardar()\n}\n";
        let facts = extract("internal/pagos/pagar.go", src);
        assert_eq!(facts.namespace.as_deref(), Some("pagos"));
        assert_eq!(facts.imports, vec!["fmt", "github.com/acme/app/internal/repo"]);
    }

    #[test]
    fn non_code_has_no_language() {
        assert!(language_of("package.json").is_none());
        assert!(language_of("README.md").is_none());
        assert!(language_of("logo.png").is_none());
        assert_eq!(language_of("a/b.tsx"), Some(Lang::Tsx));
        assert_eq!(language_of("a/b.go"), Some(Lang::Other));
    }

    #[test]
    fn broken_code_still_yields_what_it_can() {
        let facts = extract("src/a.ts", "export function ok() { return 1 }\nexport function broken( {\n");
        assert!(names(&facts).contains(&("ok", Kind::Function)));
    }
}
