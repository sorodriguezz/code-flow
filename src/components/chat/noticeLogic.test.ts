import { describe, expect, it } from "vitest";
import { composerNotice, firstBackup, noticeKey, type NoticeInputs } from "./noticeLogic";

const base: NoticeInputs = {
  provider: "claude",
  local: false,
  online: true,
  lastError: null,
  backup: null,
  update: null,
};
const error = (kind: string, message = "m") => ({ at: 1, kind, general: null, reference: null, message });

describe("composerNotice", () => {
  it("says nothing when nothing is wrong", () => {
    expect(composerNotice(base)).toBeNull();
  });

  it("offline outranks everything for an engine that needs the network, and is irrelevant to a local one", () => {
    const sick = { ...base, online: false, lastError: error("auth_required") };
    expect(composerNotice(sick)?.kind).toBe("offline");
    expect(composerNotice({ ...sick, local: true })?.kind).toBe("signIn");
  });

  it("a signed-out CLI comes before a spent plan, which comes before a missing one, then an update", () => {
    const update = { label: "Claude", from: "1.0.0", to: "1.1.0" };
    expect(composerNotice({ ...base, lastError: error("auth_required"), update })?.kind).toBe("signIn");
    expect(composerNotice({ ...base, lastError: error("quota"), update })?.kind).toBe("quota");
    expect(composerNotice({ ...base, lastError: error("cli_missing"), update })?.kind).toBe("cliMissing");
    expect(composerNotice({ ...base, update })?.kind).toBe("update");
  });

  it("an unrelated failure (a network blip) is not a notice", () => {
    expect(composerNotice({ ...base, lastError: error("other") })).toBeNull();
    expect(composerNotice({ ...base, lastError: error("overloaded") })).toBeNull();
  });

  it("a quota notice carries the provider's own words and the backup on offer", () => {
    const backup = { provider: "codex", model: "gpt-x" };
    const notice = composerNotice({ ...base, lastError: error("quota", "resets 9pm"), backup });
    expect(notice).toMatchObject({ kind: "quota", message: "resets 9pm", backup });
  });

  it("the same notice has the same key, a newer version of an update has another", () => {
    const a = composerNotice({ ...base, update: { label: "C", from: "1", to: "2" } })!;
    const b = composerNotice({ ...base, update: { label: "C", from: "1", to: "3" } })!;
    expect(noticeKey(a)).toBe(noticeKey(a));
    expect(noticeKey(a)).not.toBe(noticeKey(b));
  });

  it("the backup on offer is never the provider already in use and always names a model", () => {
    const list = [
      { provider: "claude", model: "sonnet" },
      { provider: "codex", model: "" },
      { provider: "grok", model: "grok-x" },
    ];
    expect(firstBackup(list, "claude")).toEqual({ provider: "grok", model: "grok-x" });
    expect(firstBackup([], "claude")).toBeNull();
  });
});
