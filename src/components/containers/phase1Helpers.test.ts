import { describe, expect, it } from "vitest";
import { dockerfilePath } from "./DockerfileLint";
import { validImageReference } from "./containerActions";

describe("dockerfilePath", () => {
  it("joins a relative Dockerfile to the build folder", () => {
    expect(dockerfilePath("/w/app/", "Dockerfile")).toBe("/w/app/Dockerfile");
    expect(dockerfilePath("/w/app", "./docker/Dockerfile.dev")).toBe("/w/app/docker/Dockerfile.dev");
    expect(dockerfilePath("C:\\w\\app", "Dockerfile")).toBe("C:\\w\\app\\Dockerfile");
  });
  it("keeps an absolute one, and needs a folder otherwise", () => {
    expect(dockerfilePath("/w/app", "/other/Dockerfile")).toBe("/other/Dockerfile");
    expect(dockerfilePath("", "Dockerfile")).toBe("");
    expect(dockerfilePath("/w", " ")).toBe("");
  });
});

describe("validImageReference", () => {
  it("takes what tag and commit take", () => {
    for (const ok of ["app:1.0", "ghcr.io/org/app:1.0", "localhost:5000/app", "app@sha256:abc"]) expect(validImageReference(ok)).toBeNull();
  });
  it("refuses flags, blanks and spaces", () => {
    for (const bad of ["", "  ", "-f", "my app", "app:1.0 x"]) expect(validImageReference(bad)).not.toBeNull();
  });
});
