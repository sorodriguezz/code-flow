import { useEffect, useMemo, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { GitCompareArrows } from "lucide-react";
import { ApiModal } from "./ApiModal";
import { Checkbox } from "../common/Checkbox";
import { Select, type SelectOption } from "../common/Select";
import { apiGetHistorySnapshot } from "../../lib/tauri/apiCommands";
import { useApiStore } from "../../state/apiStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { statusColor } from "./methodStyle";
import type { ApiResponse } from "../../types/api";
import "../../lib/monacoSetup";

/** One side of the comparison, as it is drawn: the status line, the headers, the body. */
interface Side {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function sideOf(response: Pick<ApiResponse, "status" | "status_text" | "headers" | "body_text">): Side {
  return { status: response.status, statusText: response.status_text, headers: response.headers, body: pretty(response.body_text) };
}

/** Headers, sorted, then the body — so a diff shows a changed header as plainly as a changed field.
 *  `Date` and the like change on every answer and say nothing; they are left out. */
const NOISE = new Set(["date", "age", "x-request-id", "x-amzn-requestid", "x-correlation-id", "cf-ray", "etag", "last-modified", "expires", "set-cookie", "x-runtime"]);

function documentOf(side: Side, withHeaders: boolean): string {
  if (!withHeaders) return side.body;
  const headers = side.headers
    .filter(([name]) => !NOISE.has(name.toLowerCase()))
    .map(([name, value]) => `${name.toLowerCase()}: ${value}`)
    .sort()
    .join("\n");
  return `${side.status} ${side.statusText}\n${headers}\n\n${side.body}`;
}

/**
 * «Comparar con…»: the response on screen against an earlier one of the same request — a send from
 * the history, or a saved example — as a diff. What changed between yesterday's answer and today's
 * is the question a regression starts with.
 */
export function CompareResponsesModal({ tabId, response, onClose }: { tabId: string; response: ApiResponse; onClose: () => void }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const tab = useApiStore((s) => s.openTabs.find((entry) => entry.id === tabId) ?? null);
  const history = useApiStore((s) => s.history);
  const [choice, setChoice] = useState<string>("");
  const [other, setOther] = useState<Side | null>(null);
  const [withHeaders, setWithHeaders] = useState(false);
  const [error, setError] = useState("");

  const options = useMemo<SelectOption[]>(() => {
    const out: SelectOption[] = [];
    for (const example of tab?.draft.examples ?? []) {
      out.push({ value: `example:${example.id}`, label: t("api.compare.example", { name: example.name }) });
    }
    const sameRequest = history.filter((entry) =>
      tab?.requestId ? entry.request_id === tab.requestId : entry.method === response.sent.method && entry.url === response.sent.url,
    );
    for (const entry of sameRequest.slice(0, 50)) {
      const when = new Date(entry.created_at).toLocaleString();
      out.push({ value: `history:${entry.id}`, label: `${when} · ${entry.status ?? t("api.response.failed")}` });
    }
    return out;
  }, [history, response.sent.method, response.sent.url, t, tab]);

  // The previous send by default: the newest history row is usually the response on screen.
  useEffect(() => {
    if (choice !== "" || options.length === 0) return;
    const histories = options.filter((option) => option.value.startsWith("history:"));
    setChoice((histories[1] ?? histories[0] ?? options[0]).value);
  }, [choice, options]);

  useEffect(() => {
    if (!choice) return;
    let live = true;
    setError("");
    setOther(null);
    if (choice.startsWith("example:")) {
      const example = tab?.draft.examples.find((candidate) => `example:${candidate.id}` === choice);
      if (example) {
        setOther({
          status: example.status,
          statusText: example.statusText,
          headers: example.headers.filter((h) => h.enabled).map((h) => [h.key, h.value]),
          body: pretty(example.body),
        });
      }
      return;
    }
    const id = choice.slice("history:".length);
    const entry = history.find((candidate) => candidate.id === id);
    void (async () => {
      const raw = entry?.snapshot || (await apiGetHistorySnapshot(id).catch(() => null)) || "";
      try {
        const parsed = JSON.parse(raw) as { response?: ApiResponse | null };
        if (!live) return;
        if (!parsed.response) setError(t("api.compare.noBody"));
        else setOther(sideOf(parsed.response));
      } catch {
        if (live) setError(t("api.compare.noBody"));
      }
    })();
    return () => {
      live = false;
    };
  }, [choice, history, t, tab]);

  const current = sideOf(response);

  return (
    <ApiModal
      icon={GitCompareArrows}
      title={t("api.compare.title")}
      subtitle={tab?.name || response.sent.url}
      width="max-w-6xl"
      height="h-[80vh]"
      onClose={onClose}
      toolbar={
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text-muted)]">
            <Checkbox checked={withHeaders} onChange={setWithHeaders} />
            {t("api.compare.headers")}
          </label>
          <div className="w-[280px]">
            <Select size="sm" value={choice} placeholder={t("api.compare.pick")} onChange={setChoice} options={options} ariaLabel={t("api.compare.pick")} />
          </div>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="grid shrink-0 grid-cols-2 border-b border-[var(--cf-border)] text-[11px]">
          <StatusLine side={other} label={t("api.compare.before")} />
          <StatusLine side={current} label={t("api.compare.now")} />
        </div>
        <div className="min-h-0 flex-1">
          {options.length === 0 ? (
            <p className="p-4 text-[12px] text-[var(--cf-text-muted)]">{t("api.compare.nothing")}</p>
          ) : error ? (
            <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>
          ) : other ? (
            <DiffEditor
              height="100%"
              language="json"
              original={documentOf(other, withHeaders)}
              modified={documentOf(current, withHeaders)}
              theme={monacoTheme}
              options={{
                readOnly: true,
                originalEditable: false,
                fontSize: 12,
                renderSideBySide: true,
                useInlineViewWhenSpaceIsLimited: false,
                automaticLayout: true,
                maxComputationTime: 3000,
                scrollBeyondLastLine: false,
                minimap: { enabled: false },
              }}
            />
          ) : (
            <div className="h-full bg-[var(--cf-sunken)]" />
          )}
        </div>
      </div>
    </ApiModal>
  );
}

function StatusLine({ side, label }: { side: Side | null; label: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span className="text-[var(--cf-text-muted)]">{label}</span>
      {side && (
        <span className="font-semibold" style={{ color: statusColor(side.status) }}>
          {side.status} {side.statusText}
        </span>
      )}
    </div>
  );
}
