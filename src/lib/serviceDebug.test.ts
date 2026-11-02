import { describe, expect, it } from "vitest";
import { canDebugService } from "./serviceDebug";

describe("canDebugService", () => {
  it("accepts what starts Node", () => {
    expect(canDebugService("pnpm start:local")).toBe(true);
    expect(canDebugService("PORT=4001 npm run dev")).toBe(true);
    expect(canDebugService("cross-env NODE_ENV=dev nest start --watch")).toBe(true);
    expect(canDebugService("C:\\tools\\node\\pnpm.cmd dev")).toBe(true);
    expect(canDebugService("node dist/main.js")).toBe(true);
  });

  it("refuses runtimes the Node inspector cannot reach", () => {
    expect(canDebugService("bun run dev")).toBe(false);
    expect(canDebugService("./mvnw spring-boot:run")).toBe(false);
    expect(canDebugService("docker compose up")).toBe(false);
    expect(canDebugService("python manage.py runserver")).toBe(false);
    expect(canDebugService("")).toBe(false);
  });
});
