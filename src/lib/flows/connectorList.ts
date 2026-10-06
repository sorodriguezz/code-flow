import { useEffect, useState } from "react";
import { flowsConnectors, type FlowConnector } from "../tauri/flowsCommands";

/** The connectors, asked for once: their definitions ship with the app and never change in it.
 *  Shared by the Conector's form and the palette, which lists one entry per service. */
let connectorList: Promise<FlowConnector[]> | null = null;

export function loadConnectors(): Promise<FlowConnector[]> {
  connectorList ??= flowsConnectors().catch(() => {
    connectorList = null;
    return [];
  });
  return connectorList;
}

export function useConnectors(enabled = true): FlowConnector[] {
  const [connectors, setConnectors] = useState<FlowConnector[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void loadConnectors().then((list) => {
      if (alive) setConnectors(list);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);
  return connectors;
}
