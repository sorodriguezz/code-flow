/**
 * What a new architecture starts as: an empty sheet with a title, a version and the usual two
 * environments — the person drags its components in, or generates them from a source. Keys are
 * English like every document; the words are in the language the app is in when it is created,
 * since from then on they are the user's own text.
 */
import { ARCH_FORMAT, type ArchDoc } from "./types";

export function blankDoc(title: string, lang: "es" | "en", today = new Date().toISOString().slice(0, 10)): ArchDoc {
  return {
    format: ARCH_FORMAT,
    meta: {
      title,
      version: "v0.1.0",
      date: today,
      environments: lang === "es" ? { dev: "Desarrollo", prd: "Producción" } : { dev: "Development", prd: "Production" },
    },
    layout: [],
    components: {},
    connections: [],
  };
}
