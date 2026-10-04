import type { LspFileOperationFilter } from "./protocol";

/**
 * Which file renames a language server asked to hear about — the filters it declared under
 * `workspace.fileOperations` in its `initialize` answer.
 *
 * A server that keeps a map of the project's files in its own declarations needs a say before a
 * file moves: rust-analyzer rewrites the `mod` line that names a renamed module, and others update
 * their imports the way tsserver does. It says which renames it cares about with globs — every `.rs`
 * file, every folder — and the spec asks the client to send only those, so a Python server is not
 * woken up by a stylesheet being renamed.
 */

/**
 * An LSP glob as a regular expression over a forward-slashed absolute path.
 *
 * The spec's syntax, which is the usual one: `*` within a segment, `?` one character, `**` across
 * segments (none included), `{a,b}` alternatives, `[a-z]` a range and `[!a-z]` its complement.
 */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
  let out = "";
  let groups = 0;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i += 1;
        // `**/` is any number of whole segments, none included — so `**/*.rs` matches `main.rs` at
        // the root too. A `**` anywhere else is simply anything.
        if (glob[i + 1] === "/") {
          i += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (ch === "{") {
      groups += 1;
      out += "(?:";
    } else if (ch === "}" && groups > 0) {
      groups -= 1;
      out += ")";
    } else if (ch === "," && groups > 0) {
      out += "|";
    } else if (ch === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close < 0) {
        out += "\\[";
        continue;
      }
      const body = glob.slice(i + 1, close);
      const negated = body.startsWith("!");
      out += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replace(/[\\\]^]/g, "\\$&")}]`;
      i = close;
    } else {
      out += ch.replace(/[.+^$()|\\\]}]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, ignoreCase ? "i" : "");
}

/** Whether any of `filters` asks to hear about `absolutePath` moving. */
export function renameWanted(filters: readonly LspFileOperationFilter[], absolutePath: string, isDir: boolean): boolean {
  const path = absolutePath.replace(/\\/g, "/");
  return filters.some((filter) => {
    if (filter.scheme && filter.scheme !== "file") return false;
    const kind = filter.pattern.matches;
    if ((kind === "file" && isDir) || (kind === "folder" && !isDir)) return false;
    return globToRegExp(filter.pattern.glob, filter.pattern.options?.ignoreCase).test(path);
  });
}
