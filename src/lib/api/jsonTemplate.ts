import { js as beautifyJs } from "js-beautify";
import { locateJsonError } from "../toolbox/json";

interface JsonTemplateCheck {
  hasVariables: boolean;
  error: string | null;
  offset: number;
}

/** Validate the body as a template. A complete variable can stand for any JSON value. */
export function checkJsonTemplate(source: string): JsonTemplateCheck {
  let hasVariables = false;
  let inString = false;
  const json = source.includes("{{")
    ? source.replace(/"|\\[\s\S]|\{\{([^{}]*)\}\}/g, (match, name?: string) => {
        if (match === '"') inString = !inString;
        if (!name?.trim()) return match;
        hasVariables = true;
        // Keep the same offsets for error markers in the original editor model.
        if (inString) return "x".repeat(match.length);
        return '""' + match.slice(2).replace(/[^\r\n]/g, " ");
      })
    : source;

  try {
    JSON.parse(json);
    return { hasVariables, error: null, offset: 0 };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Monaco needs a position even when the webview's JSON.parse error has none.
    let offset = 0;
    if (hasVariables) {
      try {
        offset = locateJsonError(json)?.offset ?? 0;
      } catch {
        // The native error still applies if the position parser hits its nesting limit.
      }
    }
    return { hasVariables, error: message, offset };
  }
}

export function formatJsonTemplate(source: string, hasVariables: boolean): string {
  return hasVariables
    ? beautifyJs(source, { indent_size: 2, templating: ["handlebars"] })
    : JSON.stringify(JSON.parse(source), null, 2);
}
