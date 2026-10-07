//! Values that need care to get right: Markdown for each chat app («Formato para chat»), numbers by
//! locale («Números»), data checked and normalised («Validar datos»), realistic fake data («Datos de
//! prueba») and the first, last or a page of the items («Limitar»).

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use rand::{Rng, SeedableRng};
use serde_json::{json, Map, Value};

use super::{flag, number, text, NodeCtx, NodeError};
use crate::flows::run::{Item, Ports};
use crate::flows::value::{get_path, set_path, to_number, to_text};

pub async fn execute(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    match ctx.node.type_id.as_str() {
        "transform.chatFormat" => per_item(ctx, |params, json| {
            let rendered = chat_format(&text(params, "text"), &text(params, "chatTarget"));
            Ok(with_target(json, &text(params, "target"), "text", rendered))
        })
        .await,
        "transform.number" => per_item(ctx, |params, json| {
            let value = number_op(params)?;
            Ok(with_target(json, &text(params, "target"), "number", value))
        })
        .await,
        "transform.validate" => validate(ctx).await,
        "data.fake" => fake(ctx),
        "transform.limit" => limit(ctx).await,
        other => Err(NodeError::failed(format!("No executor for {other}"))),
    }
}

fn with_target(json: &Value, target: &str, fallback: &str, value: Value) -> Value {
    let mut out = if json.is_object() { json.clone() } else { json!({}) };
    let field = if target.trim().is_empty() { fallback } else { target.trim() };
    set_path(&mut out, field, value);
    out
}

async fn per_item(ctx: &NodeCtx, f: impl Fn(&Value, &Value) -> Result<Value, NodeError>) -> Result<Ports, NodeError> {
    let resolved = ctx.resolve_each().await?;
    let items = ctx.items();
    let mut out = Vec::with_capacity(items.len().max(1));
    for index in 0..items.len().max(1) {
        let params = &resolved[index.min(resolved.len() - 1)];
        let json = items.get(index).map(|item| item.json.clone()).unwrap_or(json!({}));
        let produced = f(params, &json)?;
        out.push(if items.is_empty() { Item::new(produced) } else { Item::paired(produced, index) });
    }
    Ok(vec![out])
}

// ------------------------------------------------------------------------------ chat formatting

#[derive(Clone, Copy, PartialEq)]
enum Dialect {
    Slack,
    Telegram,
    TelegramHtml,
    Whatsapp,
    Plain,
}

/// Markdown (what a model writes) in the dialect a chat app reads.
pub fn chat_format(markdown: &str, target: &str) -> Value {
    match target {
        "fmtHtml" => {
            let mut html = String::new();
            pulldown_cmark::html::push_html(&mut html, Parser::new_ext(markdown, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH));
            Value::String(html)
        }
        "fmtDiscord" => Value::String(discord(markdown)),
        "fmtTeams" => teams_card(markdown),
        "fmtTelegram" => Value::String(render(markdown, Dialect::Telegram)),
        "fmtTelegramHtml" => Value::String(render(markdown, Dialect::TelegramHtml)),
        "fmtWhatsapp" => Value::String(render(markdown, Dialect::Whatsapp)),
        "fmtPlain" => Value::String(render(markdown, Dialect::Plain)),
        _ => Value::String(render(markdown, Dialect::Slack)),
    }
}

/// Telegram's MarkdownV2 rejects a message with any of these unescaped outside an entity.
fn tg_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if "_*[]()~`>#+-=|{}.!\\".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn html_escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn escape(text: &str, dialect: Dialect) -> String {
    match dialect {
        Dialect::Telegram => tg_escape(text),
        Dialect::TelegramHtml => html_escape(text),
        // Slack treats &, < and > as control characters.
        Dialect::Slack => html_escape(text),
        _ => text.to_string(),
    }
}

/// A table's rows as aligned plain text — every dialect but HTML shows one as code.
fn table_text(rows: &[Vec<String>]) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    let widths: Vec<usize> = (0..columns).map(|c| rows.iter().map(|r| r.get(c).map(|s| s.chars().count()).unwrap_or(0)).max().unwrap_or(0)).collect();
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        let line: Vec<String> = (0..columns).map(|c| format!("{:<w$}", row.get(c).cloned().unwrap_or_default(), w = widths[c])).collect();
        out.push_str(line.join("  ").trim_end());
        out.push('\n');
        if i == 0 && rows.len() > 1 {
            out.push_str(&widths.iter().map(|w| "-".repeat(*w)).collect::<Vec<_>>().join("  "));
            out.push('\n');
        }
    }
    out
}

fn render(markdown: &str, dialect: Dialect) -> String {
    let parser = Parser::new_ext(markdown, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH);
    let mut out = String::new();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut link_stack: Vec<String> = Vec::new();
    let mut link_text = String::new();
    let mut in_link = false;
    let mut code_block: Option<String> = None;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut cell = String::new();
    let mut quote = 0usize;
    let push = |out: &mut String, text: &str, in_link: bool, link_text: &mut String| {
        if in_link {
            link_text.push_str(text);
        } else {
            out.push_str(text);
        }
    };
    let (bold, italic, strike) = match dialect {
        Dialect::Slack | Dialect::Whatsapp => ("*", "_", "~"),
        Dialect::Telegram => ("*", "_", "~"),
        Dialect::TelegramHtml => ("<b>", "<i>", "<s>"),
        Dialect::Plain => ("", "", ""),
    };
    let close = |open: &str| -> String {
        if open.starts_with('<') { open.replacen('<', "</", 1) } else { open.to_string() }
    };
    for event in parser {
        if let Some(rows) = table.as_mut() {
            match &event {
                Event::End(TagEnd::Table) => {
                    let body = table_text(rows);
                    out.push_str(&match dialect {
                        Dialect::TelegramHtml => format!("<pre>{}</pre>\n", html_escape(&body)),
                        Dialect::Plain => body,
                        Dialect::Telegram => format!("```\n{}```\n", body.replace('\\', "\\\\").replace('`', "\\`")),
                        _ => format!("```\n{body}```\n"),
                    });
                    table = None;
                }
                Event::Start(Tag::TableHead) | Event::Start(Tag::TableRow) => rows.push(Vec::new()),
                Event::End(TagEnd::TableCell) => {
                    if let Some(row) = rows.last_mut() {
                        row.push(std::mem::take(&mut cell).trim().to_string());
                    }
                }
                Event::Text(t) | Event::Code(t) => cell.push_str(t),
                _ => {}
            }
            continue;
        }
        if let Some(code) = code_block.as_mut() {
            match &event {
                Event::Text(t) => code.push_str(t),
                Event::End(TagEnd::CodeBlock) => {
                    let body = code_block.take().unwrap_or_default();
                    let body = body.trim_end_matches('\n');
                    out.push_str(&match dialect {
                        Dialect::TelegramHtml => format!("<pre>{}</pre>\n\n", html_escape(body)),
                        Dialect::Telegram => format!("```\n{}\n```\n\n", body.replace('\\', "\\\\").replace('`', "\\`")),
                        Dialect::Plain => format!("{body}\n\n"),
                        Dialect::Slack => format!("```\n{}\n```\n\n", html_escape(body)),
                        Dialect::Whatsapp => format!("```{body}```\n\n"),
                    });
                }
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::Paragraph) => {}
            Event::End(TagEnd::Paragraph) => {
                out.push_str(if lists.is_empty() { "\n\n" } else { "\n" });
            }
            Event::Start(Tag::Heading { .. }) => push(&mut out, bold, in_link, &mut link_text),
            Event::End(TagEnd::Heading(level)) => {
                push(&mut out, &close(bold), in_link, &mut link_text);
                out.push_str(if level <= HeadingLevel::H2 { "\n\n" } else { "\n" });
            }
            Event::Start(Tag::Strong) => push(&mut out, bold, in_link, &mut link_text),
            Event::End(TagEnd::Strong) => push(&mut out, &close(bold), in_link, &mut link_text),
            Event::Start(Tag::Emphasis) => push(&mut out, italic, in_link, &mut link_text),
            Event::End(TagEnd::Emphasis) => push(&mut out, &close(italic), in_link, &mut link_text),
            Event::Start(Tag::Strikethrough) => push(&mut out, strike, in_link, &mut link_text),
            Event::End(TagEnd::Strikethrough) => push(&mut out, &close(strike), in_link, &mut link_text),
            Event::Start(Tag::BlockQuote(_)) => {
                quote += 1;
                if matches!(dialect, Dialect::Slack | Dialect::Telegram | Dialect::Whatsapp) {
                    out.push_str(if dialect == Dialect::Telegram { ">" } else { "> " });
                }
            }
            Event::End(TagEnd::BlockQuote(_)) => quote = quote.saturating_sub(1),
            Event::Start(Tag::List(start)) => {
                if !lists.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                lists.push(start);
            }
            Event::End(TagEnd::List(_)) => {
                lists.pop();
                if lists.is_empty() {
                    out.push('\n');
                }
            }
            Event::Start(Tag::Item) => {
                let depth = lists.len().saturating_sub(1);
                out.push_str(&"  ".repeat(depth));
                match lists.last_mut() {
                    Some(Some(n)) => {
                        let mark = format!("{n}. ");
                        out.push_str(&if dialect == Dialect::Telegram { tg_escape(&mark) } else { mark });
                        *n += 1;
                    }
                    _ => out.push_str("• "),
                }
            }
            Event::End(TagEnd::Item) => {
                if !out.ends_with('\n') {
                    out.push('\n');
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let _ = matches!(kind, CodeBlockKind::Fenced(_));
                code_block = Some(String::new());
            }
            Event::Start(Tag::Table(_)) => table = Some(Vec::new()),
            Event::Start(Tag::Link { dest_url, .. }) => {
                in_link = true;
                link_text.clear();
                link_stack.push(dest_url.to_string());
            }
            Event::End(TagEnd::Link) => {
                in_link = false;
                let url = link_stack.pop().unwrap_or_default();
                let label = std::mem::take(&mut link_text);
                out.push_str(&match dialect {
                    Dialect::Slack => format!("<{}|{}>", url, label),
                    Dialect::Telegram => format!("[{}]({})", label, url.replace('\\', "\\\\").replace(')', "\\)")),
                    Dialect::TelegramHtml => format!("<a href=\"{}\">{}</a>", url.replace('"', "&quot;"), label),
                    _ => {
                        if label.is_empty() || label == url { url } else { format!("{label} ({url})") }
                    }
                });
            }
            Event::Start(Tag::Image { dest_url, .. }) => {
                push(&mut out, &dest_url, in_link, &mut link_text);
            }
            Event::Text(t) => {
                let escaped = escape(&t, dialect);
                push(&mut out, &escaped, in_link, &mut link_text);
            }
            Event::Code(t) => {
                let rendered = match dialect {
                    Dialect::TelegramHtml => format!("<code>{}</code>", html_escape(&t)),
                    Dialect::Telegram => format!("`{}`", t.replace('\\', "\\\\").replace('`', "\\`")),
                    Dialect::Whatsapp => format!("```{t}```"),
                    Dialect::Plain => t.to_string(),
                    Dialect::Slack => format!("`{}`", html_escape(&t)),
                };
                push(&mut out, &rendered, in_link, &mut link_text);
            }
            Event::SoftBreak => push(&mut out, " ", in_link, &mut link_text),
            Event::HardBreak => out.push('\n'),
            Event::Rule => out.push_str(if dialect == Dialect::Telegram { "\\-\\-\\-\n\n" } else { "———\n\n" }),
            Event::Html(h) | Event::InlineHtml(h) => {
                let escaped = escape(&h, dialect);
                push(&mut out, &escaped, in_link, &mut link_text);
            }
            _ => {}
        }
    }
    let _ = quote;
    out.trim_end().to_string()
}

/// Discord reads Markdown already — except tables, which it shows as pipes.
fn discord(markdown: &str) -> String {
    let mut out = String::new();
    let mut table: Vec<&str> = Vec::new();
    let flush = |table: &mut Vec<&str>, out: &mut String| {
        if table.is_empty() {
            return;
        }
        let rows: Vec<Vec<String>> = table
            .iter()
            .filter(|l| !l.trim_matches(|c| c == '|' || c == '-' || c == ':' || c == ' ').is_empty())
            .map(|l| l.trim().trim_matches('|').split('|').map(|c| c.trim().to_string()).collect())
            .collect();
        out.push_str(&format!("```\n{}```\n", table_text(&rows)));
        table.clear();
    };
    for line in markdown.lines() {
        if line.trim_start().starts_with('|') {
            table.push(line);
        } else {
            flush(&mut table, &mut out);
            out.push_str(line);
            out.push('\n');
        }
    }
    flush(&mut table, &mut out);
    out.trim_end().to_string()
}

/// An Adaptive Card (Teams) with one block per paragraph, heading, list and code block.
fn teams_card(markdown: &str) -> Value {
    let mut body: Vec<Value> = Vec::new();
    let mut current = String::new();
    let mut heading: Option<HeadingLevel> = None;
    let mut code: Option<String> = None;
    let mut list_depth = 0usize;
    let flush = |current: &mut String, body: &mut Vec<Value>, heading: Option<HeadingLevel>| {
        let text = current.trim().to_string();
        current.clear();
        if text.is_empty() {
            return;
        }
        let mut block = json!({"type": "TextBlock", "text": text, "wrap": true});
        if let Some(level) = heading {
            block["weight"] = json!("Bolder");
            block["size"] = json!(if level <= HeadingLevel::H1 { "Large" } else if level == HeadingLevel::H2 { "Medium" } else { "Default" });
        }
        body.push(block);
    };
    for event in Parser::new_ext(markdown, Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TABLES) {
        if let Some(buffer) = code.as_mut() {
            match event {
                Event::Text(t) => buffer.push_str(&t),
                Event::End(TagEnd::CodeBlock) => {
                    body.push(json!({"type": "TextBlock", "text": code.take().unwrap_or_default().trim_end(), "fontType": "Monospace", "wrap": true}));
                }
                _ => {}
            }
            continue;
        }
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush(&mut current, &mut body, None);
                heading = Some(level);
            }
            Event::End(TagEnd::Heading(_)) => {
                flush(&mut current, &mut body, heading);
                heading = None;
            }
            Event::End(TagEnd::Paragraph) if list_depth == 0 => flush(&mut current, &mut body, None),
            Event::Start(Tag::List(_)) => list_depth += 1,
            Event::End(TagEnd::List(_)) => {
                list_depth = list_depth.saturating_sub(1);
                if list_depth == 0 {
                    flush(&mut current, &mut body, None);
                }
            }
            Event::Start(Tag::Item) => current.push_str(&format!("\n{}- ", "  ".repeat(list_depth.saturating_sub(1)))),
            Event::Start(Tag::Strong) | Event::End(TagEnd::Strong) => current.push_str("**"),
            Event::Start(Tag::Emphasis) | Event::End(TagEnd::Emphasis) => current.push('_'),
            Event::Start(Tag::Link { dest_url, .. }) => {
                current.push('[');
                current.push_str(&format!("\u{1}{dest_url}\u{2}"));
            }
            Event::End(TagEnd::Link) => {
                // `[text](url)`: the url was parked between markers until the text was known.
                if let (Some(start), Some(end)) = (current.rfind('\u{1}'), current.rfind('\u{2}')) {
                    let url = current[start + 1..end].to_string();
                    let label = current[end + 1..].to_string();
                    current.truncate(start);
                    current.push_str(&format!("{label}]({url})"));
                }
            }
            Event::Start(Tag::CodeBlock(_)) => {
                flush(&mut current, &mut body, None);
                code = Some(String::new());
            }
            Event::Text(t) => current.push_str(&t),
            Event::Code(t) => current.push_str(&format!("`{t}`")),
            Event::SoftBreak => current.push(' '),
            Event::HardBreak => current.push('\n'),
            _ => {}
        }
    }
    flush(&mut current, &mut body, None);
    json!({
        "type": "AdaptiveCard",
        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
        "version": "1.4",
        "body": body,
    })
}

// ------------------------------------------------------------------------------------- numbers

/// How a locale writes numbers: its decimal mark and its group separator.
fn separators(locale: &str) -> (char, char) {
    let l = locale.trim().to_lowercase();
    let lang = l.split(['-', '_']).next().unwrap_or("");
    match (lang, l.as_str()) {
        (_, "es-mx" | "es-us" | "es-pr") => ('.', ','),
        ("de", _) if l.ends_with("ch") => ('.', '\''),
        ("fr" | "ru" | "pl" | "cs" | "sv" | "nb" | "fi" | "uk", _) => (',', '\u{202f}'),
        ("es" | "de" | "pt" | "it" | "nl" | "da" | "tr" | "id" | "ro" | "el", _) => (',', '.'),
        _ => ('.', ','),
    }
}

fn group_digits(digits: &str, separator: char) -> String {
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(separator);
        }
        out.push(c);
    }
    out
}

/// `1234567.891` in `es-CL` with 2 decimals → `1.234.567,89`.
pub fn format_number(value: f64, locale: &str, decimals: usize) -> String {
    let (decimal, group) = separators(locale);
    let rounded = format!("{:.*}", decimals, value.abs());
    let (whole, fraction) = rounded.split_once('.').unwrap_or((&rounded, ""));
    let mut out = String::new();
    if value < 0.0 && rounded.chars().any(|c| c.is_ascii_digit() && c != '0') {
        out.push('-');
    }
    out.push_str(&group_digits(whole, group));
    if !fraction.is_empty() {
        out.push(decimal);
        out.push_str(fraction);
    }
    out
}

fn currency_default_decimals(code: &str) -> usize {
    match code.to_uppercase().as_str() {
        "CLP" | "JPY" | "KRW" | "PYG" | "COP" | "ISK" | "VND" | "CLF" => if code.eq_ignore_ascii_case("CLF") { 4 } else { 0 },
        _ => 2,
    }
}

fn format_currency(value: f64, locale: &str, code: &str, decimals: Option<usize>) -> String {
    let code = code.trim().to_uppercase();
    let places = decimals.unwrap_or_else(|| currency_default_decimals(&code));
    let body = format_number(value.abs(), locale, places);
    let lang = locale.split(['-', '_']).next().unwrap_or("").to_lowercase();
    let negative = if value < 0.0 { "-" } else { "" };
    let (symbol, after) = match code.as_str() {
        "EUR" => ("€", lang != "en"),
        "USD" => (if locale.to_lowercase().ends_with("us") || lang != "es" { "$" } else { "US$" }, false),
        "CLP" | "MXN" | "ARS" | "COP" => ("$", false),
        "BRL" => ("R$", false),
        "PEN" => ("S/", false),
        "GBP" => ("£", false),
        "JPY" => ("¥", false),
        "CLF" => ("UF", false),
        _ => (code.as_str(), true),
    };
    if after {
        format!("{negative}{body} {symbol}")
    } else if symbol.len() > 1 && symbol.chars().all(|c| c.is_ascii_alphabetic() || c == '/') {
        format!("{negative}{symbol} {body}")
    } else {
        format!("{negative}{symbol}{body}")
    }
}

/// A number written by a person: `$ 1.234,56`, `1,234.56`, `12%` — the locale's marks first, and
/// when both marks appear the last one is the decimal.
pub fn parse_number(raw: &str, locale: &str) -> Option<f64> {
    let cleaned: String = raw.chars().filter(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '\'' | '\u{202f}' | ' ' | '\u{a0}')).collect();
    let cleaned = cleaned.replace(['\'', '\u{202f}', ' ', '\u{a0}'], "");
    if cleaned.is_empty() {
        return None;
    }
    let (decimal, _) = separators(locale);
    let last_dot = cleaned.rfind('.');
    let last_comma = cleaned.rfind(',');
    let decimal = match (last_dot, last_comma) {
        (Some(d), Some(c)) => if d > c { '.' } else { ',' },
        (Some(d), None) => {
            // A lone mark followed by exactly three digits, more than once, is grouping.
            let groups = cleaned.matches('.').count();
            if groups > 1 || (decimal == ',' && cleaned.len() - d - 1 == 3) { ',' } else { '.' }
        }
        (None, Some(c)) => {
            let groups = cleaned.matches(',').count();
            if groups > 1 || (decimal == '.' && cleaned.len() - c - 1 == 3) { '.' } else { ',' }
        }
        (None, None) => decimal,
    };
    let group = if decimal == '.' { ',' } else { '.' };
    let normal: String = cleaned.chars().filter(|c| *c != group).map(|c| if c == decimal { '.' } else { c }).collect();
    normal.parse().ok()
}

/// A unit's factor to its family's base, or the family's converter for temperatures.
fn unit_factor(unit: &str) -> Option<(&'static str, f64)> {
    let u = unit.trim().to_lowercase();
    Some(match u.as_str() {
        "mm" => ("length", 0.001),
        "cm" => ("length", 0.01),
        "m" => ("length", 1.0),
        "km" => ("length", 1000.0),
        "in" => ("length", 0.0254),
        "ft" => ("length", 0.3048),
        "yd" => ("length", 0.9144),
        "mi" => ("length", 1609.344),
        "mg" => ("mass", 0.000_001),
        "g" => ("mass", 0.001),
        "kg" => ("mass", 1.0),
        "t" => ("mass", 1000.0),
        "oz" => ("mass", 0.028_349_523_125),
        "lb" => ("mass", 0.453_592_37),
        "ms" => ("time", 0.001),
        "s" => ("time", 1.0),
        "min" => ("time", 60.0),
        "h" => ("time", 3600.0),
        "d" => ("time", 86_400.0),
        "wk" => ("time", 604_800.0),
        "b" => ("data", 1.0),
        "kb" => ("data", 1e3),
        "mb" => ("data", 1e6),
        "gb" => ("data", 1e9),
        "tb" => ("data", 1e12),
        "kib" => ("data", 1024.0),
        "mib" => ("data", 1024.0 * 1024.0),
        "gib" => ("data", 1024.0 * 1024.0 * 1024.0),
        "ml" => ("volume", 0.001),
        "l" => ("volume", 1.0),
        "gal" => ("volume", 3.785_411_784),
        "floz" => ("volume", 0.029_573_529_562_5),
        "m2" => ("area", 1.0),
        "km2" => ("area", 1e6),
        "ha" => ("area", 10_000.0),
        "ft2" => ("area", 0.092_903_04),
        "acre" => ("area", 4046.856_422_4),
        "kmh" => ("speed", 1.0 / 3.6),
        "mph" => ("speed", 0.447_04),
        "mps" => ("speed", 1.0),
        "c" | "f" | "k" => ("temperature", 0.0),
        _ => return None,
    })
}

pub fn convert_units(value: f64, from: &str, to: &str) -> Result<f64, String> {
    let (family_a, factor_a) = unit_factor(from).ok_or_else(|| format!("{from} is not a unit this node knows"))?;
    let (family_b, factor_b) = unit_factor(to).ok_or_else(|| format!("{to} is not a unit this node knows"))?;
    if family_a != family_b {
        return Err(format!("{from} and {to} measure different things"));
    }
    if family_a == "temperature" {
        let celsius = match from.trim().to_lowercase().as_str() {
            "f" => (value - 32.0) * 5.0 / 9.0,
            "k" => value - 273.15,
            _ => value,
        };
        return Ok(match to.trim().to_lowercase().as_str() {
            "f" => celsius * 9.0 / 5.0 + 32.0,
            "k" => celsius + 273.15,
            _ => celsius,
        });
    }
    Ok(value * factor_a / factor_b)
}

fn round_to(value: f64, decimals: usize, mode: &str) -> f64 {
    let factor = 10f64.powi(decimals as i32);
    let scaled = value * factor;
    let rounded = match mode {
        "roundUp" => scaled.ceil(),
        "roundDown" => scaled.floor(),
        _ => scaled.round(),
    };
    rounded / factor
}

fn number_op(params: &Value) -> Result<Value, NodeError> {
    let op = text(params, "numberOp");
    let decimals = number(params, "decimals").unwrap_or(0.0).clamp(0.0, 10.0) as usize;
    let locale = { let l = text(params, "numLocale"); if l.trim().is_empty() { "es-CL".to_string() } else { l } };
    let raw = params.get("value").cloned().unwrap_or(Value::Null);
    let read = || -> Result<f64, NodeError> {
        to_number(&raw)
            .or_else(|| parse_number(&to_text(&raw), &locale))
            .ok_or_else(|| NodeError::failed(format!("\"{}\" is not a number", to_text(&raw))))
    };
    Ok(match op.as_str() {
        "numParse" => crate::flows::value::number(read()?),
        "numRound" => crate::flows::value::number(round_to(read()?, decimals, &text(params, "roundMode"))),
        "numBytes" => {
            let bytes = read()?;
            let units = ["B", "kB", "MB", "GB", "TB", "PB"];
            let mut size = bytes.abs();
            let mut unit = 0;
            while size >= 1000.0 && unit < units.len() - 1 {
                size /= 1000.0;
                unit += 1;
            }
            let places = if unit == 0 { 0 } else { decimals.max(1) };
            json!(format!("{}{} {}", if bytes < 0.0 { "-" } else { "" }, format_number(size, &locale, places), units[unit]))
        }
        "numConvert" => {
            let converted = convert_units(read()?, &text(params, "fromUnit"), &text(params, "toUnit")).map_err(NodeError::Failed)?;
            crate::flows::value::number(round_to(converted, decimals.max(if converted.abs() < 10.0 { 4 } else { 2 }), "roundHalf"))
        }
        "numRandom" => {
            let min = number(params, "minValue").unwrap_or(0.0);
            let max = number(params, "maxValue").unwrap_or(100.0);
            // `random_range` panics on a range with nothing in it: each way there is to write one
            // is answered here instead, in words.
            if !min.is_finite() || !max.is_finite() {
                return Err(NodeError::failed("The minimum and the maximum must be numbers"));
            }
            if min > max {
                return Err(NodeError::failed(format!("The minimum ({min}) is more than the maximum ({max})")));
            }
            let mut rng = rand::rng();
            if flag(params, "integerOnly") {
                let (low, high) = (min.ceil(), max.floor());
                if low > high {
                    return Err(NodeError::failed(format!("There is no whole number between {min} and {max}")));
                }
                json!(rng.random_range(low as i64..=high as i64))
            } else {
                if !(max - min).is_finite() {
                    return Err(NodeError::failed("The range is wider than a number can hold"));
                }
                crate::flows::value::number(rng.random_range(min..=max))
            }
        }
        "numPercent" => {
            let base = params.get("baseValue").cloned().unwrap_or(Value::Null);
            let base = to_number(&base).or_else(|| parse_number(&to_text(&base), &locale)).ok_or_else(|| NodeError::failed("The base value is not a number"))?;
            if base == 0.0 {
                return Err(NodeError::failed("The base value is 0: there is no percentage of change"));
            }
            crate::flows::value::number(round_to((read()? - base) / base.abs() * 100.0, decimals.max(1), "roundHalf"))
        }
        _ => {
            let value = read()?;
            match text(params, "numStyle").as_str() {
                "styleCurrency" => {
                    let code = text(params, "currency");
                    // The clamped count, not the raw parameter: `{:.*}` with 1e10 places is a string
                    // of ten billion characters. Zero leaves the currency's own (two, none for CLP).
                    let explicit = (decimals > 0).then_some(decimals);
                    json!(format_currency(value, &locale, if code.trim().is_empty() { "CLP" } else { code.trim() }, explicit))
                }
                "stylePercent" => json!(format!("{}%", format_number(value * 100.0, &locale, decimals))),
                _ => json!(format_number(value, &locale, decimals)),
            }
        }
    })
}

// ------------------------------------------------------------------------------------ validate

fn email_ok(value: &str) -> bool {
    let v = value.trim();
    let Some((local, domain)) = v.split_once('@') else { return false };
    !local.is_empty() && !local.contains(' ') && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.') && !domain.contains(' ') && !domain.contains('@')
}

fn url_ok(value: &str) -> bool {
    url::Url::parse(value.trim()).map(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some()).unwrap_or(false)
}

fn uuid_ok(value: &str) -> bool {
    uuid::Uuid::parse_str(value.trim()).is_ok()
}

fn date_ok(value: &str) -> bool {
    let v = value.trim();
    chrono::DateTime::parse_from_rfc3339(v).is_ok()
        || chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").is_ok()
        || chrono::NaiveDateTime::parse_from_str(v, "%Y-%m-%d %H:%M:%S").is_ok()
        || chrono::NaiveDate::parse_from_str(v, "%d/%m/%Y").is_ok()
        || chrono::NaiveDate::parse_from_str(v, "%d-%m-%Y").is_ok()
}

/// A phone in international form, or a local one the country code completes: 8 to 15 digits.
fn phone_digits(value: &str, country: &str) -> Option<String> {
    let raw = value.trim();
    let plus = raw.starts_with('+') || raw.starts_with("00");
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    let digits = if raw.starts_with("00") { digits[2..].to_string() } else { digits };
    let full = if plus { digits } else {
        let country: String = country.chars().filter(char::is_ascii_digit).collect();
        let local = digits.trim_start_matches('0');
        if local.starts_with(&country) && local.len() > 9 { local.to_string() } else { format!("{country}{local}") }
    };
    (8..=15).contains(&full.len()).then_some(full)
}

/// `12345678-5` → `12.345.678-5`.
fn format_rut(value: &str) -> String {
    let clean: String = value.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_uppercase();
    if clean.len() < 2 {
        return value.to_string();
    }
    let (body, dv) = clean.split_at(clean.len() - 1);
    format!("{}-{dv}", group_digits(body.trim_start_matches('0'), '.'))
}

/// What a rule says about one field — `None` when it holds.
fn rule_error(value: Option<&Value>, check: &str, arg: &str, phone_country: &str) -> Option<String> {
    let present = value.is_some_and(|v| !v.is_null() && !(v.is_string() && v.as_str().unwrap_or("").trim().is_empty()));
    if check == "required" {
        return (!present).then(|| "is required".into());
    }
    // Every other rule judges a value that is there; an empty optional field passes.
    let value = value.filter(|_| present)?;
    let text_value = to_text(value);
    let length = text_value.chars().count() as f64;
    let arg_number = arg.trim().parse::<f64>().ok();
    let fails = match check {
        "isEmail" => !email_ok(&text_value),
        "isUrl" => !url_ok(&text_value),
        "isUuid" => !uuid_ok(&text_value),
        "isNumber" => to_number(value).is_none(),
        "isInteger" => to_number(value).is_none_or(|n| n.fract() != 0.0),
        "isDate" => !date_ok(&text_value),
        "isRut" => !super::redact::rut_ok(&text_value),
        "isCard" => !super::redact::luhn(&text_value),
        "isIban" => !super::redact::iban_ok(&text_value),
        "isPhone" => phone_digits(&text_value, phone_country).is_none(),
        "matches" => regex::Regex::new(arg).map(|re| !re.is_match(&text_value)).unwrap_or(true),
        "minLength" => arg_number.is_some_and(|n| length < n),
        "maxLength" => arg_number.is_some_and(|n| length > n),
        "minValue" => match (to_number(value), arg_number) {
            (Some(v), Some(n)) => v < n,
            _ => true,
        },
        "maxValue" => match (to_number(value), arg_number) {
            (Some(v), Some(n)) => v > n,
            _ => true,
        },
        "oneOf" => !arg.split(',').map(str::trim).any(|option| option == text_value.trim()),
        _ => false,
    };
    fails.then(|| match check {
        "isEmail" => "is not an email".to_string(),
        "isUrl" => "is not a web address".to_string(),
        "isUuid" => "is not a UUID".to_string(),
        "isNumber" => "is not a number".to_string(),
        "isInteger" => "is not a whole number".to_string(),
        "isDate" => "is not a date".to_string(),
        "isRut" => "is not a valid RUT".to_string(),
        "isCard" => "is not a valid card number".to_string(),
        "isIban" => "is not a valid IBAN".to_string(),
        "isPhone" => "is not a phone number".to_string(),
        "matches" => format!("does not match {arg}"),
        "minLength" => format!("is shorter than {arg}"),
        "maxLength" => format!("is longer than {arg}"),
        "minValue" => format!("is less than {arg}"),
        "maxValue" => format!("is more than {arg}"),
        "oneOf" => format!("is not one of {arg}"),
        other => format!("fails {other}"),
    })
}

async fn validate(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = &ctx.params;
    let rules: Vec<(String, String, String)> = params
        .get("validationRules")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().map(|r| (text(r, "field").trim().to_string(), text(r, "check"), text(r, "arg"))).filter(|(f, c, _)| !f.is_empty() && !c.is_empty()).collect())
        .unwrap_or_default();
    let normalize: Vec<String> = super::strings(params, "normalize");
    let phone_country = { let c = text(params, "phoneCountry"); if c.trim().is_empty() { "56".to_string() } else { c } };
    let errors_field = { let f = text(params, "errorsField"); if f.trim().is_empty() { "_errors".to_string() } else { f.trim().to_string() } };
    let mut valid = Vec::new();
    let mut invalid = Vec::new();
    for (index, item) in ctx.items().into_iter().enumerate() {
        let mut json = item.json.clone();
        // Normalised first, so a padded email still passes as an email.
        if let Value::Object(map) = &mut json {
            for (key, value) in map.iter_mut() {
                let Value::String(s) = value else { continue };
                if normalize.iter().any(|n| n == "normTrim") {
                    *s = s.trim().to_string();
                }
                if normalize.iter().any(|n| n == "normLowerEmail") && email_ok(s) {
                    *s = s.to_lowercase();
                }
                let rule_for = |check: &str| rules.iter().any(|(f, c, _)| f == key && c == check);
                if normalize.iter().any(|n| n == "normRut") && (rule_for("isRut") || super::redact::rut_ok(s)) && super::redact::rut_ok(s) {
                    *s = format_rut(s);
                }
                if normalize.iter().any(|n| n == "normPhone") && rule_for("isPhone") {
                    if let Some(digits) = phone_digits(s, &phone_country) {
                        *s = format!("+{digits}");
                    }
                }
            }
        }
        let mut errors: Vec<Value> = Vec::new();
        for (field, check, arg) in &rules {
            if let Some(message) = rule_error(get_path(&json, field), check, arg, &phone_country) {
                errors.push(json!({"field": field, "check": check, "message": format!("{field} {message}")}));
            }
        }
        if errors.is_empty() {
            valid.push(Item::paired(json, index));
        } else {
            set_path(&mut json, &errors_field, Value::Array(errors));
            invalid.push(Item::paired(json, index));
        }
    }
    Ok(vec![valid, invalid])
}

// ---------------------------------------------------------------------------------- fake data

const FIRST_NAMES_ES: &[&str] = &["Camila", "Matías", "Valentina", "Benjamín", "Sofía", "Vicente", "Isidora", "Agustín", "Florencia", "Tomás", "Josefa", "Martín", "Antonia", "Joaquín", "Catalina", "Diego", "Fernanda", "Sebastián", "Javiera", "Nicolás"];
const LAST_NAMES_ES: &[&str] = &["González", "Muñoz", "Rojas", "Díaz", "Pérez", "Soto", "Contreras", "Silva", "Martínez", "Sepúlveda", "Morales", "Rodríguez", "López", "Fuentes", "Hernández", "Torres", "Araya", "Flores", "Espinoza", "Valenzuela"];
const FIRST_NAMES_EN: &[&str] = &["Olivia", "Liam", "Emma", "Noah", "Ava", "James", "Mia", "Lucas", "Amelia", "Ethan", "Harper", "Mason", "Ella", "Logan", "Grace", "Henry"];
const LAST_NAMES_EN: &[&str] = &["Smith", "Johnson", "Brown", "Taylor", "Miller", "Wilson", "Moore", "Anderson", "Thomas", "Jackson", "White", "Harris", "Martin", "Clark", "Lewis", "Walker"];
const CITIES_CL: &[(&str, &str)] = &[("Santiago", "Metropolitana"), ("Valparaíso", "Valparaíso"), ("Viña del Mar", "Valparaíso"), ("Concepción", "Biobío"), ("La Serena", "Coquimbo"), ("Antofagasta", "Antofagasta"), ("Temuco", "Araucanía"), ("Rancagua", "O'Higgins"), ("Talca", "Maule"), ("Puerto Montt", "Los Lagos"), ("Iquique", "Tarapacá"), ("Punta Arenas", "Magallanes")];
const CITIES_ES: &[(&str, &str)] = &[("Madrid", "Madrid"), ("Barcelona", "Cataluña"), ("Valencia", "Valencia"), ("Sevilla", "Andalucía"), ("Bilbao", "País Vasco"), ("Málaga", "Andalucía"), ("Zaragoza", "Aragón")];
const CITIES_EN: &[(&str, &str)] = &[("Springfield", "Illinois"), ("Austin", "Texas"), ("Portland", "Oregon"), ("Denver", "Colorado"), ("Boston", "Massachusetts"), ("Seattle", "Washington"), ("Atlanta", "Georgia")];
const STREETS: &[&str] = &["Los Aromos", "Providencia", "Los Leones", "Alameda", "San Martín", "O'Higgins", "Las Acacias", "Pedro de Valdivia", "Manuel Montt", "Irarrázaval"];
const COMPANIES: &[&str] = &["Andes Digital", "Pacífico Logística", "Cordillera Soft", "Austral Foods", "Puerto Labs", "Mapocho Data", "Litoral Seguros", "Atacama Energía"];
const JOBS: &[&str] = &["Desarrolladora", "Analista de datos", "Diseñador UX", "Gerente de producto", "Ingeniera DevOps", "Contador", "Ejecutiva comercial", "Soporte técnico"];
const PRODUCTS: &[&str] = &["Café de grano", "Teclado mecánico", "Silla ergonómica", "Monitor 27\"", "Audífonos", "Mochila", "Lámpara LED", "Botella térmica", "Cuaderno", "Router Wi-Fi"];
const WORDS: &[&str] = &["sistema", "pedido", "cliente", "despliegue", "servidor", "factura", "reporte", "usuario", "proyecto", "equipo", "módulo", "datos", "flujo", "rápido", "seguro", "nuevo", "estable", "simple"];

fn pick<'a, R: Rng>(rng: &mut R, list: &'a [&'a str]) -> &'a str {
    list[rng.random_range(0..list.len())]
}

/// A valid RUT: a body and its mod-11 check digit.
pub fn fake_rut<R: Rng>(rng: &mut R) -> String {
    let body: u32 = rng.random_range(5_000_000..=26_000_000);
    let mut sum = 0u32;
    let mut factor = 2;
    for d in body.to_string().chars().rev() {
        sum += d.to_digit(10).unwrap_or(0) * factor;
        factor = if factor == 7 { 2 } else { factor + 1 };
    }
    let dv = match 11 - (sum % 11) {
        11 => "0".to_string(),
        10 => "K".to_string(),
        n => n.to_string(),
    };
    format_rut(&format!("{body}{dv}"))
}

fn ascii_slug(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'á' | 'à' | 'ä' => 'a',
            'é' | 'è' | 'ë' => 'e',
            'í' | 'ì' | 'ï' => 'i',
            'ó' | 'ò' | 'ö' => 'o',
            'ú' | 'ù' | 'ü' => 'u',
            'ñ' => 'n',
            other => other,
        })
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_lowercase()
}

fn fake_value<R: Rng>(rng: &mut R, kind: &str, locale: &str, person: &(String, String)) -> Value {
    let english = locale == "localeEn";
    let cities = match locale {
        "localeEn" => CITIES_EN,
        "localeEs" => CITIES_ES,
        _ => CITIES_CL,
    };
    let (city, region) = cities[rng.random_range(0..cities.len())];
    match kind {
        "fullName" => json!(format!("{} {}", person.0, person.1)),
        "firstName" => json!(person.0),
        "lastName" => json!(person.1),
        "email" => json!(format!("{}.{}{}@{}", ascii_slug(&person.0), ascii_slug(&person.1), rng.random_range(1..99), if english { "example.com" } else { "example.cl" })),
        "username" => json!(format!("{}{}", ascii_slug(&person.0), rng.random_range(10..9999))),
        "phone" => json!(match locale {
            "localeEn" => format!("+1 {} {} {}", rng.random_range(200..999), rng.random_range(200..999), rng.random_range(1000..9999)),
            "localeEs" => format!("+34 6{} {} {}", rng.random_range(10..99), rng.random_range(100..999), rng.random_range(100..999)),
            _ => format!("+56 9 {} {}", rng.random_range(1000..9999), rng.random_range(1000..9999)),
        }),
        "rut" => json!(fake_rut(rng)),
        "address" => json!(format!("{} {}", pick(rng, STREETS), rng.random_range(100..9999))),
        "city" => json!(city),
        "region" => json!(region),
        "country" => json!(match locale {
            "localeEn" => "United States",
            "localeEs" => "España",
            _ => "Chile",
        }),
        "company" => json!(pick(rng, COMPANIES)),
        "jobTitle" => json!(pick(rng, JOBS)),
        "uuid" => json!(uuid::Builder::from_random_bytes(rng.random()).into_uuid().to_string()),
        "integer" => json!(rng.random_range(1..10_000)),
        "decimal" => json!((rng.random_range(0.0..10_000.0f64) * 100.0).round() / 100.0),
        "boolean" => json!(rng.random_bool(0.5)),
        "date" => {
            let days = rng.random_range(-730..30);
            json!((chrono::Local::now().date_naive() + chrono::Duration::days(days)).format("%Y-%m-%d").to_string())
        }
        "datetime" => {
            let seconds = rng.random_range(-63_072_000..2_592_000i64);
            json!((chrono::Utc::now() + chrono::Duration::seconds(seconds)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        }
        "sentence" => {
            let n = rng.random_range(5..12);
            let sentence = (0..n).map(|_| pick(rng, WORDS)).collect::<Vec<_>>().join(" ");
            let mut chars = sentence.chars();
            let capitalised: String = chars.next().map(|c| c.to_uppercase().collect::<String>() + chars.as_str()).unwrap_or_default();
            json!(format!("{capitalised}."))
        }
        "paragraph" => {
            let sentences: Vec<String> = (0..rng.random_range(3..6)).map(|_| to_text(&fake_value(rng, "sentence", locale, person))).collect();
            json!(sentences.join(" "))
        }
        "word" => json!(pick(rng, WORDS)),
        "url" => json!(format!("https://{}.example.com/{}", ascii_slug(pick(rng, COMPANIES)), pick(rng, WORDS))),
        "ip" => json!(format!("{}.{}.{}.{}", rng.random_range(10..223), rng.random_range(0..255), rng.random_range(0..255), rng.random_range(1..254))),
        "color" => json!(format!("#{:06x}", rng.random_range(0..0xFFFFFF))),
        "price" => json!(if locale == "localeCl" { json!(rng.random_range(10..2000) * 990 / 100 * 100) } else { json!((rng.random_range(100..100_000) as f64) / 100.0) }),
        "product" => json!(pick(rng, PRODUCTS)),
        _ => Value::Null,
    }
}

fn fake(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = &ctx.params;
    let count = number(params, "fakeCount").unwrap_or(10.0).clamp(1.0, 10_000.0) as usize;
    let locale = text(params, "fakeLocale");
    let fields: Vec<(String, String)> = params
        .get("fakeFields")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().map(|r| (text(r, "name").trim().to_string(), text(r, "kind"))).filter(|(n, k)| !n.is_empty() && !k.is_empty()).collect())
        .unwrap_or_default();
    if fields.is_empty() {
        return Err(NodeError::failed("Add at least one field"));
    }
    let seed = text(params, "fakeSeed");
    let mut rng: rand::rngs::StdRng = if seed.trim().is_empty() {
        rand::rngs::StdRng::from_os_rng()
    } else {
        use sha2::Digest;
        let digest = sha2::Sha256::digest(seed.trim().as_bytes());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&digest);
        rand::rngs::StdRng::from_seed(bytes)
    };
    let (firsts, lasts) = if locale == "localeEn" { (FIRST_NAMES_EN, LAST_NAMES_EN) } else { (FIRST_NAMES_ES, LAST_NAMES_ES) };
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        // One person per item, so its name, email and username agree.
        let person = (pick(&mut rng, firsts).to_string(), pick(&mut rng, lasts).to_string());
        let mut item = Map::new();
        for (name, kind) in &fields {
            item.insert(name.clone(), fake_value(&mut rng, kind, &locale, &person));
        }
        out.push(Item::new(Value::Object(item)));
    }
    Ok(vec![out])
}

// --------------------------------------------------------------------------------------- limit

/// The counts may be expressions (`{{ $json.pageSize }}`): resolved once, against the first item,
/// like every parameter of a node that acts on the list as a whole.
async fn limit(ctx: &NodeCtx) -> Result<Ports, NodeError> {
    let params = ctx.resolve_once().await?;
    let items = ctx.items();
    let count = number(&params, "keepCount").unwrap_or(10.0).max(0.0) as usize;
    let skip = number(&params, "skipCount").unwrap_or(0.0).max(0.0) as usize;
    let indexed: Vec<(usize, &Item)> = items.into_iter().enumerate().collect();
    let chosen: Vec<(usize, &Item)> = match text(&params, "limitMode").as_str() {
        "lastN" => {
            let start = indexed.len().saturating_sub(count);
            indexed[start..].to_vec()
        }
        "skipN" => indexed.into_iter().skip(count).collect(),
        "pageN" => indexed.into_iter().skip(skip).take(count).collect(),
        _ => indexed.into_iter().take(count).collect(),
    };
    Ok(vec![chosen.into_iter().map(|(index, item)| Item::paired(item.json.clone(), index)).collect()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_for_each_chat() {
        let md = "# Despliegue\n\nTodo **bien** en _prod_ con `api` y [panel](https://example.com/a_b).\n\n- uno\n- dos\n";
        let slack = chat_format(md, "fmtSlack");
        assert_eq!(slack, json!("*Despliegue*\n\nTodo *bien* en _prod_ con `api` y <https://example.com/a_b|panel>.\n\n• uno\n• dos"));
        let tg = chat_format(md, "fmtTelegram").as_str().unwrap().to_string();
        assert!(tg.contains("*bien*"), "{tg}");
        assert!(tg.contains("[panel](https://example.com/a_b)"), "urls keep their underscores: {tg}");
        assert!(tg.contains("\\."), "dots are escaped: {tg}");
        let html = chat_format(md, "fmtTelegramHtml").as_str().unwrap().to_string();
        assert!(html.contains("<b>bien</b>") && html.contains("<a href=\"https://example.com/a_b\">panel</a>"), "{html}");
        let wa = chat_format(md, "fmtWhatsapp").as_str().unwrap().to_string();
        assert!(wa.contains("panel (https://example.com/a_b)") && wa.contains("```api```"), "{wa}");
        let plain = chat_format(md, "fmtPlain").as_str().unwrap().to_string();
        assert!(plain.starts_with("Despliegue\n\nTodo bien en prod con api y panel (https://example.com/a_b)."), "{plain}");
        let card = chat_format(md, "fmtTeams");
        assert_eq!(card["type"], "AdaptiveCard");
        assert_eq!(card["body"][0]["weight"], "Bolder");
        assert!(card["body"][1]["text"].as_str().unwrap().contains("[panel](https://example.com/a_b)"), "{card}");
    }

    #[test]
    fn tables_become_code() {
        let md = "| a | bb |\n|---|---|\n| 1 | 22 |\n";
        let slack = chat_format(md, "fmtSlack").as_str().unwrap().to_string();
        assert!(slack.starts_with("```\na  bb\n-  --\n1  22\n```"), "{slack}");
        let discord = chat_format(md, "fmtDiscord").as_str().unwrap().to_string();
        assert!(discord.starts_with("```\na  bb"), "{discord}");
    }

    #[test]
    fn numbers_by_locale() {
        assert_eq!(format_number(1_234_567.891, "es-CL", 2), "1.234.567,89");
        assert_eq!(format_number(1_234_567.891, "en-US", 1), "1,234,567.9");
        assert_eq!(format_number(-0.001, "es-CL", 2), "0,00");
        assert_eq!(format_currency(1_234_567.0, "es-CL", "CLP", None), "$1.234.567");
        assert_eq!(format_currency(10.5, "es-CL", "EUR", None), "10,50 €");
        assert_eq!(format_currency(10.5, "en-US", "USD", None), "$10.50");
        assert_eq!(parse_number("$ 1.234,56", "es-CL"), Some(1234.56));
        assert_eq!(parse_number("1,234.56", "es-CL"), Some(1234.56));
        assert_eq!(parse_number("1.234", "es-CL"), Some(1234.0));
        assert_eq!(parse_number("12,5", "es-CL"), Some(12.5));
        assert_eq!(parse_number("12.5", "en-US"), Some(12.5));
        assert_eq!(parse_number("1,000,000", "en-US"), Some(1_000_000.0));
        assert!((convert_units(10.0, "km", "mi").unwrap() - 6.213_711_922).abs() < 1e-6);
        assert_eq!(convert_units(100.0, "c", "f").unwrap(), 212.0);
        assert!(convert_units(1.0, "kg", "km").is_err());
        assert_eq!(round_to(2.345, 2, "roundHalf"), 2.35);
        assert_eq!(round_to(2.341, 2, "roundUp"), 2.35);
    }

    #[test]
    fn number_parameters_out_of_bounds_are_answered_not_obeyed() {
        // A currency with ten billion decimals is the most the node writes: ten.
        let money = number_op(&json!({"numberOp": "numFormat", "numStyle": "styleCurrency", "currency": "USD", "numLocale": "en-US", "value": 1.5, "decimals": 1e10})).unwrap();
        assert_eq!(money, json!("$1.5000000000"));
        let money = number_op(&json!({"numberOp": "numFormat", "numStyle": "styleCurrency", "currency": "CLP", "value": 1500, "decimals": 0})).unwrap();
        assert_eq!(money, json!("$1.500"), "no decimals asked for: the currency's own");

        let random = |min: Value, max: Value, whole: bool| number_op(&json!({"numberOp": "numRandom", "minValue": min, "maxValue": max, "integerOnly": whole}));
        for (min, max, whole) in [(json!(0.2), json!(0.8), true), (json!(10), json!(1), false), (json!(10), json!(1), true), (json!("inf"), json!(5), false), (json!(1), json!("NaN"), true), (json!(-1e308), json!(1e308), false)] {
            let answer = random(min.clone(), max.clone(), whole);
            assert!(matches!(answer, Err(NodeError::Failed(_))), "{min} … {max}: {answer:?}");
        }
        let n = random(json!(3), json!(3), true).unwrap();
        assert_eq!(n, json!(3));
        let x = random(json!(0.5), json!(0.75), false).unwrap().as_f64().unwrap();
        assert!((0.5..=0.75).contains(&x), "{x}");
    }

    #[test]
    fn validation_rules() {
        assert_eq!(rule_error(Some(&json!("a@b.cl")), "isEmail", "", "56"), None);
        assert!(rule_error(Some(&json!("no es correo")), "isEmail", "", "56").is_some());
        assert!(rule_error(None, "required", "", "56").is_some());
        assert_eq!(rule_error(None, "isEmail", "", "56"), None, "an empty optional field passes");
        assert_eq!(rule_error(Some(&json!("12.345.678-5")), "isRut", "", "56"), None);
        assert!(rule_error(Some(&json!("12.345.678-9")), "isRut", "", "56").is_some());
        assert_eq!(rule_error(Some(&json!("9 1234 5678")), "isPhone", "", "56"), None);
        assert!(rule_error(Some(&json!(5)), "minValue", "10", "56").is_some());
        assert!(rule_error(Some(&json!("b")), "oneOf", "a, c", "56").is_some());
        assert_eq!(format_rut("123456785"), "12.345.678-5");
        assert_eq!(phone_digits("9 1234 5678", "56").as_deref(), Some("56912345678"));
        assert_eq!(phone_digits("+56 9 1234 5678", "56").as_deref(), Some("56912345678"));
    }

    #[test]
    fn fake_ruts_are_valid() {
        let mut rng = rand::rngs::StdRng::from_seed([7u8; 32]);
        for _ in 0..50 {
            let rut = fake_rut(&mut rng);
            assert!(super::super::redact::rut_ok(&rut), "{rut}");
        }
    }
}
