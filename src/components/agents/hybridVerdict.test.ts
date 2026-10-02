import { describe, expect, it } from "vitest";
import { verdictOf, withoutVerdict } from "./hybridText";

/**
 * The chip on a finished hybrid run and the chain's `chain.hybridPending` reason are decided on two
 * sides — this reading and `hybrid::prompts::parse_verdict` — from the same answer. The cases mirror
 * the Rust test, so the two cannot drift into a chip that says one thing and a reason another.
 */
describe("verdictOf", () => {
  it("reads the last line that names a verdict", () => {
    expect(verdictOf("Fixed the import.\n\nVERDICT: FIXED")).toBe("fixed");
    expect(verdictOf("**VERDICT: OK**")).toBe("ok");
    expect(verdictOf("VERDICT: PENDING — the test still fails")).toBe("pending");
    expect(verdictOf("VERDICT: CORREGIDO")).toBe("fixed");
    expect(verdictOf("VERDICT: OK\nVERDICT: maybe")).toBe("ok");
  });

  it("is as tolerant as the backend", () => {
    expect(verdictOf("VERDICT: PENDING.")).toBe("pending");
    expect(verdictOf("verdict: ok")).toBe("ok");
    expect(verdictOf("`VERDICT:` **FIXED**")).toBe("fixed");
  });

  it("answers nothing when there is no verdict", () => {
    expect(verdictOf("no verdict here")).toBeNull();
    expect(verdictOf("VERDICT: maybe")).toBeNull();
    expect(verdictOf("Verdicto: OK")).toBeNull();
  });
});

describe("withoutVerdict", () => {
  it("drops the closing verdict line and nothing else", () => {
    expect(withoutVerdict("Two things are left.\n\nVERDICT: PENDING\n")).toBe("Two things are left.");
    expect(withoutVerdict("A line that mentions VERDICT: in passing\nVERDICT: OK")).toBe(
      "A line that mentions VERDICT: in passing",
    );
    expect(withoutVerdict("No marker at all.")).toBe("No marker at all.");
  });
});
