/**
 * What the viewer draws: every box, frame and line already placed.
 *
 * The scene is the contract between layout (`layout/`) and the viewer page (`viewerHtml.ts` and its
 * runtime): the page computes nothing about geometry, only draws this and moves a camera over it,
 * which is what lets one runtime serve all five diagram types and lets the file a user downloads be
 * the page they were looking at.
 */
import type { ArchifyCard, ArchifyMode } from "./ir";

/** `[x, y, width, height]`. */
export type Box = [number, number, number, number];
export type Pt = [number, number];

export interface SceneSource {
  path: string;
  line: number;
  end: number;
  label: string;
  /** A browsable link, only when the document pins a public commit and the page may follow links. */
  href: string;
}

export type SceneShape = "card" | "pill" | "diamond" | "head";

export interface SceneNode {
  id: string;
  /** The colour key: one of archify's seven types, or a lifecycle state type. */
  kind: string;
  shape: SceneShape;
  /** The label, wrapped. */
  lines: string[];
  sublabel: string;
  tag: string;
  /** Whether the tag has room on the card, beside the sublabel — else it lives in the panel. */
  tagFit: boolean;
  step: string;
  box: Box;
  sources: SceneSource[];
  /** A sequence participant's lifeline: x, and where it starts and ends. */
  life?: [number, number, number];
  /** Set by a comparison: how this entity differs from the other diagram. */
  status?: "added" | "removed" | "changed";
}

export type FrameKind =
  | "region"
  | "security-group"
  | "lane"
  | "lane-exception"
  | "phase"
  | "group"
  | "stage";

export interface SceneFrame {
  id: string;
  kind: FrameKind;
  label: string;
  box: Box;
  /** How many frames wrap this one — drawn under it, so outer ones first. */
  depth: number;
  style: string;
}

export type EdgeStyle = "default" | "emphasis" | "security" | "dashed" | "return" | "error";

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  style: EdgeStyle;
  /** The routed path, as SVG path data with rounded corners. */
  d: string;
  points: Pt[];
  /** Where the label pill sits, and how wide it is drawn. */
  at: Box | null;
  note: string;
  classification: string;
  role: string;
  status?: "added" | "removed";
}

export interface SceneMessage {
  id: string;
  index: number;
  from: string;
  to: string;
  y: number;
  x1: number;
  x2: number;
  label: string;
  style: EdgeStyle;
  note: string;
  self: boolean;
  /** The label pill. */
  at: Box;
}

export interface SceneBand {
  label: string;
  y1: number;
  y2: number;
}

export interface SceneActivation {
  participant: string;
  x: number;
  y1: number;
  y2: number;
}

export interface ArchifyScene {
  mode: ArchifyMode;
  title: string;
  subtitle: string;
  direction: "LR" | "TB";
  bounds: Box;
  nodes: SceneNode[];
  frames: SceneFrame[];
  edges: SceneEdge[];
  /** Sequence only. */
  messages: SceneMessage[];
  bands: SceneBand[];
  activations: SceneActivation[];
  cards: ArchifyCard[];
  /** The colour keys in use, in a stable order — the legend. */
  legend: string[];
  /** A comparison's counts, when this scene is one. */
  delta?: { added: number; removed: number; changed: number };
}
