import { useEffect, useState } from "react";
import { currentRepoPath, onSessionsChanged, serverVersion } from "../../lib/lsp/client";
import { LANGUAGE_SERVERS, lspLanguageOf, type LanguageServer } from "../../lib/lsp/servers";
import { repoRecommendedServers } from "../../lib/vscodeExtensions";

/**
 * The server the repository's `.vscode/extensions.json` recommends for this file and this machine
 * does not have — what the status line offers to install. `null` for every other case: nothing
 * recommended, already installed, or a file no recommended server is for.
 */
export function useRecommendedServer(path: string | null, monacoLanguage: string | null): LanguageServer | null {
  const [missing, setMissing] = useState<LanguageServer | null>(null);
  const [nonce, setNonce] = useState(0);

  // A project switch starts its servers and points the client at the new repository.
  useEffect(() => onSessionsChanged(() => setNonce((n) => n + 1)), []);

  useEffect(() => {
    const repoPath = currentRepoPath();
    if (!path || !monacoLanguage || !repoPath) {
      setMissing(null);
      return;
    }
    let live = true;
    const language = lspLanguageOf(path, monacoLanguage);
    void (async () => {
      const recommended = await repoRecommendedServers(repoPath);
      if (recommended.length === 0) {
        if (live) setMissing(null);
        return;
      }
      // Only the recommended servers for this language are probed — not the whole catalogue.
      const candidates = LANGUAGE_SERVERS.filter(
        (server) => recommended.includes(server.id) && server.languages.includes(language),
      );
      for (const server of candidates) {
        if ((await serverVersion(server)) === null) {
          if (live) setMissing(server);
          return;
        }
      }
      if (live) setMissing(null);
    })();
    return () => {
      live = false;
    };
  }, [path, monacoLanguage, nonce]);

  return missing;
}
