import { useState } from "react";
import { platform } from "@tauri-apps/plugin-os";

export type Platform = "macos" | "windows" | "linux" | "unknown";

function resolvePlatform(): Platform {
  try {
    const p = platform();
    return p === "macos" || p === "windows" || p === "linux" ? p : "unknown";
  } catch {
    return "unknown";
  }
}

export function usePlatform(): Platform {
  const [value] = useState<Platform>(resolvePlatform);
  return value;
}
