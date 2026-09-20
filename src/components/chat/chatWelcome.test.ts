import { describe, expect, it } from "vitest";
import { greetingKey, startersFor } from "./ChatWelcome";
import { translations } from "../../lib/i18n/translations";
import { es } from "../../lib/i18n/translations.es";

/**
 * The greeting on the empty chat reads the clock, and the one way it can be wrong is silent: a
 * boundary off by an hour says "good evening" over lunch and nothing fails. So the bands are pinned
 * here rather than trusted — this is a pure function of the hour, which is exactly the shape that
 * deserves a test and costs nothing to have one.
 */
describe("greetingKey", () => {
  it("greets the morning from 5am until noon", () => {
    expect(greetingKey(5)).toBe("chat.welcomeMorning");
    expect(greetingKey(9)).toBe("chat.welcomeMorning");
    expect(greetingKey(11)).toBe("chat.welcomeMorning");
  });

  it("greets the afternoon from noon until 8pm", () => {
    expect(greetingKey(12)).toBe("chat.welcomeAfternoon");
    // The hour the screen was actually checked on, which is the one worth naming.
    expect(greetingKey(16)).toBe("chat.welcomeAfternoon");
    expect(greetingKey(19)).toBe("chat.welcomeAfternoon");
  });

  it("greets the evening from 8pm, and keeps doing so through the small hours", () => {
    expect(greetingKey(20)).toBe("chat.welcomeEvening");
    expect(greetingKey(23)).toBe("chat.welcomeEvening");
    // Midnight to 5am is deliberately still "evening" rather than a fourth string: neither language
    // has a greeting for 3am that is not a joke.
    expect(greetingKey(0)).toBe("chat.welcomeEvening");
    expect(greetingKey(4)).toBe("chat.welcomeEvening");
  });

  it("changes exactly at the two boundaries and nowhere else", () => {
    // The off-by-one that would otherwise ship unnoticed: 11:59 is morning, 12:00 is not.
    expect(greetingKey(11)).not.toBe(greetingKey(12));
    expect(greetingKey(19)).not.toBe(greetingKey(20));
    expect(greetingKey(4)).not.toBe(greetingKey(5));
  });
});

/**
 * The openers are offered before anything has been asked, which is the moment a promise is most
 * expensive: a card saying "a spreadsheet, ready to download" on a chat that cannot write one sends
 * the user to find out the hard way. So the gate is a plain function and is pinned here.
 */
describe("startersFor", () => {
  it("offers the file opener only where a turn can actually write one", () => {
    const withFiles = startersFor(true).map((s) => s.label);
    const without = startersFor(false).map((s) => s.label);

    expect(withFiles).toContain("chat.starterFileLabel");
    expect(without).not.toContain("chat.starterFileLabel");
    // And nothing else moves: the gate is one card, not a different screen.
    expect(without).toEqual(withFiles.filter((label) => label !== "chat.starterFileLabel"));
  });

  /**
   * The real copy, in both languages, not the key names.
   *
   * A starter's whole value is that the caret lands where the user's own content goes. Either the
   * draft ends at a labelled block (`"Error:\n"`) or mid-sentence (`"I want: "`) — a draft ending
   * in a full stop leaves the caret after a finished thought, which is the shape the first version
   * had and the reason nobody typed after it. Easy to undo by accident while editing prose.
   */
  it("ends every draft where the user's own content goes, in both languages", () => {
    for (const starter of startersFor(true)) {
      for (const [language, dictionary] of [
        ["en", translations.en],
        ["es", es],
      ] as const) {
        const draft = dictionary[starter.draft];
        expect(draft, `${language} ${starter.draft} is missing`).toBeTruthy();
        expect(
          draft!.endsWith("\n") || draft!.endsWith(": "),
          `${language} ${starter.draft} ends "${draft!.slice(-14)}" — the caret must land on the blank`,
        ).toBe(true);
        // And it has to carry the ask, not just the topic: the one-liners it replaced were all
        // under 60 characters and that was the complaint.
        expect(draft!.length, `${language} ${starter.draft} is too thin to be a prompt`).toBeGreaterThan(120);
      }
    }
  });

  it("gives every card a second line that is not its first", () => {
    for (const starter of startersFor(true)) {
      expect(es[starter.hint]).toBeTruthy();
      expect(es[starter.hint]).not.toBe(es[starter.label]);
    }
  });
});
