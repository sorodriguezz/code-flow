/** The workspace's turn slots (the runner's governor), live: read once, then pushed on `runner:slots`. */
import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { governorStatus, type GovernorStatus } from "../../../lib/tauri/runnerCommands";

export function useSlots(): GovernorStatus | null {
  const [slots, setSlots] = useState<GovernorStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void governorStatus()
      .then((s) => alive && setSlots(s))
      .catch(() => undefined);
    const off = listen<GovernorStatus>("runner:slots", (event) => setSlots(event.payload));
    return () => {
      alive = false;
      void off.then((fn) => fn()).catch(() => undefined);
    };
  }, []);
  return slots;
}
