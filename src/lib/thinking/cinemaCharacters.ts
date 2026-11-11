import type { CharacterMesh } from "./characterMesh";
import { buildWalle } from "./walle";
import { buildBaymax } from "./baymax";
import { buildR2d2 } from "./r2d2";

export type CinemaCharacter = "calcifer" | "walle" | "baymax" | "r2d2";
export interface CharacterPose {
  time: number;
  gazeX: number;
  gazeY: number;
  work: number;
  read: number;
  write: number;
  speak: number;
  listen: number;
  quiet: number;
  done: number;
  failed: number;
  signal: number;
}

export const CINEMA_BUILDERS: Record<Exclude<CinemaCharacter, "calcifer">, (mesh: CharacterMesh, pose: CharacterPose) => void> = {
  walle: buildWalle,
  baymax: buildBaymax,
  r2d2: buildR2d2,
};
