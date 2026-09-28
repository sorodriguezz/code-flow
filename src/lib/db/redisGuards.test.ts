import { describe, expect, it } from "vitest";
import { firstRefusedRedisCommand, refusedRedisCommand } from "./redisGuards";

describe("refusedRedisCommand", () => {
  it("refuses what takes the server down, blocks it, or breaks the shared connection", () => {
    for (const line of ["FLUSHALL", "flushdb async", "KEYS *", "SELECT 2", "MONITOR", "BLPOP q 0", "MULTI", "DEBUG SLEEP 5", "CLIENT PAUSE 1000"]) {
      expect(refusedRedisCommand(line), line).not.toBeNull();
    }
  });

  it("only refuses a stream read when it asks to block", () => {
    expect(refusedRedisCommand("XREAD COUNT 10 STREAMS s 0")).toBeNull();
    expect(refusedRedisCommand("XREAD BLOCK 0 STREAMS s $")?.command).toBe("XREAD");
  });

  it("lets ordinary commands and comments through", () => {
    for (const line of ["GET user:42", "SCAN 0 MATCH user:* COUNT 100", "# FLUSHALL is a comment here", "", "CLIENT LIST"]) {
      expect(refusedRedisCommand(line), line).toBeNull();
    }
  });
});

describe("firstRefusedRedisCommand", () => {
  it("finds the first refused line of a buffer", () => {
    expect(firstRefusedRedisCommand("GET a\nKEYS *\nFLUSHALL")).toBe("KEYS");
    expect(firstRefusedRedisCommand("GET a\nSET b 1")).toBeNull();
  });
});
