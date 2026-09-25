import { createLucideIcon } from "lucide-react";

/**
 * The services dock's own glyph: lucide's terminal square with the app's mark for a service — the
 * `CirclePlay` the services pill and the service console wear — badged into its corner, because the
 * dock holds both (the user's ask, 2026-09-25: "una combinación entre terminal y servicio").
 *
 * A play mark rather than a cog, which is what lucide badges most of its icons with: the settings
 * gear sits directly under this button, and a terminal with a cog beside a cog reads as "terminal
 * settings". Built the way lucide builds its badged icons (`folder-cog`) so it sits in the set: the
 * outline stops short of the badge instead of running under it, and the prompt is raised a unit to
 * leave the badge its room. `createLucideIcon`, so `size`, `strokeWidth` and `className` behave as
 * they do on every other icon.
 */
export const ServicesDockIcon = createLucideIcon("services-dock", [
  ["path", { d: "M21 10.5V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5.5", key: "body" }],
  ["path", { d: "m7 10 2-2-2-2", key: "prompt" }],
  ["path", { d: "M11 12h2.5", key: "cursor" }],
  ["circle", { cx: "18", cy: "18", r: "4", key: "ring" }],
  // Filled rather than stroked: at a 4-unit radius a stroked triangle closes up into a blob.
  ["path", { d: "M16.9 16v4l3.1-2z", fill: "currentColor", stroke: "none", key: "play" }],
]);
