/**
 * The icons an agent can be drawn with — a curated, statically imported set, so the bundle only
 * carries these (never lucide's whole `icons` map). Each has Spanish and English search words.
 */
import {
  Anchor, Atom, Bell, Bird, Bot, BookOpen, Boxes, Braces, Brain, Bug, Calendar, CalendarClock, Cat, ChartColumn, ChartLine,
  ClipboardCheck, Cloud, Code, CodeXml, Compass, Container, Cpu, Crown, Database, Dna, Dog, Eye, Feather, FileText, Fingerprint,
  Fish, FlaskConical, Flame, Gauge, Gavel, Gem, Ghost, GitBranch, GitMerge, Glasses, Globe, Hammer, HeartPulse, KeyRound,
  Kanban, Landmark, LayoutDashboard, Leaf, Lightbulb, ListChecks, Lock, Mail, Map as MapIcon, Megaphone, MessageSquare, MonitorSmartphone,
  Mountain, Network, NotebookPen, Orbit, Package, Paintbrush, Palette, PenTool, Puzzle, Rabbit, Radar, Rocket, Ruler, Sailboat,
  Satellite, Scale, ScrollText, SearchCode, Server, Shield, ShieldCheck, Smartphone, Snail, Sparkles, Squirrel, Star, Stethoscope,
  Target, Telescope, Terminal, TestTubeDiagonal, TreePine, Turtle, UserRound, WandSparkles, Workflow, Wrench, Zap,
  type LucideIcon,
} from "lucide-react";

export interface AgentIcon {
  id: string;
  Icon: LucideIcon;
  tags: string;
}

export const AGENT_ICONS: AgentIcon[] = [
  { id: "crown", Icon: Crown, tags: "líder jefe lead corona" },
  { id: "landmark", Icon: Landmark, tags: "arquitecto arquitectura architect" },
  { id: "server", Icon: Server, tags: "backend servidor api" },
  { id: "database", Icon: Database, tags: "datos sql dba base database" },
  { id: "code", Icon: Code, tags: "código dev code" },
  { id: "code-xml", Icon: CodeXml, tags: "html front xml" },
  { id: "braces", Icon: Braces, tags: "json reglas rules código" },
  { id: "terminal", Icon: Terminal, tags: "consola cli devops shell" },
  { id: "cpu", Icon: Cpu, tags: "procesador local modelo" },
  { id: "layout-dashboard", Icon: LayoutDashboard, tags: "dashboard ui panel" },
  { id: "monitor-smartphone", Icon: MonitorSmartphone, tags: "front móvil web ui frontend" },
  { id: "palette", Icon: Palette, tags: "diseño design ui color" },
  { id: "paintbrush", Icon: Paintbrush, tags: "estilos css styles" },
  { id: "shield", Icon: Shield, tags: "seguridad security" },
  { id: "shield-check", Icon: ShieldCheck, tags: "qa calidad quality seguridad" },
  { id: "bug", Icon: Bug, tags: "bug errores qa" },
  { id: "test-tube", Icon: TestTubeDiagonal, tags: "tests pruebas testing" },
  { id: "flask", Icon: FlaskConical, tags: "experimentos laboratorio lab" },
  { id: "file-text", Icon: FileText, tags: "docs documentos documentation" },
  { id: "book-open", Icon: BookOpen, tags: "docs manual guía" },
  { id: "notebook-pen", Icon: NotebookPen, tags: "notas analista analyst" },
  { id: "scroll-text", Icon: ScrollText, tags: "specs contratos contract" },
  { id: "scale", Icon: Scale, tags: "contratos legal balance" },
  { id: "gavel", Icon: Gavel, tags: "normas reglas juez judge" },
  { id: "ruler", Icon: Ruler, tags: "convenciones estilo conventions" },
  { id: "glasses", Icon: Glasses, tags: "revisor reviewer lector" },
  { id: "eye", Icon: Eye, tags: "revisión observador watch" },
  { id: "rocket", Icon: Rocket, tags: "devops deploy lanzamiento" },
  { id: "cloud", Icon: Cloud, tags: "nube infra cloud" },
  { id: "container", Icon: Container, tags: "docker contenedor" },
  { id: "boxes", Icon: Boxes, tags: "paquetes módulos packages" },
  { id: "package", Icon: Package, tags: "release paquete" },
  { id: "git-branch", Icon: GitBranch, tags: "git ramas branches" },
  { id: "git-merge", Icon: GitMerge, tags: "integración merge" },
  { id: "workflow", Icon: Workflow, tags: "flujo orquestación bff" },
  { id: "network", Icon: Network, tags: "red servicios bff microservicios" },
  { id: "radar", Icon: Radar, tags: "monitoreo monitoring" },
  { id: "search-code", Icon: SearchCode, tags: "investigar búsqueda search" },
  { id: "telescope", Icon: Telescope, tags: "explorar investigación research" },
  { id: "brain", Icon: Brain, tags: "ia pensar asesor advisor" },
  { id: "lightbulb", Icon: Lightbulb, tags: "ideas producto product" },
  { id: "puzzle", Icon: Puzzle, tags: "integración piezas" },
  { id: "wrench", Icon: Wrench, tags: "mantenimiento fix" },
  { id: "hammer", Icon: Hammer, tags: "construir build" },
  { id: "key-round", Icon: KeyRound, tags: "auth llaves keys" },
  { id: "lock", Icon: Lock, tags: "seguridad candado" },
  { id: "fingerprint", Icon: Fingerprint, tags: "identidad auth" },
  { id: "globe", Icon: Globe, tags: "web idiomas i18n" },
  { id: "smartphone", Icon: Smartphone, tags: "móvil app mobile" },
  { id: "calendar", Icon: Calendar, tags: "agenda calendario" },
  { id: "calendar-clock", Icon: CalendarClock, tags: "citas horario agenda" },
  { id: "stethoscope", Icon: Stethoscope, tags: "clínico médico salud" },
  { id: "heart-pulse", Icon: HeartPulse, tags: "salud paciente health" },
  { id: "user-round", Icon: UserRound, tags: "persona person" },
  { id: "bot", Icon: Bot, tags: "bot agente agent" },
  { id: "sparkles", Icon: Sparkles, tags: "ia magia ai" },
  { id: "wand", Icon: WandSparkles, tags: "generador magia" },
  { id: "zap", Icon: Zap, tags: "rápido rendimiento fast" },
  { id: "flame", Icon: Flame, tags: "performance hot" },
  { id: "leaf", Icon: Leaf, tags: "refactor limpieza clean" },
  { id: "gem", Icon: Gem, tags: "calidad quality" },
  { id: "star", Icon: Star, tags: "estrella star" },
  { id: "anchor", Icon: Anchor, tags: "estable stable" },
  { id: "compass", Icon: Compass, tags: "guía guide" },
  { id: "map", Icon: MapIcon, tags: "mapa map" },
  { id: "target", Icon: Target, tags: "objetivo producto goal" },
  { id: "chart-line", Icon: ChartLine, tags: "métricas metrics" },
  { id: "chart-column", Icon: ChartColumn, tags: "analítica analytics" },
  { id: "gauge", Icon: Gauge, tags: "rendimiento gauge" },
  { id: "bell", Icon: Bell, tags: "notificaciones notifications" },
  { id: "mail", Icon: Mail, tags: "correo email" },
  { id: "message-square", Icon: MessageSquare, tags: "chat mensajes" },
  { id: "megaphone", Icon: Megaphone, tags: "anuncios marketing" },
  { id: "clipboard-check", Icon: ClipboardCheck, tags: "aceptación checklist" },
  { id: "list-checks", Icon: ListChecks, tags: "tareas qa tasks" },
  { id: "kanban", Icon: Kanban, tags: "tablero pm board" },
  { id: "feather", Icon: Feather, tags: "escritor writer" },
  { id: "pen-tool", Icon: PenTool, tags: "diseño design" },
  { id: "ghost", Icon: Ghost, tags: "fantasma ghost" },
  { id: "cat", Icon: Cat, tags: "gato cat" },
  { id: "dog", Icon: Dog, tags: "perro dog" },
  { id: "bird", Icon: Bird, tags: "pájaro bird" },
  { id: "fish", Icon: Fish, tags: "pez fish" },
  { id: "rabbit", Icon: Rabbit, tags: "conejo rápido rabbit" },
  { id: "turtle", Icon: Turtle, tags: "tortuga turtle" },
  { id: "squirrel", Icon: Squirrel, tags: "ardilla squirrel" },
  { id: "snail", Icon: Snail, tags: "caracol snail" },
  { id: "atom", Icon: Atom, tags: "ciencia science" },
  { id: "dna", Icon: Dna, tags: "genética dna" },
  { id: "orbit", Icon: Orbit, tags: "órbita orbit" },
  { id: "satellite", Icon: Satellite, tags: "satélite satellite" },
  { id: "sailboat", Icon: Sailboat, tags: "barco boat" },
  { id: "mountain", Icon: Mountain, tags: "montaña mountain" },
  { id: "tree-pine", Icon: TreePine, tags: "árbol tree" },
];

const BY_ID = new Map(AGENT_ICONS.map((icon) => [icon.id, icon]));

/** A stable 32-bit hash, so an agent with no icon or colour chosen always gets the same ones. */
export function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The icon to draw: the chosen one, else one picked from the agent's id. */
export function agentIcon(icon: string | undefined, seed: string): LucideIcon {
  if (icon) {
    const found = BY_ID.get(icon);
    if (found) return found.Icon;
  }
  return AGENT_ICONS[hashOf(seed) % AGENT_ICONS.length].Icon;
}

export function searchIcons(query: string): AgentIcon[] {
  const q = query.trim().toLowerCase();
  if (!q) return AGENT_ICONS;
  return AGENT_ICONS.filter((icon) => icon.id.includes(q) || icon.tags.includes(q));
}
