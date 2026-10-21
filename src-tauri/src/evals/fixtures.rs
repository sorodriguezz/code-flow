//! The small projects the bench works in — written fresh into a temp folder for every run, so a model
//! that broke one file in run 1 does not hand run 2 a different task.
//!
//! JavaScript on purpose: the checks run the result with `node` (when it is installed), which says
//! whether a fix *works*, not whether it looks like the expected text. Each fixture is a git
//! repository, because the agent's project map reads blob ids the way it does in a real checkout.

use std::path::{Path, PathBuf};

/// Which project a task runs in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fixture {
    /// One file and a README: a negative cart total.
    Cart,
    /// ~25 files: cart, checkout, an HTTP layer and filler domain modules. The discount bug lives in
    /// `src/lib/pricing.js`, two imports away from the symptom.
    Shop,
    /// A service whose decisions live in `docs/adr/`, for questions answered by documentation — and
    /// a note of the team's (see [`Fixture::notes`]), for a question only the notes answer.
    Docs,
    /// Sixty days of operations notes in `docs/ops/`, one sentence of which is the answer: a needle
    /// among passages that share its words.
    Haystack,
}

impl Fixture {
    /// Writes the project into a new temp folder and returns it. The caller deletes it.
    pub fn create(self) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codeflow-eval-{}-{}", self.slug(), uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let _ = git2::Repository::init(&dir);
        match self {
            Fixture::Cart => cart(&dir),
            Fixture::Shop => shop(&dir),
            Fixture::Docs => docs(&dir),
            Fixture::Haystack => haystack(&dir),
        }
        dir
    }

    pub fn slug(self) -> &'static str {
        match self {
            Fixture::Cart => "cart",
            Fixture::Shop => "shop",
            Fixture::Docs => "docs",
            Fixture::Haystack => "haystack",
        }
    }

    /// The notes the fixture's workspace holds, `(id, title, body)` — written into a database of the
    /// bench's own (never the app's), for the retrieval tasks.
    pub fn notes(self) -> &'static [(&'static str, &'static str, &'static str)] {
        match self {
            Fixture::Docs => &[(
                "eval-oncall",
                "Guardia de inventario",
                "## Escáneres sin conexión\n\nSi los escáneres del almacén pierden la conexión, la persona de guardia reinicia el servicio con `systemctl restart inventory` y avisa en el canal #almacen antes de diez minutos.\n",
            )],
            _ => &[],
        }
    }
}

fn write(dir: &Path, rel: &str, text: &str) {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::write(path, text).expect("fixture file");
}

fn cart(dir: &Path) {
    write(
        dir,
        "src/cart.js",
        "// Sums the price of every item in the cart.\nfunction cartTotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total -= item.price;\n  }\n  return total;\n}\n\nmodule.exports = { cartTotal };\n",
    );
    write(dir, "README.md", "# Cart\n\nA tiny cart library.\n");
}

fn shop(dir: &Path) {
    write(dir, "README.md", "# Shop\n\nCart, checkout and a small HTTP API.\n");
    write(dir, "package.json", "{\n  \"name\": \"shop\",\n  \"version\": \"1.0.0\"\n}\n");
    write(dir, "src/lib/pricing.js", "// Price helpers shared by the cart and the checkout.\n\nfunction applyDiscount(price, percent) {\n  return price * percent / 100;\n}\n\nfunction formatPrice(amount) {\n  return '$' + amount.toFixed(2);\n}\n\nfunction roundCents(amount) {\n  return Math.round(amount * 100) / 100;\n}\n\nmodule.exports = { applyDiscount, formatPrice, roundCents };\n");
    write(dir, "src/lib/tax.js", "function taxFor(amount, rate) {\n  return amount * rate;\n}\n\nmodule.exports = { taxFor };\n");
    write(dir, "src/lib/strings.js", "function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');\n}\n\nfunction capitalize(text) {\n  return text.charAt(0).toUpperCase() + text.slice(1);\n}\n\nmodule.exports = { slugify, capitalize };\n");
    write(dir, "src/cart/cart.js", "const { applyDiscount, roundCents } = require('../lib/pricing');\n\nfunction cartSubtotal(items) {\n  let total = 0;\n  for (const item of items) {\n    total += item.price * item.qty;\n  }\n  return total;\n}\n\nfunction cartTotal(items, discountPercent) {\n  const subtotal = cartSubtotal(items);\n  const total = discountPercent ? applyDiscount(subtotal, discountPercent) : subtotal;\n  return roundCents(total);\n}\n\nmodule.exports = { cartSubtotal, cartTotal };\n");
    write(dir, "src/cart/items.js", "function addItem(items, item) {\n  return [...items, item];\n}\n\nfunction removeItem(items, id) {\n  return items.filter((item) => item.id !== id);\n}\n\nmodule.exports = { addItem, removeItem };\n");
    write(dir, "src/checkout/checkout.js", "const { cartTotal } = require('../cart/cart');\nconst { formatPrice } = require('../lib/pricing');\nconst { taxFor } = require('../lib/tax');\n\nfunction checkoutSummary(items, discountPercent) {\n  const total = cartTotal(items, discountPercent);\n  return { total, tax: taxFor(total, 0), label: formatPrice(total) };\n}\n\nmodule.exports = { checkoutSummary };\n");
    write(dir, "src/checkout/receipt.js", "const { formatPrice } = require('../lib/pricing');\n\nfunction receiptLines(items) {\n  return items.map((item) => `${item.name} x${item.qty} ${formatPrice(item.price * item.qty)}`);\n}\n\nmodule.exports = { receiptLines };\n");
    write(dir, "src/api/routes.js", "const { checkoutSummary } = require('../checkout/checkout');\nconst { receiptLines } = require('../checkout/receipt');\n\nfunction postCheckout(req) {\n  return checkoutSummary(req.body.items, req.body.discount);\n}\n\nfunction getReceipt(req) {\n  return receiptLines(req.body.items);\n}\n\nmodule.exports = { postCheckout, getReceipt };\n");
    write(dir, "src/api/server.js", "const routes = require('./routes');\n\nfunction handle(path, req) {\n  if (path === '/checkout') return routes.postCheckout(req);\n  if (path === '/receipt') return routes.getReceipt(req);\n  return { status: 404 };\n}\n\nmodule.exports = { handle };\n");
    for (name, body) in [
        ("users", "function findUser(users, id) {\n  return users.find((u) => u.id === id);\n}\n\nmodule.exports = { findUser };\n"),
        ("orders", "function orderStatus(order) {\n  return order.paid ? 'paid' : 'pending';\n}\n\nmodule.exports = { orderStatus };\n"),
        ("stock", "function inStock(product) {\n  return product.stock > 0;\n}\n\nmodule.exports = { inStock };\n"),
        ("shipping", "function shippingCost(weight) {\n  return weight > 10 ? 15 : 5;\n}\n\nmodule.exports = { shippingCost };\n"),
        ("reviews", "function averageRating(reviews) {\n  return reviews.reduce((a, r) => a + r.stars, 0) / reviews.length;\n}\n\nmodule.exports = { averageRating };\n"),
        ("coupons", "function couponValid(coupon, now) {\n  return coupon.expires > now;\n}\n\nmodule.exports = { couponValid };\n"),
        ("emails", "function welcomeEmail(user) {\n  return `Hola ${user.name}`;\n}\n\nmodule.exports = { welcomeEmail };\n"),
        ("search", "function searchProducts(products, text) {\n  return products.filter((p) => p.name.includes(text));\n}\n\nmodule.exports = { searchProducts };\n"),
    ] {
        write(dir, &format!("src/domain/{name}.js"), body);
    }
    for name in ["CartView", "CheckoutView", "ProductList", "Header", "Footer", "UserMenu"] {
        write(dir, &format!("src/ui/{name}.js"), &format!("function {name}(props) {{\n  return {{ type: '{name}', props }};\n}}\n\nmodule.exports = {{ {name} }};\n"));
    }
}

fn docs(dir: &Path) {
    write(dir, "README.md", "# Inventory service\n\nTracks stock levels for the warehouse. See `docs/` for how it is built.\n");
    write(dir, "src/store.js", "// Persistence for stock levels. Which engine backs it is decided in docs/adr.\nconst rows = new Map();\n\nfunction save(sku, qty) {\n  rows.set(sku, qty);\n}\n\nfunction load(sku) {\n  return rows.get(sku) ?? 0;\n}\n\nmodule.exports = { save, load };\n");
    write(dir, "src/server.js", "const { save, load } = require('./store');\n\nfunction handle(req) {\n  if (req.method === 'PUT') return save(req.sku, req.qty);\n  return load(req.sku);\n}\n\nmodule.exports = { handle };\n");
    write(dir, "docs/adr/0001-language.md", "# 1. Node.js for the service\n\nStatus: accepted\n\nThe team already runs Node in production, so the service is written in plain Node.js without a framework.\n");
    write(dir, "docs/adr/0002-database.md", "# 2. Storage engine\n\nStatus: accepted\n\nWe evaluated PostgreSQL and SQLite. The service runs as a single process next to the warehouse scanners and never needs concurrent writers, so we chose **SQLite**, stored in `data/inventory.db`. PostgreSQL was rejected because it adds a server to operate for no gain at this size.\n");
    write(dir, "docs/adr/0003-retention.md", "# 3. Stock history retention\n\nStatus: accepted\n\nStock movements are kept for **90 days**; older rows are summarised into a monthly total and deleted.\n");
}

/// The answer the haystack hides.
pub const NEEDLE: &str = "Since the March firmware update the warehouse scanners flush their buffer every 47 seconds.";
/// Where it hides.
pub const NEEDLE_PATH: &str = "docs/ops/day-031.md";

/// One day of operations notes: words the needle shares (scanners, buffer, warehouse) in other
/// sentences, so the search has to rank, not just match.
fn ops_day(day: usize) -> String {
    let crews = ["north dock", "south dock", "cold room", "returns bay", "mezzanine"];
    let events = [
        "the scanners were rebooted after a power dip",
        "the label printer ran out of ribbon",
        "a pallet jack was sent for repair",
        "the buffer pool of the stock database was resized",
        "two forklifts were recharged overnight",
        "the warehouse doors were serviced",
        "a shipment of returns was counted twice",
    ];
    let mut text = format!("# Operations, day {day}\n\n");
    for shift in 0..3 {
        text.push_str(&format!(
            "## Shift {}\n\nAt the {} {}. The supervisor logged {} pallets and {} open tickets.\n\n",
            shift + 1,
            crews[(day + shift) % crews.len()],
            events[(day * 3 + shift) % events.len()],
            40 + (day * 7 + shift * 3) % 60,
            (day + shift) % 9,
        ));
    }
    if format!("docs/ops/day-{day:03}.md") == NEEDLE_PATH {
        text.push_str(&format!("## Firmware\n\n{NEEDLE}\n"));
    }
    text
}

const HAYSTACK_DAYS: usize = 60;

fn haystack(dir: &Path) {
    write(dir, "README.md", "# Warehouse operations\n\nDaily notes of the warehouse crews, one file a day in `docs/ops/`.\n");
    for day in 1..=HAYSTACK_DAYS {
        write(dir, &format!("docs/ops/day-{day:03}.md"), &ops_day(day));
    }
}

/// Every day of the haystack as one text — the long context a model is asked to find the needle in.
pub fn haystack_text() -> String {
    (1..=HAYSTACK_DAYS).map(ops_day).collect::<Vec<_>>().join("\n")
}

/// Runs `code` with node in `dir`, returning its trimmed stdout. `None` when node is missing or the
/// script fails — which a check reports as "the project no longer runs".
pub fn node_eval(dir: &Path, code: &str) -> Option<String> {
    let out = std::process::Command::new("node").arg("-e").arg(code).current_dir(dir).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Whether `node` can be run here at all, so tasks that need it are skipped rather than failed.
pub fn node_available() -> bool {
    std::process::Command::new("node").arg("--version").output().is_ok_and(|out| out.status.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_fixture_is_a_repository_with_its_files() {
        for fixture in [Fixture::Cart, Fixture::Shop, Fixture::Docs, Fixture::Haystack] {
            let dir = fixture.create();
            assert!(dir.join(".git").is_dir(), "{fixture:?} is not a repository");
            assert!(dir.join("README.md").is_file());
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    #[test]
    fn the_needle_is_in_one_day_and_its_words_in_many() {
        let text = haystack_text();
        assert_eq!(text.matches(NEEDLE).count(), 1);
        assert!(text.matches("scanners").count() > 10, "distractors share the needle's words");
        assert!(ops_day(31).contains(NEEDLE) && !ops_day(30).contains(NEEDLE), "in the middle, where a long context loses things");
    }

    #[test]
    fn the_shop_bug_is_really_there() {
        if !node_available() {
            return;
        }
        let dir = Fixture::Shop.create();
        let total = node_eval(&dir, "console.log(require('./src/checkout/checkout').checkoutSummary([{price: 100, qty: 1}], 10).total)");
        assert_eq!(total.as_deref(), Some("10"), "the fixture should start broken");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
