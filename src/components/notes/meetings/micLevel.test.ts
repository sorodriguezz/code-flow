import { describe, expect, it } from "vitest";
import { dbfs, meterPosition, verdict } from "./micLevel";

const fromDb = (db: number) => 10 ** (db / 20);
const speech = (db: number, peakDb = db + 10) => ({ rms: [0, fromDb(db), 0.0001], peak: [0, fromDb(peakDb), 0.0001] });

describe("micLevel", () => {
  it("judges by the loudest block of the window, not the gaps between words", () => {
    const { rms, peak } = speech(-25);
    expect(verdict(rms, peak)).toBe("good");
  });

  it("names each zone", () => {
    expect(verdict([], [])).toBe("silent");
    expect(verdict(...Object.values(speech(-70)) as [number[], number[]])).toBe("silent");
    expect(verdict(...Object.values(speech(-48)) as [number[], number[]])).toBe("tooLow");
    expect(verdict(...Object.values(speech(-10, -5)) as [number[], number[]])).toBe("limit");
    expect(verdict(...Object.values(speech(-20, -2)) as [number[], number[]])).toBe("limit");
    expect(verdict(...Object.values(speech(-15, 0)) as [number[], number[]])).toBe("tooLoud");
  });

  it("maps dBFS onto the meter", () => {
    expect(dbfs(1)).toBeCloseTo(0);
    expect(dbfs(0)).toBe(-90);
    expect(meterPosition(-60)).toBe(0);
    expect(meterPosition(0)).toBe(1);
    expect(meterPosition(-30)).toBeCloseTo(0.5);
  });
});
