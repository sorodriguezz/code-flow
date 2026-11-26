import { describe, expect, it } from "vitest";
import type { Translate } from "../../state/languageStore";
import { micOptions } from "./micOptions";

const t: Translate = (key, params) => (params ? `${key}:${Object.values(params).join(",")}` : key);
const inputs = [
  { id: "coreaudio:built-in", name: "Micrófono del MacBook", isDefault: true },
  { id: "coreaudio:usb", name: "Jabra Speak", isDefault: false },
];

describe("microphone options", () => {
  it("offers the system's own first, named, then every input", () => {
    expect(micOptions(inputs, "", t)).toEqual([
      { value: "", label: "dictation.micDefaultNamed:Micrófono del MacBook" },
      { value: "coreaudio:built-in", label: "Micrófono del MacBook" },
      { value: "coreaudio:usb", label: "Jabra Speak" },
    ]);
  });

  it("keeps a microphone that was chosen and is unplugged now", () => {
    const options = micOptions(inputs, "coreaudio:headset", t);
    expect(options[options.length - 1]).toEqual({ value: "coreaudio:headset", label: "dictation.micAbsent" });
    // One that is plugged in is not listed twice.
    expect(micOptions(inputs, "coreaudio:usb", t)).toHaveLength(3);
  });

  it("says only «the system's» while the inputs are not known", () => {
    expect(micOptions(null, "", t)).toEqual([{ value: "", label: "dictation.micDefault" }]);
    expect(micOptions(null, "coreaudio:usb", t)).toHaveLength(1);
  });
});
