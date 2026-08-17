/**
 * A run id, minted on a page that is not a secure context.
 *
 * # Why `crypto.randomUUID()` cannot be used here
 *
 * It is only defined in a **secure context** — HTTPS, or localhost. This client is served over
 * plain HTTP from a LAN address (`http://192.168.x.x:8787`), so the property is simply absent and
 * calling it throws `crypto.randomUUID is not a function`. That is the same constraint that rules
 * out a service worker, arriving in a place nobody expects it: the failure is not a permission
 * prompt or a warning, it is a `TypeError` at the moment the user presses a button.
 *
 * `crypto.getRandomValues`, by contrast, **is** available in insecure contexts — it lives on
 * `Crypto` rather than on `SubtleCrypto`, which is the half that got restricted. So the entropy is
 * real here; only the convenience wrapper is missing, and this rebuilds it.
 *
 * The `Math.random` branch is a last resort for an environment with no `crypto` at all. It is not
 * cryptographically random and does not need to be: these ids name a job so its output can be
 * filed against it, and nothing anywhere trusts them as a secret. Every value that *is* a secret
 * in this feature is minted in Rust (see `remotectl/auth.rs`).
 */
export function newId(): string {
  const c = globalThis.crypto;

  if (typeof c?.randomUUID === "function") {
    return c.randomUUID();
  }

  if (typeof c?.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(16));
    // RFC 4122 version 4 and variant 10xx, so the value is a well-formed UUID rather than sixteen
    // random bytes wearing the shape of one. The backend stores it as a string either way, but a
    // malformed id would be a confusing thing to find in a database later.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
