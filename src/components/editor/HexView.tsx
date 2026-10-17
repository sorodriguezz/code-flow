import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { readFileBytes } from "../../lib/tauri/commands";
import { hexDump } from "../../lib/hexDump";
import { formatBytes } from "../../state/systemLoadStore";
import { buttonClass } from "../common/Button";
import { useT } from "../../state/languageStore";

/** Bytes read per page: 4096 rows of the dump, which a `<pre>` draws without trouble. */
const PAGE = 64 * 1024;

/**
 * A binary file as a hex dump — VS Code's Hex Editor, read-only: the offset, the bytes and their text.
 * Read a page at a time (`read_file_bytes`), «Cargar más» for the next, so a 2 GB file costs what is
 * on screen. Nothing here writes: a binary has no buffer to save.
 */
export function HexView({ repoPath, path }: { repoPath: string; path: string }) {
  const t = useT();
  const [bytes, setBytes] = useState<number[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = async (offset: number) => {
    setBusy(true);
    try {
      const page = await readFileBytes(repoPath, path, offset, PAGE);
      setBytes((prev) => (offset === 0 ? page.bytes : [...prev, ...page.bytes]));
      setTotal(page.total);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setBytes([]);
    setTotal(null);
    setError("");
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, path]);

  if (error) return <p className="p-4 font-mono text-[12px] text-[var(--cf-danger)]">{error}</p>;
  if (total === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 size={16} className="animate-spin text-[var(--cf-text-muted)]" />
      </div>
    );
  }
  return (
    <div className="h-full overflow-auto">
      <pre className="select-text px-4 py-3 font-mono text-[12px] leading-[1.6] text-[var(--cf-text)]">{hexDump(bytes)}</pre>
      <div className="flex items-center gap-3 px-4 pb-4 text-[12px] text-[var(--cf-text-muted)]">
        <span>{t("editor.hexShown", { shown: formatBytes(bytes.length), total: formatBytes(total) })}</span>
        {bytes.length < total && (
          <button onClick={() => void load(bytes.length)} disabled={busy} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("editor.hexMore")}
          </button>
        )}
      </div>
    </div>
  );
}
