/**
 * What each kind of file *is*, drawn once: the emblem a framework file and a folder of that kind
 * carry in their lower right (`frameworkGlyphs.ts`). A controller is a pair of arrows, a service a
 * gear, a guard a shield, a hook a fishing hook — a silhouette that survives being drawn at half of
 * thirteen pixels.
 *
 * **Shape says the kind, colour says the layer.** Red for modules and entry points, blue for what
 * faces the network, amber for business logic, teal and green for data, violet for contracts, types
 * and state, yellow for events, pink for hooks and styles, slate for configuration and helpers. Two
 * kinds of one layer share a hue and never a shape.
 *
 * Every emblem is flat, on a 32×32 grid, with nothing finer than ~2.2 units. The holes — the play mark,
 * the check on the shield, the gear's axle — are *holes* (`fill-rule="evenodd"`), never white shapes,
 * so they show whatever the row is painted on and read in both themes. No gradients and no `id`s: an
 * emblem is nested inside every file and folder glyph that carries it, and an `id` repeated in every
 * row of a tree resolves to whichever copy comes first, hidden views included.
 *
 * `TINT` in a body is the one colour that is not the emblem's own: the component, drawn in each
 * framework's colour (React's blue, Angular's red, Vue's green) — see `FRAMEWORKS`.
 */
export const EMBLEMS: Record<string, string> = {
  /** An entry point — `main.ts`, `bootstrap()`: a play mark punched out of a red disc. */
  main:
    "<path fill=\"#e0234e\" fill-rule=\"evenodd\" d=\"M2 16a14 14 0 1 0 28 0a14 14 0 1 0 -28 0ZM12.5 9.6v12.8c0 .9 1 1.5 1.8 1l10-6.4c.7-.45.7-1.55 0-2l-10-6.4c-.8-.5-1.8.1-1.8 1Z\"/>",
  /** A module: a box — the unit everything else is filed into. Three faces, lit from the top left. */
  module:
    "<path fill=\"#f25c7d\" d=\"M16 2.5 28.5 9.3 16 16.1 3.5 9.3Z\"/>" +
    "<path fill=\"#e0234e\" d=\"M3.5 9.3 16 16.1V29.5L3.5 22.7Z\"/>" +
    "<path fill=\"#a8173a\" d=\"M28.5 9.3V22.7L16 29.5V16.1Z\"/>",
  /** Request in, response out: a controller, an API client, a server. */
  controller:
    "<path fill=\"#3b82f6\" d=\"M4 8.2h15V3.4L28.4 10.2 19 17v-4.8H4Z\"/>" +
    "<path fill=\"#60a5fa\" d=\"M28 19.8H13V15L3.6 21.8 13 28.6v-4.8h15Z\"/>",
  /** The gear that does the work. Eight chunky teeth — at 13px a finer gear is a blob. */
  service:
    "<path fill=\"#f59e0b\" fill-rule=\"evenodd\" d=\"M13.28 5.75L13.62 1.7L18.38 1.7L18.72 5.75A10.6 10.6 0 0 1 21.32 6.83L24.43 4.2L27.8 7.57L25.17 10.68A10.6 10.6 0 0 1 26.25 13.28L30.3 13.62L30.3 18.38L26.25 18.72A10.6 10.6 0 0 1 25.17 21.32L27.8 24.43L24.43 27.8L21.32 25.17A10.6 10.6 0 0 1 18.72 26.25L18.38 30.3L13.62 30.3L13.28 26.25A10.6 10.6 0 0 1 10.68 25.17L7.57 27.8L4.2 24.43L6.83 21.32A10.6 10.6 0 0 1 5.75 18.72L1.7 18.38L1.7 13.62L5.75 13.28A10.6 10.6 0 0 1 6.83 10.68L4.2 7.57L7.57 4.2L10.68 6.83A10.6 10.6 0 0 1 13.28 5.75ZM11.4 16a4.6 4.6 0 1 0 9.2 0a4.6 4.6 0 1 0 -9.2 0Z\"/>",
  /** A piece that slots in: a custom provider, a plugin. */
  provider:
    "<path fill=\"#fb923c\" d=\"M4 11.5c0-1.1.9-2 2-2h4.6a3.9 3.9 0 1 1 7.3 0H22c1.1 0 2 .9 2 2v4.1a3.9 3.9 0 1 1 0 7.3V27c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2Z\"/>",
  /** The database it talks to: three discs, the gaps between them left empty. */
  repository:
    "<path fill=\"#0d9488\" d=\"M5 7A11 4 0 0 0 27 7V12A11 4 0 0 1 5 12Z\"/>" +
    "<ellipse cx=\"16\" cy=\"7\" fill=\"#2dd4bf\" rx=\"11\" ry=\"4\"/>" +
    "<path fill=\"#14b8a6\" d=\"M5 14.6A11 4 0 0 0 27 14.6V19.4A11 4 0 0 1 5 19.4Z\"/>" +
    "<path fill=\"#14b8a6\" d=\"M5 22A11 4 0 0 0 27 22V25A11 4 0 0 1 5 25Z\"/>",
  /** A table — a header row over four cells. */
  entity:
    "<path fill=\"#059669\" d=\"M4 8a3 3 0 0 1 3-3h18a3 3 0 0 1 3 3v3.5H4Z\"/>" +
    "<path fill=\"#34d399\" d=\"M4 14h10.7v5.6H4Zm13.3 0H28v5.6H17.3ZM4 22.1h10.7V27H7a3 3 0 0 1-3-3Zm13.3 0H28V24a3 3 0 0 1-3 3h-7.7Z\"/>",
  /** A Mongoose schema: the leaf, in two greens. */
  schema:
    "<path fill=\"#3f9a3f\" d=\"M16 2C7 8.5 4.8 18.6 14.6 25.6V30h1.4V2Z\"/>" +
    "<path fill=\"#6cc24a\" d=\"M16 2c9 6.5 11.2 16.6 1.4 23.6V30H16Z\"/>",
  /** The shape of a payload: braces round a value. */
  dto:
    "<path fill=\"none\" stroke=\"#8b5cf6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.2\" d=\"M10.5 4.5h-.8c-1.9 0-2.7 1-2.7 3v5c0 1.9-1 3.5-3 3.5 2 0 3 1.6 3 3.5v5c0 2 .8 3 2.7 3h.8\"/>" +
    "<path fill=\"none\" stroke=\"#8b5cf6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.2\" d=\"M21.5 4.5h.8c1.9 0 2.7 1 2.7 3v5c0 1.9 1 3.5 3 3.5-2 0-3 1.6-3 3.5v5c0 2-.8 3-2.7 3h-.8\"/>" +
    "<circle cx=\"16\" cy=\"16\" r=\"2.9\" fill=\"#a78bfa\"/>",
  /** A contract: an outline with nothing inside. Types, interfaces, models that are only shapes. */
  interface:
    "<rect width=\"23\" height=\"23\" x=\"4.5\" y=\"4.5\" fill=\"none\" stroke=\"#8b5cf6\" stroke-dasharray=\"6 3.2\" stroke-dashoffset=\"3\" stroke-width=\"3.8\" rx=\"4\"/>",
  /** A fixed list of options. */
  enum:
    "<circle cx=\"6.5\" cy=\"8\" r=\"2.6\" fill=\"#c084fc\"/>" +
    "<circle cx=\"6.5\" cy=\"16\" r=\"2.6\" fill=\"#c084fc\"/>" +
    "<circle cx=\"6.5\" cy=\"24\" r=\"2.6\" fill=\"#c084fc\"/>" +
    "<path fill=\"#a855f7\" d=\"M11.5 6.2h15.7a1.8 1.8 0 0 1 0 3.6H11.5a1.8 1.8 0 0 1 0-3.6Zm0 8h15.7a1.8 1.8 0 0 1 0 3.6H11.5a1.8 1.8 0 0 1 0-3.6Zm0 8h15.7a1.8 1.8 0 0 1 0 3.6H11.5a1.8 1.8 0 0 1 0-3.6Z\"/>",
  /** A shield that lets the request through, or not. */
  guard:
    "<path fill=\"#22c55e\" fill-rule=\"evenodd\" d=\"M16 2.5 27 6.6v8c0 7-4.5 12.1-11 14.9C9.5 26.7 5 21.6 5 14.6v-8ZM9.7 16.3l2.4-2.4 2.6 2.6 5.6-5.6 2.4 2.4-8 8Z\"/>",
  /** A key: a Passport strategy, an injection token. */
  strategy:
    "<path fill=\"#eab308\" fill-rule=\"evenodd\" d=\"M1.8 16a8 8 0 1 0 16 0a8 8 0 1 0 -16 0ZM6.8 16a3 3 0 1 0 6 0a3 3 0 1 0 -6 0ZM16.5 13.6H29a1.5 1.5 0 0 1 1.5 1.5V23h-4.2v-4.6h-2.6v3.4h-4.2v-3.4h-3Z\"/>",
  /** A length of pipe — what goes in one end comes out the other parsed or rejected. */
  pipe:
    "<path fill=\"#06b6d4\" d=\"M8 11.5h16v9H8Z\"/>" +
    "<path fill=\"#0e7490\" d=\"M3.5 8.5a1.5 1.5 0 0 1 1.5-1.5h3a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 8 25H5a1.5 1.5 0 0 1-1.5-1.5Zm19 0A1.5 1.5 0 0 1 24 7h3a1.5 1.5 0 0 1 1.5 1.5v15A1.5 1.5 0 0 1 27 25h-3a1.5 1.5 0 0 1-1.5-1.5Z\"/>",
  /** An exception filter: the funnel. */
  filter:
    "<path fill=\"#f97316\" d=\"M4.6 4h22.8c1.3 0 2 1.5 1.2 2.5L19.5 17.6V27c0 .6-.3 1.1-.9 1.4l-3.6 1.8c-.8.4-1.5-.2-1.5-1V17.6L3.4 6.5C2.6 5.5 3.3 4 4.6 4Z\"/>",
  /** A ring the call passes through, on the way in and on the way out. */
  interceptor:
    "<path fill=\"#0ea5e9\" fill-rule=\"evenodd\" d=\"M5.5 16a10.5 10.5 0 1 0 21 0a10.5 10.5 0 1 0 -21 0ZM9 16a7 7 0 1 0 14 0a7 7 0 1 0 -14 0Z\"/>" +
    "<path fill=\"#7dd3fc\" d=\"M2 14.2h20.5V9.6L30 16l-7.5 6.4v-4.6H2Z\"/>",
  /** The layers a request crosses before it reaches a route. */
  middleware:
    "<path fill=\"#6366f1\" d=\"M16 3.5 29 10 16 16.5 3 10Z\"/>" +
    "<path fill=\"#818cf8\" d=\"M3 16l3.3-1.65L16 19.2l9.7-4.85L29 16l-13 6.5Zm0 6.2 3.3-1.65L16 25.4l9.7-4.85L29 22.2l-13 6.5Z\"/>",
  /** The `@`. */
  decorator:
    "<circle cx=\"16\" cy=\"16\" r=\"4.6\" fill=\"none\" stroke=\"#f43f5e\" stroke-width=\"3.2\"/>" +
    "<path fill=\"none\" stroke=\"#f43f5e\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.2\" d=\"M20.6 10.6v6.9a3.4 3.4 0 0 0 6.8 0V16A11.4 11.4 0 1 0 22.6 25\"/>",
  /** A WebSocket gateway: a signal going both ways. */
  gateway:
    "<circle cx=\"16\" cy=\"16\" r=\"3.6\" fill=\"#d946ef\"/>" +
    "<path fill=\"#d946ef\" d=\"M22.79 9.21A9.6 9.6 0 0 1 22.79 22.79L20.67 20.67A6.6 6.6 0 0 0 20.67 11.33ZM9.21 22.79A9.6 9.6 0 0 1 9.21 9.21L11.33 11.33A6.6 6.6 0 0 0 11.33 20.67Z\"/>" +
    "<path fill=\"#e879f9\" d=\"M27.15 5.96A15 15 0 0 1 27.15 26.04L24.92 24.03A12 12 0 0 0 24.92 7.97ZM4.85 26.04A15 15 0 0 1 4.85 5.96L7.08 7.97A12 12 0 0 0 7.08 24.03Z\"/>",
  /** A GraphQL resolver: the hexagon and its triangle, drawn here rather than borrowed. */
  resolver:
    "<path fill=\"none\" stroke=\"#e535ab\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2.2\" d=\"M16 3.8L26.57 9.9L26.57 22.1L16 28.2L5.43 22.1L5.43 9.9Z\"/>" +
    "<path fill=\"none\" stroke=\"#e535ab\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2.2\" d=\"M16 3.8L26.57 22.1L5.43 22.1Z\"/>" +
    "<circle cx=\"16\" cy=\"3.8\" r=\"2.7\" fill=\"#e535ab\"/>" +
    "<circle cx=\"26.57\" cy=\"9.9\" r=\"2.7\" fill=\"#e535ab\"/>" +
    "<circle cx=\"26.57\" cy=\"22.1\" r=\"2.7\" fill=\"#e535ab\"/>" +
    "<circle cx=\"16\" cy=\"28.2\" r=\"2.7\" fill=\"#e535ab\"/>" +
    "<circle cx=\"5.43\" cy=\"22.1\" r=\"2.7\" fill=\"#e535ab\"/>" +
    "<circle cx=\"5.43\" cy=\"9.9\" r=\"2.7\" fill=\"#e535ab\"/>",
  /** A plug. */
  adapter:
    "<path fill=\"#78909c\" d=\"M10 3.5a1.5 1.5 0 0 1 3 0V9h6V3.5a1.5 1.5 0 0 1 3 0V9h2a1.5 1.5 0 0 1 1.5 1.5V15c0 4.4-3.1 7.4-7 7.9V29h-5v-6.1c-3.9-.5-7-3.5-7-7.9v-4.5A1.5 1.5 0 0 1 8 9h2Z\"/>",
  /** Unit tests: a flask. */
  spec:
    "<path fill=\"#a3e635\" d=\"M11 3h10v2.6h-1.5v6.4L27.5 25c1.1 1.8-.1 4-2.2 4H6.7c-2.1 0-3.3-2.2-2.2-4l8-13V5.6H11Z\"/>" +
    "<path fill=\"#65a30d\" d=\"M8.2 19h15.6l3.7 6c1.1 1.8-.1 4-2.2 4H6.7c-2.1 0-3.3-2.2-2.2-4Z\"/>",
  /** End-to-end tests: the same flask in blue, so the two suites tell apart at a glance. */
  e2e:
    "<path fill=\"#7dd3fc\" d=\"M11 3h10v2.6h-1.5v6.4L27.5 25c1.1 1.8-.1 4-2.2 4H6.7c-2.1 0-3.3-2.2-2.2-4l8-13V5.6H11Z\"/>" +
    "<path fill=\"#0284c7\" d=\"M8.2 19h15.6l3.7 6c1.1 1.8-.1 4-2.2 4H6.7c-2.1 0-3.3-2.2-2.2-4Z\"/>",
  /** Configuration: sliders. */
  config:
    "<path fill=\"#94a3b8\" d=\"M4 6.5h24v3H4Zm0 8h24v3H4Zm0 8h24v3H4Z\"/>" +
    "<circle cx=\"11\" cy=\"8\" r=\"3.8\" fill=\"#64748b\"/>" +
    "<circle cx=\"21.5\" cy=\"16\" r=\"3.8\" fill=\"#64748b\"/>" +
    "<circle cx=\"14\" cy=\"24\" r=\"3.8\" fill=\"#64748b\"/>",
  /** A custom exception: the warning sign. */
  exception:
    "<path fill=\"#ef4444\" fill-rule=\"evenodd\" d=\"M14.3 4.2c.75-1.3 2.65-1.3 3.4 0l12 21c.75 1.3-.2 2.9-1.7 2.9H4c-1.5 0-2.45-1.6-1.7-2.9ZM14.4 11h3.2v8.4h-3.2ZM14.1 23.2a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0 -3.8 0Z\"/>",
  /** An event, an action: the bolt. */
  event:
    "<path fill=\"#facc15\" d=\"M18.6 2.5 6.4 18.2h8.8L13.4 29.5l12.2-15.7h-8.8Z\"/>",
  /** Whatever reacts to one — listeners, CQRS handlers, TypeORM subscribers: the bell. */
  listener:
    "<path fill=\"#eab308\" d=\"M16 3c-5 0-8 4-8 9v5.6l-2.6 4c-.6.9.1 2.1 1.2 2.1h18.8c1.1 0 1.8-1.2 1.2-2.1l-2.6-4V12c0-5-3-9-8-9Z\"/>" +
    "<circle cx=\"16\" cy=\"27\" r=\"3\" fill=\"#ca8a04\"/>",
  /** A scheduled task or cron job: the clock. */
  task:
    "<path fill=\"#38bdf8\" fill-rule=\"evenodd\" d=\"M2.5 16a13.5 13.5 0 1 0 27 0a13.5 13.5 0 1 0 -27 0ZM14.4 8h3.2v7.3l4.9 4.9-2.3 2.3-5.8-5.8Z\"/>",
  /** A queue processor or a worker: jobs lined up. */
  processor:
    "<path fill=\"#fb923c\" d=\"M3 9.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z\"/>" +
    "<path fill=\"#fdba74\" d=\"M14 9.5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2Z\"/>" +
    "<path fill=\"#fb923c\" d=\"M25 9.5 30 16l-5 6.5Z\"/>",
  /** A health check: the pulse. */
  health:
    "<path fill=\"none\" stroke=\"#f43f5e\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.4\" d=\"M3 16.5h6l3-7 5 14 3.5-9.5 2 2.5H29\"/>",
  /** Constants: a pin — the value is fixed. */
  constants:
    "<path fill=\"#94a3b8\" d=\"M11 3h10a1.5 1.5 0 0 1 0 3h-1v6.6l4.6 4.7c.9.95.25 2.7-1.1 2.7H17.6v7.8L16 30l-1.6-2.2V20H8.5c-1.35 0-2-1.75-1.1-2.7L12 12.6V6h-1a1.5 1.5 0 0 1 0-3Z\"/>",
  /** Helpers and utils: a wrench. */
  util:
    "<path fill=\"#94a3b8\" d=\"M20.6 3.3a7.5 7.5 0 0 0-8.4 10L4 21.5a3.2 3.2 0 0 0 4.5 4.5l8.2-8.2a7.5 7.5 0 0 0 10-8.4l-4.6 4.6-4.3-1.1-1.1-4.3Z\"/>",
  /** A seeder: the sprout. */
  seed:
    "<path fill=\"#65a30d\" d=\"M14.5 17h3v12h-3Z\"/>" +
    "<path fill=\"#84cc16\" d=\"M15.8 18.5C9.5 19 4.5 15.5 4 8.5c6.5-.5 11.3 3.5 11.8 10Z\"/>" +
    "<path fill=\"#a3e635\" d=\"M16.5 15.5C16.5 9 20.5 4.5 28 4c.3 7-4.4 11.2-11.5 11.5Z\"/>",
  /** A CQRS command: the prompt. */
  command:
    "<path fill=\"none\" stroke=\"#0ea5e9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.6\" d=\"M5 8.5 12.5 16 5 23.5M16 24h11\"/>",
  /** A query, a selector: the lens. */
  query:
    "<path fill=\"none\" stroke=\"#0ea5e9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.6\" d=\"M13.5 4.5a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm6.5 15.5 8 8\"/>",
  /** A mapper: one shape turned into another. */
  mapper:
    "<rect width=\"9.5\" height=\"9.5\" x=\"3\" y=\"3\" fill=\"#8b5cf6\" rx=\"2\"/>" +
    "<circle cx=\"23.5\" cy=\"23.5\" r=\"5.3\" fill=\"#a78bfa\"/>" +
    "<path fill=\"none\" stroke=\"#a78bfa\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.2\" d=\"M8 17v3.5c0 2.5 1.5 4 4 4h3M17.5 7.8h2.5c2.5 0 4 1.5 4 4v3\"/>",
  /** A factory. */
  factory:
    "<path fill=\"#f59e0b\" d=\"M3 28V13.5l6-4v4l6-4v4l6-4V4h5v24Z\"/>",
  /** A component: a window — its title bar, and a block of content. In the framework's own colour (`TINT`). */
  component:
    "<path fill=\"TINT\" fill-rule=\"evenodd\" d=\"M6 5h20a3 3 0 0 1 3 3v16a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Zm.5 7.5v11h19v-11Z\"/>" +
    "<rect width=\"11\" height=\"5.5\" x=\"10.5\" y=\"15.25\" fill=\"TINT\" rx=\"1.2\"/>",
  /** A component's template: markup. */
  template:
    "<path fill=\"none\" stroke=\"#f06529\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.4\" d=\"M10 8.5 3.8 16l6.2 7.5M22 8.5l6.2 7.5-6.2 7.5\"/>" +
    "<path fill=\"none\" stroke=\"#f59e0b\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.4\" d=\"M18.6 6.5 13.4 25.5\"/>",
  /** A component's styles: a drop of paint. */
  style:
    "<path fill=\"#ec4899\" fill-rule=\"evenodd\" d=\"M16 3c-.6 0-9.8 10.3-9.8 16.6a9.8 9.8 0 0 0 19.6 0C25.8 13.3 16.6 3 16 3Zm-4.4 17.2a1.6 1.6 0 0 1 3.2 0 2.6 2.6 0 0 0 2.6 2.6 1.6 1.6 0 0 1 0 3.2 5.8 5.8 0 0 1-5.8-5.8Z\"/>",
  /** Routing — routes, a router, a route resolver: the signpost. */
  route:
    "<path fill=\"#2dd4bf\" d=\"M14.4 3.5a1.6 1.6 0 0 1 3.2 0V29h-3.2Z\"/>" +
    "<path fill=\"#14b8a6\" d=\"M17.6 6.2h7.6l3.3 3.6-3.3 3.6h-7.6ZM14.4 15.6H6.8l-3.3 3.6 3.3 3.6h7.6Z\"/>",
  /** A directive: the pointer that changes what an element does. */
  directive:
    "<path fill=\"#fbbf24\" d=\"M7 3.2c0-.9 1-1.3 1.6-.7l16.2 14.2c.7.6.3 1.7-.6 1.8l-6.6.7 4 8.3c.3.6 0 1.3-.6 1.6l-2.6 1.2c-.6.3-1.3 0-1.6-.6l-3.9-8.2-4.6 4.4c-.6.6-1.7.2-1.7-.7Z\"/>",
  /** A hook, a composable — a fishing hook. */
  hook:
    "<circle cx=\"19.5\" cy=\"6\" r=\"2.9\" fill=\"none\" stroke=\"#f472b6\" stroke-width=\"2.9\"/>" +
    "<path fill=\"none\" stroke=\"#f472b6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.3\" d=\"M19.5 8.9v11.6a6.6 6.6 0 0 1-13.2 0v-5l4.6 4\"/>",
  /** A React context: one value shared down a tree. */
  context:
    "<path fill=\"none\" stroke=\"#60a5fa\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3\" d=\"M10 14.3 21 8.6M10 17.7 21 23.4\"/>" +
    "<circle cx=\"8\" cy=\"16\" r=\"4.6\" fill=\"#60a5fa\"/>" +
    "<circle cx=\"24\" cy=\"7\" r=\"4.2\" fill=\"#93c5fd\"/>" +
    "<circle cx=\"24\" cy=\"25\" r=\"4.2\" fill=\"#93c5fd\"/>",
  /** A store or a slice of state: the archive box. */
  store:
    "<path fill=\"#a78bfa\" d=\"M4.5 5h23a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-23A1.5 1.5 0 0 1 3 10.5v-4A1.5 1.5 0 0 1 4.5 5Z\"/>" +
    "<path fill=\"#8b5cf6\" fill-rule=\"evenodd\" d=\"M5 13.5h22V26a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2Zm7.5 3a1.5 1.5 0 0 0 0 3h7a1.5 1.5 0 0 0 0-3Z\"/>",
  /** A reducer: many inputs, one state. */
  reducer:
    "<path fill=\"none\" stroke=\"#c084fc\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.4\" d=\"M6 3.5V8c0 4.5 10 5.5 10 10.5V22M26 3.5V8c0 4.5-10 5.5-10 10.5\"/>" +
    "<path fill=\"#c084fc\" d=\"M9.8 21.5h12.4L16 29.5Z\"/>",
  /** An NgRx effect: something that happens as a result, and comes back round. */
  effect:
    "<path fill=\"none\" stroke=\"#fb7185\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.4\" d=\"M26 16A10 10 0 1 1 21 7.34\"/>" +
    "<path fill=\"#fb7185\" d=\"M25.5 9.7 23 2.6l-6.6 7.2Z\"/>",
  /** A validator, a validation schema: the check. */
  validator:
    "<path fill=\"#22c55e\" fill-rule=\"evenodd\" d=\"M2.5 16a13.5 13.5 0 1 0 27 0a13.5 13.5 0 1 0-27 0ZM9 16.3l2.5-2.5 3 3 6-6 2.5 2.5-8.5 8.5Z\"/>",
  /** A lockfile: the padlock. */
  lockfile:
    "<path fill=\"none\" stroke=\"#94a3b8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.4\" d=\"M9.5 14V10a6.5 6.5 0 0 1 13 0v4\"/>" +
    "<path fill=\"#94a3b8\" fill-rule=\"evenodd\" d=\"M7 13h18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V15a2 2 0 0 1 2-2Zm9 4.5a2.2 2.2 0 0 0-1.2 4.04V25h2.4v-3.46A2.2 2.2 0 0 0 16 17.5Z\"/>",
  /** A build script: the hammer. */
  build:
    "<path fill=\"#f59e0b\" d=\"M7.5 4h12l2.5 2.5h4.5a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5H22L19.5 16h-12A1.5 1.5 0 0 1 6 14.5v-9A1.5 1.5 0 0 1 7.5 4Z\"/>" +
    "<path fill=\"#b45309\" d=\"M10.5 16h4.5v12.5a1.5 1.5 0 0 1-1.5 1.5H12a1.5 1.5 0 0 1-1.5-1.5Z\"/>",
  /** A Bun macro: the wand — it runs at build time. */
  macro:
    "<path fill=\"none\" stroke=\"#e879f9\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"3.8\" d=\"M5 27 18.5 13.5\"/>" +
    "<path fill=\"#e879f9\" d=\"M23.5 2.5 25 7l4.5 1.5L25 10l-1.5 4.5L22 10l-4.5-1.5L22 7Z\"/>",
};

/**
 * Every kind a pack can name, with the emblem it wears and the colour its file and folder take. Most
 * kinds are their emblem; a few are another kind by a different name — an API client is drawn as a
 * controller, a composable as a hook, an NgRx action as an event — because what the reader needs is
 * the role, and the framework's own word for it is already in the file name.
 */
export const KINDS: Record<string, { emblem: string; tint: string }> = {
  main: { emblem: "main", tint: "#e0234e" },
  module: { emblem: "module", tint: "#e0234e" },
  component: { emblem: "component", tint: "TINT" },
  template: { emblem: "template", tint: "#f06529" },
  style: { emblem: "style", tint: "#ec4899" },
  controller: { emblem: "controller", tint: "#3b82f6" },
  api: { emblem: "controller", tint: "#3b82f6" },
  server: { emblem: "controller", tint: "#3b82f6" },
  service: { emblem: "service", tint: "#f59e0b" },
  provider: { emblem: "provider", tint: "#fb923c" },
  plugin: { emblem: "provider", tint: "#fb923c" },
  repository: { emblem: "repository", tint: "#14b8a6" },
  entity: { emblem: "entity", tint: "#10b981" },
  schema: { emblem: "schema", tint: "#4caf50" },
  dto: { emblem: "dto", tint: "#8b5cf6" },
  interface: { emblem: "interface", tint: "#8b5cf6" },
  enum: { emblem: "enum", tint: "#a855f7" },
  guard: { emblem: "guard", tint: "#22c55e" },
  validator: { emblem: "validator", tint: "#22c55e" },
  strategy: { emblem: "strategy", tint: "#eab308" },
  token: { emblem: "strategy", tint: "#eab308" },
  pipe: { emblem: "pipe", tint: "#06b6d4" },
  filter: { emblem: "filter", tint: "#f97316" },
  interceptor: { emblem: "interceptor", tint: "#0ea5e9" },
  middleware: { emblem: "middleware", tint: "#6366f1" },
  decorator: { emblem: "decorator", tint: "#f43f5e" },
  directive: { emblem: "directive", tint: "#fbbf24" },
  gateway: { emblem: "gateway", tint: "#d946ef" },
  resolver: { emblem: "resolver", tint: "#e535ab" },
  route: { emblem: "route", tint: "#2dd4bf" },
  adapter: { emblem: "adapter", tint: "#78909c" },
  spec: { emblem: "spec", tint: "#84cc16" },
  e2e: { emblem: "e2e", tint: "#38bdf8" },
  config: { emblem: "config", tint: "#94a3b8" },
  exception: { emblem: "exception", tint: "#ef4444" },
  event: { emblem: "event", tint: "#eab308" },
  action: { emblem: "event", tint: "#eab308" },
  listener: { emblem: "listener", tint: "#eab308" },
  task: { emblem: "task", tint: "#38bdf8" },
  processor: { emblem: "processor", tint: "#fb923c" },
  worker: { emblem: "processor", tint: "#fb923c" },
  health: { emblem: "health", tint: "#f43f5e" },
  constants: { emblem: "constants", tint: "#94a3b8" },
  util: { emblem: "util", tint: "#94a3b8" },
  seed: { emblem: "seed", tint: "#84cc16" },
  command: { emblem: "command", tint: "#0ea5e9" },
  query: { emblem: "query", tint: "#0ea5e9" },
  selector: { emblem: "query", tint: "#0ea5e9" },
  mapper: { emblem: "mapper", tint: "#8b5cf6" },
  factory: { emblem: "factory", tint: "#f59e0b" },
  hook: { emblem: "hook", tint: "#f472b6" },
  composable: { emblem: "hook", tint: "#f472b6" },
  context: { emblem: "context", tint: "#60a5fa" },
  store: { emblem: "store", tint: "#8b5cf6" },
  reducer: { emblem: "reducer", tint: "#c084fc" },
  effect: { emblem: "effect", tint: "#fb7185" },
  lockfile: { emblem: "lockfile", tint: "#94a3b8" },
  build: { emblem: "build", tint: "#f59e0b" },
  macro: { emblem: "macro", tint: "#e879f9" },
};
