import { describe, expect, it } from "vitest";
import { diagnoseRun, serviceOnPort } from "./runDiagnosis";
import type { AiRunLine } from "../state/aiRunStore";

const line = (text: string): AiRunLine => ({ stream: "stderr", text });

/** Verbatim from a run a user watched for seventy-two seconds before stopping it. */
const CODEX_REFUSED = line(
  "2026-09-18T05:41:48.480267Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: IO error: Connection refused (os error 61), url: ws://127.0.0.1:11434/api/codex/v1/responses",
);

describe("an unreachable endpoint", () => {
  it("is reported once the same address has failed enough times to not be a blip", () => {
    expect(diagnoseRun(Array.from({ length: 5 }, () => CODEX_REFUSED))).toEqual({
      kind: "endpoint-unreachable",
      url: "ws://127.0.0.1:11434/api/codex/v1/responses",
      attempts: 5,
    });
  });

  it("says nothing about one or two failures on the way to a working run", () => {
    expect(diagnoseRun([CODEX_REFUSED])).toBeNull();
    expect(diagnoseRun([CODEX_REFUSED, CODEX_REFUSED])).toBeNull();
  });

  it("counts per address, so two flaky things do not add up to one confident answer", () => {
    const other = line("failed to connect: Connection refused, url: http://127.0.0.1:9999/v1");
    expect(diagnoseRun([CODEX_REFUSED, CODEX_REFUSED, other, other])).toBeNull();
  });

  it("names the address that failed most when several did", () => {
    const other = line("failed to connect: Connection refused, url: http://127.0.0.1:9999/v1");
    const lines = [...Array.from({ length: 4 }, () => CODEX_REFUSED), other, other, other];
    expect(diagnoseRun(lines)?.url).toBe("ws://127.0.0.1:11434/api/codex/v1/responses");
  });

  it("stays silent on a log with no connection failure in it", () => {
    expect(diagnoseRun([line("Reading additional input from stdin..."), line("thinking")])).toBeNull();
    expect(diagnoseRun([])).toBeNull();
    expect(diagnoseRun(undefined)).toBeNull();
  });

  it("stays silent when the CLI complained without naming an address", () => {
    // Nothing to tell the user to go and look at, so there is nothing worth saying over the log.
    expect(diagnoseRun(Array.from({ length: 6 }, () => line("Connection refused")))).toBeNull();
  });

  it("does not take the sentence's full stop into the URL", () => {
    const lines = Array.from({ length: 3 }, () =>
      line("failed to connect: Connection refused, url: http://127.0.0.1:11434/v1."),
    );
    expect(diagnoseRun(lines)?.url).toBe("http://127.0.0.1:11434/v1");
  });
});

describe("naming what lives on the port", () => {
  it("recognises the local services this app already knows about", () => {
    // "Nothing is listening on 11434" is a fact; "11434 is Ollama's port" is what makes it
    // actionable, which is the whole reason this mapping exists.
    expect(serviceOnPort("ws://127.0.0.1:11434/api/codex/v1/responses")).toBe("Ollama");
    expect(serviceOnPort("http://localhost:4096")).toBe("opencode");
  });

  it("answers null for a port it has no claim to make about", () => {
    expect(serviceOnPort("https://api.example.com/v1")).toBeNull();
    expect(serviceOnPort("http://127.0.0.1:7777")).toBeNull();
  });
});
