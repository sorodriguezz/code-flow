import { useState } from "react";
import { platform } from "@tauri-apps/plugin-os";

export type Platform = "macos" | "windows" | "linux" | "unknown";

function resolvePlatform(): Platform {
  try {
    const p = platform();
    return p === "macos" || p === "windows" || p === "linux" ? p : "unknown";
  } catch {
    // The OS plugin is unavailable outside the Tauri shell (plain `vite dev` in a browser).
    // Falling back to the user agent keeps modifier keys correct there instead of silently
    // treating a Mac as a PC.
    if (typeof navigator !== "undefined" && /mac/i.test(navigator.platform)) return "macos";
    return "unknown";
  }
}

let cached: Platform | null = null;

/** Same value as `usePlatform`, callable from non-React code (key handling, stores). Resolved
 * once and memoized — the OS doesn't change while the app runs. */
export function currentPlatform(): Platform {
  if (cached === null) cached = resolvePlatform();
  return cached;
}

export function isMac(): boolean {
  return currentPlatform() === "macos";
}

export function usePlatform(): Platform {
  const [value] = useState<Platform>(currentPlatform);
  return value;
}
