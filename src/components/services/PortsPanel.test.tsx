import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PortsPanel } from "./PortsPanel";

/**
 * The listening-ports view the "Puertos en escucha" row opens. What is pinned here is the one default
 * the user asked for by name (2026-10-01): "Only services" starts ticked, so the view opens on where
 * *their* services listen and the rest of the machine is one click away.
 */
describe("PortsPanel", () => {
  it("starts with only the services' ports", () => {
    const html = renderToStaticMarkup(<PortsPanel onOpenService={() => {}} />);
    expect(html).toMatch(/<input type="checkbox"[^>]*\schecked=""/);
  });
});
