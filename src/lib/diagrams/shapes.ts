/**
 * The draw.io shapes a generated diagram is allowed to be made of.
 *
 * **Every style string in this file was read out of the vendored draw.io build**
 * (`public/drawio/js/app.min.js`, the `createVertexTemplateEntry(...)` calls its shape palette is
 * built from), not written from memory. That matters more than it sounds: mxGraph has no notion of
 * an unknown shape. `shape=cylinder4` is not an error, it is a **plain rectangle** — so a style
 * string that is one letter off does not fail loudly, it silently produces the flat grey boxes that
 * made the AI drawing feature look like it had never heard of draw.io. Anything added here should
 * be grepped out of that bundle first.
 *
 * **The catalogue is the prompt.** `ai::DEFAULT_DIAGRAM_PROMPT` lists these keys and the engine
 * picks one per node, which is the whole reason the split exists: a model asked for a *style
 * string* invents plausible ones, while a model asked to choose from a list of eighty words picks
 * from the list. `ALIASES` then catches the near misses — a model that says `database`, `diamond`
 * or `usuario` meant `store`, `decision` and `actor`, and mapping those beats drawing three more
 * anonymous rectangles.
 */

/** How the in-app preview draws a kind. draw.io renders the real thing; this is the thumbnail. */
export type Glyph =
  | "rect"
  | "round"
  | "ellipse"
  | "circle"
  | "rhombus"
  | "parallelogram"
  | "hexagon"
  | "trapezoid"
  | "cylinder"
  | "cylinder-h"
  | "document"
  | "note"
  | "card"
  | "cloud"
  | "actor"
  | "person"
  | "compartments"
  | "container"
  | "bar"
  | "dot"
  | "text"
  | "tab";

export interface Shape {
  /** The mxGraph style, verbatim from the vendored palette. */
  style: string;
  width: number;
  height: number;
  glyph: Glyph;
  /** Whether the box may be widened to fit a long label. False for anything with a fixed aspect —
   *  a stretched stick figure or a 3:1 "cloud" reads as a rendering fault. */
  grow?: boolean;
  /** Containers: other nodes name this one in their `group`, and it is drawn around them. */
  container?: boolean;
  /** Compartment shapes: the label is a bold title over a rule with `fields` listed beneath. */
  compartments?: boolean;
}

/** The fill/stroke pairs draw.io's own palette uses, so a generated diagram looks drawn. */
const BLUE = "fillColor=#dae8fc;strokeColor=#6c8ebf;";
const GREEN = "fillColor=#d5e8d4;strokeColor=#82b366;";
const YELLOW = "fillColor=#fff2cc;strokeColor=#d6b656;";
const PURPLE = "fillColor=#e1d5e7;strokeColor=#9673a6;";
const RED = "fillColor=#f8cecc;strokeColor=#b85450;";
const ORANGE = "fillColor=#ffe6cc;strokeColor=#d79b00;";
const GREY = "fillColor=#f5f5f5;strokeColor=#999999;";
const WHITE = "fillColor=#ffffff;strokeColor=#000000;";

/** The prefix every `mxgraph.networks.*` entry in draw.io's palette carries. */
const NET = "html=1;outlineConnect=0;fillColor=#CCCCCC;strokeColor=#6881B3;gradientColor=none;gradientDirection=north;strokeWidth=2;verticalLabelPosition=bottom;verticalAlign=top;labelPosition=center;align=center;fontColor=#0066CC;";
/** …and the one `mxgraph.aws4.resourceIcon` carries. */
const AWS = "sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=#F78E04;gradientDirection=north;fillColor=#D05C17;strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;";

export const SHAPES = {
  // ---------------------------------------------------------------------- flowchart
  start: { style: `ellipse;whiteSpace=wrap;html=1;${GREEN}`, width: 140, height: 50, glyph: "ellipse", grow: true },
  end: { style: `ellipse;whiteSpace=wrap;html=1;${GREY}`, width: 140, height: 50, glyph: "ellipse", grow: true },
  process: { style: `rounded=1;whiteSpace=wrap;html=1;${BLUE}`, width: 170, height: 60, glyph: "round", grow: true },
  subprocess: { style: `shape=process;whiteSpace=wrap;html=1;backgroundOutline=1;${BLUE}`, width: 180, height: 70, glyph: "rect", grow: true },
  decision: { style: `rhombus;whiteSpace=wrap;html=1;${YELLOW}`, width: 170, height: 90, glyph: "rhombus", grow: true },
  data: { style: `shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;${BLUE}`, width: 170, height: 60, glyph: "parallelogram", grow: true },
  document: { style: `shape=document;whiteSpace=wrap;html=1;boundedLbl=1;${WHITE}`, width: 160, height: 80, glyph: "document", grow: true },
  store: { style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;${PURPLE}`, width: 150, height: 90, glyph: "cylinder", grow: true },
  queue: { style: `shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;direction=north;${ORANGE}`, width: 170, height: 70, glyph: "cylinder-h", grow: true },
  "internal-storage": { style: `shape=internalStorage;whiteSpace=wrap;html=1;backgroundOutline=1;${BLUE}`, width: 120, height: 80, glyph: "rect", grow: true },
  "manual-input": { style: `shape=manualInput;boundedLbl=1;whiteSpace=wrap;html=1;${YELLOW}`, width: 140, height: 70, glyph: "rect", grow: true },
  "manual-operation": { style: `shape=trapezoid;perimeter=trapezoidPerimeter;whiteSpace=wrap;html=1;fixedSize=1;flipV=1;${YELLOW}`, width: 150, height: 60, glyph: "trapezoid", grow: true },
  preparation: { style: `shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;${YELLOW}`, width: 160, height: 70, glyph: "hexagon", grow: true },
  delay: { style: `shape=delay;whiteSpace=wrap;html=1;${ORANGE}`, width: 130, height: 60, glyph: "rect", grow: true },
  display: { style: `shape=display;whiteSpace=wrap;html=1;${BLUE}`, width: 150, height: 60, glyph: "rect", grow: true },
  "off-page": { style: `shape=offPageConnector;whiteSpace=wrap;html=1;${GREY}`, width: 110, height: 80, glyph: "rect", grow: true },
  connector: { style: `ellipse;whiteSpace=wrap;html=1;${GREY}`, width: 50, height: 50, glyph: "circle" },
  loop: { style: `shape=loopLimit;whiteSpace=wrap;html=1;${YELLOW}`, width: 150, height: 70, glyph: "hexagon", grow: true },
  or: { style: `shape=orEllipse;perimeter=ellipsePerimeter;whiteSpace=wrap;html=1;backgroundOutline=1;${WHITE}`, width: 60, height: 60, glyph: "circle" },
  junction: { style: `shape=sumEllipse;perimeter=ellipsePerimeter;whiteSpace=wrap;html=1;backgroundOutline=1;${WHITE}`, width: 60, height: 60, glyph: "circle" },
  tape: { style: `shape=tape;whiteSpace=wrap;html=1;${WHITE}`, width: 150, height: 90, glyph: "rect", grow: true },
  card: { style: `shape=card;whiteSpace=wrap;html=1;${WHITE}`, width: 140, height: 80, glyph: "card", grow: true },
  note: { style: `shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=20;${YELLOW}`, width: 150, height: 90, glyph: "note", grow: true },
  text: { style: "text;html=1;whiteSpace=wrap;strokeColor=none;fillColor=none;align=center;verticalAlign=middle;", width: 170, height: 40, glyph: "text", grow: true },
  actor: { style: "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;outlineConnect=0;", width: 40, height: 70, glyph: "actor" },
  external: { style: `rounded=1;whiteSpace=wrap;html=1;dashed=1;${GREY}`, width: 170, height: 60, glyph: "round", grow: true },
  error: { style: `rounded=1;whiteSpace=wrap;html=1;${RED}`, width: 170, height: 60, glyph: "round", grow: true },
  cloud: { style: `ellipse;shape=cloud;whiteSpace=wrap;html=1;${WHITE}`, width: 160, height: 100, glyph: "cloud", grow: true },

  // ---------------------------------------------------------------------- UML
  class: { style: `rounded=0;whiteSpace=wrap;html=1;align=center;verticalAlign=top;${WHITE}`, width: 190, height: 42, glyph: "compartments", grow: true, compartments: true },
  interface: { style: `rounded=0;whiteSpace=wrap;html=1;align=center;verticalAlign=top;${GREEN}`, width: 190, height: 42, glyph: "compartments", grow: true, compartments: true },
  enum: { style: `rounded=0;whiteSpace=wrap;html=1;align=center;verticalAlign=top;${YELLOW}`, width: 190, height: 42, glyph: "compartments", grow: true, compartments: true },
  package: { style: "shape=folder;fontStyle=1;spacingTop=10;tabWidth=60;tabHeight=16;tabPosition=left;html=1;whiteSpace=wrap;", width: 170, height: 90, glyph: "tab", grow: true },
  component: { style: `shape=module;align=center;spacingLeft=20;verticalAlign=top;whiteSpace=wrap;html=1;${BLUE}`, width: 170, height: 70, glyph: "rect", grow: true },
  node: { style: `shape=cube;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;darkOpacity=0.05;darkOpacity2=0.1;size=12;${GREY}`, width: 170, height: 90, glyph: "rect", grow: true },
  usecase: { style: `ellipse;whiteSpace=wrap;html=1;${GREEN}`, width: 160, height: 70, glyph: "ellipse", grow: true },
  boundary: { style: "shape=umlBoundary;whiteSpace=wrap;html=1;", width: 110, height: 80, glyph: "rect", grow: true },
  control: { style: "ellipse;shape=umlControl;whiteSpace=wrap;html=1;", width: 80, height: 90, glyph: "circle" },
  "entity-object": { style: "ellipse;shape=umlEntity;whiteSpace=wrap;html=1;", width: 90, height: 90, glyph: "circle" },
  state: { style: `rounded=1;arcSize=40;whiteSpace=wrap;html=1;${BLUE}`, width: 160, height: 60, glyph: "round", grow: true },
  initial: { style: "ellipse;html=1;fillColor=#000000;strokeColor=#000000;", width: 30, height: 30, glyph: "dot" },
  final: { style: "ellipse;html=1;shape=endState;fillColor=#000000;strokeColor=#000000;", width: 30, height: 30, glyph: "dot" },
  fork: { style: "shape=line;html=1;direction=north;strokeWidth=6;strokeColor=#000000;", width: 170, height: 12, glyph: "bar" },

  // ---------------------------------------------------------------------- ER
  entity: { style: `rounded=0;whiteSpace=wrap;html=1;align=center;verticalAlign=top;${BLUE}`, width: 190, height: 42, glyph: "compartments", grow: true, compartments: true },
  "weak-entity": { style: `shape=ext;double=1;rounded=0;whiteSpace=wrap;html=1;align=center;verticalAlign=top;${BLUE}`, width: 190, height: 42, glyph: "compartments", grow: true, compartments: true },
  relationship: { style: `rhombus;whiteSpace=wrap;html=1;${GREEN}`, width: 150, height: 80, glyph: "rhombus", grow: true },
  attribute: { style: `ellipse;whiteSpace=wrap;html=1;${WHITE}`, width: 130, height: 55, glyph: "ellipse", grow: true },

  // ---------------------------------------------------------------------- BPMN
  "bpmn-task": { style: "shape=mxgraph.bpmn.task2;whiteSpace=wrap;rectStyle=rounded;size=10;html=1;expand=0;collapsible=0;taskMarker=abstract;", width: 170, height: 80, glyph: "round", grow: true },
  "bpmn-gateway": { style: "shape=mxgraph.bpmn.gateway2;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=rhombusPerimeter;outlineConnect=0;outline=none;symbol=none;gwType=exclusive;", width: 60, height: 60, glyph: "rhombus" },
  "bpmn-start": { style: "shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;outline=standard;symbol=general;", width: 55, height: 55, glyph: "circle" },
  "bpmn-intermediate": { style: "shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;outline=throwing;symbol=general;", width: 55, height: 55, glyph: "circle" },
  "bpmn-end": { style: "shape=mxgraph.bpmn.event;html=1;verticalLabelPosition=bottom;labelBackgroundColor=#ffffff;verticalAlign=top;align=center;perimeter=ellipsePerimeter;outlineConnect=0;aspect=fixed;outline=end;symbol=terminate2;", width: 55, height: 55, glyph: "circle" },
  "bpmn-data": { style: "shape=mxgraph.bpmn.data2;labelPosition=center;verticalLabelPosition=bottom;align=center;verticalAlign=top;size=15;html=1;", width: 55, height: 75, glyph: "document" },
  "bpmn-datastore": { style: "shape=datastore;html=1;labelPosition=center;verticalLabelPosition=bottom;align=center;verticalAlign=top;whiteSpace=wrap;", width: 80, height: 80, glyph: "cylinder" },

  // ---------------------------------------------------------------------- network / infrastructure
  server: { style: `${NET}shape=mxgraph.networks.server;`, width: 90, height: 100, glyph: "rect" },
  "web-server": { style: `${NET}shape=mxgraph.networks.web_server;`, width: 105, height: 105, glyph: "rect" },
  "virtual-server": { style: `${NET}shape=mxgraph.networks.virtual_server;`, width: 100, height: 110, glyph: "rect" },
  router: { style: `${NET}shape=mxgraph.networks.router;`, width: 110, height: 35, glyph: "rect" },
  switch: { style: `${NET}shape=mxgraph.networks.switch;`, width: 110, height: 35, glyph: "rect" },
  firewall: { style: `${NET}shape=mxgraph.networks.firewall;`, width: 100, height: 100, glyph: "rect" },
  "load-balancer": { style: `${NET}shape=mxgraph.networks.load_balancer;`, width: 110, height: 35, glyph: "rect" },
  storage: { style: `${NET}shape=mxgraph.networks.storage;`, width: 100, height: 100, glyph: "rect" },
  laptop: { style: `${NET}shape=mxgraph.networks.laptop;`, width: 110, height: 60, glyph: "rect" },
  pc: { style: `${NET}shape=mxgraph.networks.pc;`, width: 100, height: 70, glyph: "rect" },
  mobile: { style: `${NET}shape=mxgraph.networks.mobile;`, width: 55, height: 100, glyph: "rect" },
  internet: { style: `${NET}shape=mxgraph.networks.cloud;fontColor=#ffffff;`, width: 130, height: 70, glyph: "cloud" },

  // ---------------------------------------------------------------------- C4
  // Plain styles rather than the `mxgraph.c4.*` stencils, apart from the person: only `person` and
  // `webBrowserContainer` exist as stencils, and everything else in draw.io's own C4 palette is a
  // coloured rounded rectangle anyway.
  "c4-person": { style: "html=1;dashed=0;whiteSpace=wrap;fillColor=#083F75;strokeColor=#06315C;fontColor=#ffffff;shape=mxgraph.c4.person;align=center;", width: 130, height: 130, glyph: "person" },
  "c4-system": { style: "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#1061B0;strokeColor=#0D5091;fontColor=#ffffff;align=center;", width: 190, height: 90, glyph: "round", grow: true },
  "c4-container": { style: "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#23A2D9;strokeColor=#0E7DAD;fontColor=#ffffff;align=center;", width: 190, height: 90, glyph: "round", grow: true },
  "c4-component": { style: "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#63BEF2;strokeColor=#2086C9;fontColor=#ffffff;align=center;", width: 190, height: 90, glyph: "round", grow: true },
  "c4-external": { style: "rounded=1;whiteSpace=wrap;html=1;arcSize=10;fillColor=#8C8496;strokeColor=#736782;fontColor=#ffffff;align=center;", width: 190, height: 90, glyph: "round", grow: true },

  // ---------------------------------------------------------------------- AWS
  "aws-ec2": { style: `${AWS}resIcon=mxgraph.aws4.ec2;`, width: 78, height: 78, glyph: "rect" },
  "aws-lambda": { style: `${AWS}resIcon=mxgraph.aws4.lambda;`, width: 78, height: 78, glyph: "rect" },
  "aws-s3": { style: `${AWS}resIcon=mxgraph.aws4.s3;gradientColor=#60A337;fillColor=#277116;`, width: 78, height: 78, glyph: "rect" },
  "aws-rds": { style: `${AWS}resIcon=mxgraph.aws4.rds;gradientColor=#4D72F3;fillColor=#3334B9;`, width: 78, height: 78, glyph: "rect" },
  "aws-api-gateway": { style: `${AWS}resIcon=mxgraph.aws4.api_gateway;gradientColor=#945DF2;fillColor=#5A30B5;`, width: 78, height: 78, glyph: "rect" },
  "aws-user": { style: "sketch=0;outlineConnect=0;dashed=0;verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=12;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.user;fillColor=#232F3D;strokeColor=none;", width: 78, height: 78, glyph: "person" },

  // ---------------------------------------------------------------------- containers
  group: { style: "rounded=1;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#666666;verticalAlign=top;align=left;spacingLeft=10;spacingTop=4;container=1;collapsible=0;recursiveResize=0;", width: 240, height: 160, glyph: "container", container: true },
  lane: { style: "swimlane;whiteSpace=wrap;html=1;startSize=28;horizontal=1;fillColor=none;container=1;collapsible=0;recursiveResize=0;", width: 240, height: 160, glyph: "container", container: true },
  pool: { style: "swimlane;whiteSpace=wrap;html=1;startSize=28;horizontal=1;fillColor=none;swimlaneFillColor=none;container=1;collapsible=0;recursiveResize=0;", width: 240, height: 160, glyph: "container", container: true },
  "c4-boundary": { style: "rounded=1;arcSize=20;whiteSpace=wrap;html=1;dashed=1;fillColor=none;strokeColor=#666666;fontColor=#333333;verticalAlign=top;align=left;spacingLeft=10;spacingTop=4;container=1;collapsible=0;recursiveResize=0;", width: 240, height: 160, glyph: "container", container: true },
  "aws-vpc": { style: "sketch=0;outlineConnect=0;html=1;whiteSpace=wrap;fontSize=12;fontStyle=0;shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.group_vpc;verticalAlign=top;align=left;grIconSize=32;spacingLeft=40;spacingTop=4;fontColor=#248814;strokeColor=#248814;fillColor=none;container=1;collapsible=0;recursiveResize=0;", width: 240, height: 160, glyph: "container", container: true },
} as const satisfies Record<string, Shape>;

export type Kind = keyof typeof SHAPES;

export const KINDS = Object.keys(SHAPES) as Kind[];

/** The kinds a node's `group` may point at. */
export const CONTAINER_KINDS = KINDS.filter((kind) => "container" in SHAPES[kind]);

/**
 * The near misses, mapped rather than dropped.
 *
 * Every entry here is a word a model actually reaches for when it means one of the kinds above —
 * the English synonym it prefers, the Spanish word it uses when the instruction was Spanish, or the
 * shape's own geometric name. Without this they all land on `process`, which is how a described
 * database, a described decision and a described actor came out as three identical blue rectangles.
 */
export const ALIASES: Record<string, Kind> = {
  // process
  task: "process", step: "process", action: "process", activity: "process", operation: "process",
  box: "process", rectangle: "process", rect: "process", service: "process", function: "process",
  method: "process", job: "process", tarea: "process", proceso: "process", accion: "process",
  acción: "process", paso: "process", servicio: "process",
  // subprocess
  "predefined-process": "subprocess", "sub-process": "subprocess", subroutine: "subprocess",
  call: "subprocess", subproceso: "subprocess",
  // decision
  diamond: "decision", condition: "decision", conditional: "decision", choice: "decision",
  branch: "decision", if: "decision", gateway: "decision", check: "decision", test: "decision",
  decision_node: "decision", decisión: "decision", condicion: "decision", condición: "decision",
  rombo: "decision",
  // start / end
  begin: "start", entry: "start", "start-event": "start", terminator: "start", inicio: "start",
  comienzo: "start", stop: "end", finish: "end", exit: "end", terminate: "end", "end-event": "end",
  fin: "end", final_node: "end",
  // data
  input: "data", output: "data", io: "data", parameter: "data", payload: "data", entrada: "data",
  salida: "data", dato: "data", datos: "data", parallelogram: "data",
  // store
  database: "store", db: "store", datastore: "store", "data-store": "store", persistence: "store",
  table: "store", repository: "store", "base-de-datos": "store", "basededatos": "store",
  almacen: "store", almacén: "store", cylinder: "store", disk: "store", bucket: "store",
  // queue
  topic: "queue", broker: "queue", kafka: "queue", "message-queue": "queue", cola: "queue",
  buffer: "queue", stream: "queue",
  // document / note
  doc: "document", report: "document", file: "document", paper: "document", informe: "document",
  documento: "document", archivo: "document", comment: "note", annotation: "note",
  remark: "note", nota: "note", comentario: "note", label: "text", caption: "text", titulo: "text",
  título: "text",
  // actor / external
  user: "actor", person: "actor", human: "actor", client: "actor", customer: "actor",
  usuario: "actor", persona: "actor", cliente: "actor", role: "actor", stakeholder: "actor",
  "third-party": "external", "external-system": "external", outside: "external", vendor: "external",
  externo: "external", terceros: "external", "external-service": "external", api: "external",
  // misc flowchart
  wait: "delay", timeout: "delay", pause: "delay", espera: "delay",
  failure: "error", fail: "error", exception: "error", reject: "error", rollback: "error",
  fallo: "error", fallar: "error", excepcion: "error", excepción: "error", rechazar: "error",
  screen: "display", monitor: "display", ui: "display", pantalla: "display",
  form: "manual-input", keyboard: "manual-input", formulario: "manual-input",
  manual: "manual-operation", setup: "preparation", init: "preparation", hexagon: "preparation",
  repeat: "loop", for: "loop", while: "loop", bucle: "loop", ciclo: "loop",
  merge: "junction", join: "junction", "on-page-connector": "connector", circle: "connector",
  ellipse: "connector", "off-page-connector": "off-page", memory: "internal-storage",
  cache: "internal-storage", nube: "cloud",
  // UML
  clase: "class", entidad: "entity", struct: "class", model: "class", dto: "class",
  interfaz: "interface", abstract: "class", trait: "interface", protocol: "interface",
  enumeration: "enum", enumeracion: "enum", enumeración: "enum",
  module: "component", componente: "component", library: "component", paquete: "package",
  namespace: "package", folder: "package", deployment: "node", host: "node", machine: "node",
  container: "node", vm: "node", pod: "node", "use-case": "usecase", "caso-de-uso": "usecase",
  estado: "state", "initial-state": "initial", "final-state": "final", "start-state": "initial",
  "fork-join": "fork", "fork-node": "fork", "join-node": "fork", barra: "fork",
  // ER
  "weak entity": "weak-entity", relacion: "relationship", relación: "relationship",
  atributo: "attribute", column: "attribute", field: "attribute",
  // network
  servidor: "server", backend: "server", "app-server": "server", "api-server": "server",
  frontend: "web-server", nginx: "web-server", apache: "web-server", proxy: "load-balancer",
  balancer: "load-balancer", "reverse-proxy": "load-balancer", lb: "load-balancer",
  cortafuegos: "firewall", waf: "firewall", enrutador: "router", gateway_device: "router",
  desktop: "pc", computer: "pc", ordenador: "pc", portatil: "laptop", portátil: "laptop",
  phone: "mobile", smartphone: "mobile", movil: "mobile", móvil: "mobile", tablet: "mobile",
  web: "internet", www: "internet", "the-internet": "internet",
  // containers
  swimlane: "lane", carril: "lane", tier: "group", layer: "group", zone: "group", area: "group",
  área: "group", subnet: "group", cluster: "group", grupo: "group", region: "group",
  boundary_box: "group", vpc: "aws-vpc",
};

/** Falls back to `process` — a described box that isn't quite any of the above is still a box. */
export function resolveKind(raw: string): Kind {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
  if (key in SHAPES) return key as Kind;
  if (key in ALIASES) return ALIASES[key];
  // Second pass on the un-hyphenated form: `data store` and `data-store` are the same word, and so
  // are `weak entity` and `weak-entity`.
  const spaced = key.replace(/-/g, " ");
  if (spaced in ALIASES) return ALIASES[spaced];
  return "process";
}

/**
 * The arrows an edge is allowed to be, and the mxGraph style for each.
 *
 * Same rule as the shapes: every one of these is a `createEdgeTemplateEntry` string from the
 * vendored palette. `edgeStyle` is left off deliberately — the layout picks orthogonal or straight
 * per edge depending on which way it runs, and appends it.
 */
export const EDGE_STYLES = {
  flow: "html=1;rounded=0;",
  dashed: "html=1;rounded=0;dashed=1;",
  async: "html=1;rounded=0;dashed=1;endArrow=openThin;endFill=0;",
  bidirectional: "html=1;rounded=0;startArrow=classic;startFill=1;",
  plain: "html=1;rounded=0;endArrow=none;",
  // UML
  inheritance: "html=1;rounded=0;endArrow=block;endSize=16;endFill=0;",
  implementation: "html=1;rounded=0;endArrow=block;endSize=12;endFill=0;dashed=1;",
  composition: "html=1;rounded=0;endArrow=diamondThin;endFill=1;endSize=18;",
  aggregation: "html=1;rounded=0;endArrow=diamondThin;endFill=0;endSize=18;",
  dependency: "html=1;rounded=0;endArrow=open;endSize=12;dashed=1;",
  association: "html=1;rounded=0;endArrow=open;endFill=1;endSize=12;",
  message: "html=1;rounded=0;verticalAlign=bottom;endArrow=block;",
  // ER — draw.io's own crow's-foot markers.
  "one-to-one": "html=1;rounded=0;endArrow=ERone;endFill=1;startArrow=ERone;startFill=1;",
  "one-to-many": "html=1;rounded=0;endArrow=ERmany;startArrow=ERone;startFill=1;",
  "many-to-many": "html=1;rounded=0;endArrow=ERmany;startArrow=ERmany;",
  "zero-or-one": "html=1;rounded=0;endArrow=ERzeroToOne;startArrow=ERone;startFill=1;",
} as const;

export type EdgeKind = keyof typeof EDGE_STYLES;

export const EDGE_KINDS = Object.keys(EDGE_STYLES) as EdgeKind[];

const EDGE_ALIASES: Record<string, EdgeKind> = {
  arrow: "flow", default: "flow", solid: "flow", next: "flow", calls: "flow", uses: "dependency",
  extends: "inheritance", generalization: "inheritance", inherits: "inheritance",
  realization: "implementation", implements: "implementation", "has-a": "composition",
  contains: "composition", "part-of": "aggregation", depends: "dependency", "depends-on": "dependency",
  link: "plain", line: "plain", none: "plain", "1-1": "one-to-one", "1-n": "one-to-many",
  "1-many": "one-to-many", "n-m": "many-to-many", "n-n": "many-to-many", "many-many": "many-to-many",
  "0-1": "zero-or-one", optional: "zero-or-one", event: "async", publish: "async", emits: "async",
  notify: "async", both: "bidirectional", "two-way": "bidirectional",
};

export function resolveEdgeKind(raw: string): EdgeKind {
  const key = raw.trim().toLowerCase().replace(/\s+/g, "-").replace(/_/g, "-");
  if (key in EDGE_STYLES) return key as EdgeKind;
  if (key in EDGE_ALIASES) return EDGE_ALIASES[key];
  return "flow";
}

/**
 * Whether draw.io writes a shape's label *under* it rather than inside it.
 *
 * True for every icon-shaped kind — the stick figure, the network stencils, the AWS glyphs — and
 * the preview has to agree, because a 40-pixel-wide actor whose name is drawn inside it shows four
 * letters of it. Read off the style rather than flagged per kind, for the reason `styleColors` is:
 * one source, so the preview cannot disagree with the canvas.
 */
/**
 * The fill, stroke and font a style string asks for, for the in-app preview to echo.
 *
 * Read back out of the style rather than kept beside it: two sources for one colour is two sources
 * that drift, and the preview claiming a shape is purple while draw.io draws it blue is worse than
 * no preview. draw.io's own defaults are a white fill and a black stroke, which is what a style
 * that names neither means.
 */
export function labelBelow(style: string): boolean {
  return style.includes("verticalLabelPosition=bottom");
}

export function styleColors(style: string): { fill: string; stroke: string; font: string } {
  const read = (key: string) => {
    // Last wins, the same as mxGraph: several entries above deliberately append an override.
    const found = [...style.matchAll(new RegExp(`(?:^|;)${key}=([^;]*)`, "g"))].pop();
    const value = found?.[1]?.trim();
    return value && value !== "none" && value !== "inherit" ? value : null;
  };
  return {
    fill: read("fillColor") ?? "transparent",
    stroke: read("strokeColor") ?? "#000000",
    font: read("fontColor") ?? "currentColor",
  };
}
