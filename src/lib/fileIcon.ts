import {
  Braces,
  Database,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  FileType2,
  Hash,
  Package,
  Palette,
  Settings,
} from "lucide-react";

type IconComponent = typeof File;

export interface FileIcon {
  Icon: IconComponent;
  /** Literal hex rather than a CSS var: these are per-language identity colors (the same
   * ones an editor's icon theme uses), not part of the app's themed palette. Shades are
   * picked to stay legible on both the light and dark surfaces. */
  color: string;
}

const BY_EXT: Record<string, FileIcon> = {
  ts: { Icon: FileCode, color: "#3178c6" },
  tsx: { Icon: FileCode, color: "#3178c6" },
  js: { Icon: FileCode, color: "#d6a800" },
  jsx: { Icon: FileCode, color: "#d6a800" },
  mjs: { Icon: FileCode, color: "#d6a800" },
  cjs: { Icon: FileCode, color: "#d6a800" },
  json: { Icon: FileJson, color: "#c9a227" },
  jsonc: { Icon: FileJson, color: "#c9a227" },
  css: { Icon: Palette, color: "#38bdf8" },
  scss: { Icon: Palette, color: "#c76395" },
  less: { Icon: Palette, color: "#2a6496" },
  html: { Icon: FileCode, color: "#e34c26" },
  htm: { Icon: FileCode, color: "#e34c26" },
  vue: { Icon: FileCode, color: "#41b883" },
  svelte: { Icon: FileCode, color: "#ff3e00" },
  md: { Icon: FileText, color: "#5a9fd4" },
  markdown: { Icon: FileText, color: "#5a9fd4" },
  mdx: { Icon: FileText, color: "#5a9fd4" },
  txt: { Icon: FileText, color: "#9797ab" },
  py: { Icon: FileCode, color: "#4b8bbe" },
  rs: { Icon: FileCode, color: "#e07a5f" },
  go: { Icon: FileCode, color: "#00add8" },
  java: { Icon: FileCode, color: "#d9704a" },
  kt: { Icon: FileCode, color: "#a97bff" },
  cs: { Icon: FileCode, color: "#68217a" },
  cls: { Icon: FileCode, color: "#5c9ead" },
  rb: { Icon: FileCode, color: "#cc342d" },
  php: { Icon: FileCode, color: "#7a86b8" },
  c: { Icon: FileCode, color: "#5a9fd4" },
  h: { Icon: FileCode, color: "#5a9fd4" },
  cpp: { Icon: FileCode, color: "#8a5fbf" },
  hpp: { Icon: FileCode, color: "#8a5fbf" },
  swift: { Icon: FileCode, color: "#f05138" },
  sql: { Icon: Database, color: "#e38c00" },
  dbml: { Icon: Database, color: "#4fa8a0" },
  prisma: { Icon: Database, color: "#5a67d8" },
  yaml: { Icon: Settings, color: "#cb6a5c" },
  yml: { Icon: Settings, color: "#cb6a5c" },
  toml: { Icon: Settings, color: "#9c6b4f" },
  ini: { Icon: Settings, color: "#9797ab" },
  env: { Icon: FileCog, color: "#d6a800" },
  sh: { Icon: FileTerminal, color: "#89b04b" },
  bash: { Icon: FileTerminal, color: "#89b04b" },
  zsh: { Icon: FileTerminal, color: "#89b04b" },
  ps1: { Icon: FileTerminal, color: "#4a8fd4" },
  bat: { Icon: FileTerminal, color: "#89b04b" },
  cmd: { Icon: FileTerminal, color: "#89b04b" },
  xml: { Icon: FileCode, color: "#7a9e5c" },
  svg: { Icon: FileImage, color: "#ba7cd4" },
  png: { Icon: FileImage, color: "#a074c4" },
  jpg: { Icon: FileImage, color: "#a074c4" },
  jpeg: { Icon: FileImage, color: "#a074c4" },
  gif: { Icon: FileImage, color: "#a074c4" },
  webp: { Icon: FileImage, color: "#a074c4" },
  ico: { Icon: FileImage, color: "#a074c4" },
  zip: { Icon: FileArchive, color: "#c08a3e" },
  tar: { Icon: FileArchive, color: "#c08a3e" },
  gz: { Icon: FileArchive, color: "#c08a3e" },
  lock: { Icon: FileLock, color: "#8b8b9b" },
  ttf: { Icon: FileType2, color: "#8b8b9b" },
  woff: { Icon: FileType2, color: "#8b8b9b" },
  woff2: { Icon: FileType2, color: "#8b8b9b" },
};

const BY_NAME: Record<string, FileIcon> = {
  "package.json": { Icon: Package, color: "#cb3837" },
  "package-lock.json": { Icon: FileLock, color: "#8b8b9b" },
  "pnpm-lock.yaml": { Icon: FileLock, color: "#8b8b9b" },
  "yarn.lock": { Icon: FileLock, color: "#8b8b9b" },
  "cargo.toml": { Icon: Package, color: "#e07a5f" },
  "cargo.lock": { Icon: FileLock, color: "#8b8b9b" },
  dockerfile: { Icon: Braces, color: "#2496ed" },
  "docker-compose.yml": { Icon: Braces, color: "#2496ed" },
  ".gitignore": { Icon: Hash, color: "#f05033" },
  ".gitattributes": { Icon: Hash, color: "#f05033" },
  "readme.md": { Icon: FileText, color: "#5a9fd4" },
  "license": { Icon: FileText, color: "#c9a227" },
};

const FALLBACK: FileIcon = { Icon: File, color: "#9797ab" };

/** Icon + language color for a file path, the way an editor's file-icon theme does it:
 * exact filename first (package.json, Dockerfile…), then extension, then a generic file. */
export function fileIconFor(path: string): FileIcon {
  const name = (path.split(/[\\/]/).pop() ?? path).toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return BY_EXT[ext] ?? FALLBACK;
}
