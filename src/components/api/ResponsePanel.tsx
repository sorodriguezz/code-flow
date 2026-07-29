import { useEffect, useMemo, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import type { editor as MonacoEditorNS } from "monaco-editor";
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eraser,
  FileWarning,
  Inbox,
  Search,
  WrapText,
  X,
  XCircle,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useApiStore } from "../../state/apiStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { apiSaveFile } from "../../lib/tauri/apiCommands";
import { renderVisualizerTemplate } from "../../lib/api/visualizer";
import { EmptyState } from "../common/EmptyState";
import { SkeletonRows } from "../common/Skeleton";
import { statusColor } from "./methodStyle";
import type { TranslationKey } from "../../lib/i18n/translations";
import type { ApiResponse, KeyValue, ResponseTimings, SavedExample } from "../../types/api";

/** Above this, `JSON.parse` + `JSON.stringify` on the UI thread is a visible freeze. */
const PRETTY_LIMIT = 2 * 1024 * 1024;

/** Monaco tokenizes the whole model up front; a 50 MB body would lock the app for seconds. */
const DISPLAY_LIMIT = 5 * 1024 * 1024;

/** The four ways of rendering the same payload — a choice *within* the body, not beside it. */
type BodyView = "pretty" | "raw" | "preview" | "visualize";

/**
 * What the panel is showing.
 *
 * The body's renderings used to sit in the tab strip as peers of headers and cookies, which made
 * nine tabs where six of them were the same thing seen differently — and pushed the metadata off
 * the end of a narrow panel. They collapse into one `body` tab with its own picker, leaving the
 * strip to say what it actually offers: the payload, or something about the response.
 */
type ResponseTab = "body" | "headers" | "cookies" | "tests" | "console" | "timeline";

const BODY_VIEWS: { id: BodyView; label: TranslationKey }[] = [
  { id: "pretty", label: "api.response.pretty" },
  { id: "raw", label: "api.response.raw" },
  { id: "preview", label: "api.response.preview" },
  { id: "visualize", label: "api.response.visualize" },
];

const TAB_LABELS: Record<ResponseTab, TranslationKey> = {
  body: "api.tab.body",
  headers: "api.response.headers",
  cookies: "api.response.cookies",
  tests: "api.response.testResults",
  console: "api.response.console",
  timeline: "api.response.timeline",
};

const TAB_ORDER: ResponseTab[] = ["body", "headers", "cookies", "tests", "console", "timeline"];

export function ResponsePanel({ tabId }: { tabId: string }) {
  // A saved example shadows the live response while it's open, and gives it back untouched on
  // close — reading one back shouldn't cost you the response you just sent.
  const exampleView = useApiRuntimeStore((s) => s.exampleViews[tabId] ?? null);
  const liveResponse = useApiRuntimeStore((s) => s.responses[tabId] ?? null);
  const response = exampleView?.response ?? liveResponse;
  const sending = useApiRuntimeStore((s) => s.sending[tabId] ?? false);
  const setResponse = useApiRuntimeStore((s) => s.setResponse);
  const closeExample = useApiRuntimeStore((s) => s.closeExample);
  const prettyPrint = useApiStore((s) => s.settings.prettyPrint);
  const maxResponseBytes = useApiStore((s) => s.settings.maxResponseBytes);
  const updateDraft = useApiStore((s) => s.updateDraft);
  const setRequestExamples = useApiStore((s) => s.setRequestExamples);
  const t = useT();

  // Two axes now, and they're independent on purpose: tabbing to Headers and back leaves the body
  // on whichever rendering you were reading it in.
  const [tab, setTab] = useState<ResponseTab>("body");
  // `null` means "whatever suits this payload". Only an explicit click on the picker pins a
  // rendering, and only until the next response — see the reset below.
  const [pickedBodyView, setPickedBodyView] = useState<BodyView | null>(null);
  const [copied, markCopied] = useCopyFlag();

  const contentType = response ? headerValue(response.headers, "content-type") : "";
  const binary = response?.body_base64 != null && response.body_base64 !== "";
  const bodyText = response?.body_text ?? "";
  const bodyView = pickedBodyView ?? autoBodyView(contentType, response?.visualizer != null);

  // A new payload picks again from scratch: the rendering that suited a JSON body is the wrong
  // one for the PNG the next request answers with.
  useEffect(() => {
    setPickedBodyView(null);
  }, [response]);

  const pretty = useMemo(() => {
    const language = languageForContentType(contentType);
    if (!prettyPrint || language !== "json") return { text: bodyText, language, skipped: false };
    if (bodyText.length > PRETTY_LIMIT) return { text: bodyText, language, skipped: true };
    return { text: formatJson(bodyText), language, skipped: false };
  }, [bodyText, contentType, prettyPrint]);

  if (sending && !response) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]">
        <SkeletonRows count={8} className="p-4" />
      </div>
    );
  }

  if (!response) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]">
        <EmptyState icon={Inbox} title={t("api.response.empty")} />
      </div>
    );
  }

  const copyBody = () => {
    void navigator.clipboard.writeText(binary ? (response.body_base64 ?? "") : bodyText);
    markCopied();
  };

  const saveToFile = async () => {
    try {
      const path = await apiSaveFile(
        defaultFileName(contentType, binary),
        binary ? (response.body_base64 ?? "") : bodyText,
      );
      if (path) useToastStore.getState().pushToast(t("api.response.savedTo", { path }), "success");
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const saveAsExample = () => {
    const tab = useApiStore.getState().openTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;
    const label = `${response.status} ${response.status_text}`.trim();
    const name = label || t("api.response.exampleName", { n: tab.draft.examples.length + 1 });
    const example: SavedExample = {
      id: newId("example"),
      name,
      status: response.status,
      statusText: response.status_text,
      headers: response.headers.map(([key, value], index) => headerRow(key, value, index)),
      body: bodyText,
    };
    const examples = [...tab.draft.examples, example];
    if (tab.requestId) {
      // Straight to the row, so it shows up under the request in the tree immediately.
      void setRequestExamples(tab.requestId, examples);
      useToastStore.getState().pushToast(t("api.response.exampleSaved", { name }), "success");
    } else {
      // Nothing to hang it off yet: it stays in the draft, and the tree gets it once the user
      // files the request into a collection.
      updateDraft(tabId, { examples });
      useToastStore.getState().pushToast(t("api.response.exampleSavedScratch", { name }), "success");
    }
  };

  const notices: string[] = [];
  if (maxResponseBytes > 0 && response.size_bytes >= maxResponseBytes) {
    notices.push(t("api.response.truncated", { size: formatBytes(response.size_bytes) }));
  }

  const testsPassed = response.tests.filter((test) => test.passed).length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--cf-surface)]">
      {exampleView && (
        <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] bg-[var(--cf-accent-soft)] px-3 py-1 text-[11px] text-[var(--cf-accent)]">
          <Bookmark size={12} className="shrink-0" />
          <span className="min-w-0 truncate">
            {t("api.example.viewing", { name: exampleView.name })}
          </span>
          <button
            onClick={() => closeExample(tabId)}
            className="ml-auto flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 hover:bg-[color-mix(in_oklab,var(--cf-accent)_18%,transparent)]"
          >
            <X size={11} />
            {t("api.example.close")}
          </button>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-3 border-b border-[var(--cf-border)] px-3 py-1.5">
        <StatusPill response={response} />
        <div className="flex min-w-0 items-center gap-3 text-[11px] text-[var(--cf-text-muted)]">
          {/* An example never travelled, so it has no time to report — showing "0 ms" would read
              as a measurement rather than the absence of one. */}
          {!exampleView && (
            <Metric label={t("api.response.time")} value={formatDuration(response.duration_ms)} />
          )}
          <Metric label={t("api.response.size")} value={formatBytes(response.size_bytes)} />
          {response.redirects.length > 0 && (
            <span title={response.redirects.join("\n")}>
              {t("api.response.redirects", { n: response.redirects.length })}
            </span>
          )}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            icon={copied ? Check : Copy}
            title={t("api.response.copy")}
            onClick={copyBody}
            active={copied}
          />
          <IconButton icon={Download} title={t("api.response.save")} onClick={() => void saveToFile()} />
          {/* Capturing and clearing act on the live response; neither means anything while an
              example is what's on screen, and the banner's own button is the way out. */}
          {!exampleView && (
            <>
              <IconButton
                icon={BookmarkPlus}
                title={t("api.response.saveAsExample")}
                onClick={saveAsExample}
              />
              <IconButton
                icon={Eraser}
                title={t("api.response.clear")}
                onClick={() => setResponse(tabId, null)}
              />
            </>
          )}
        </div>
      </div>

      {response.error ? (
        <ErrorView response={response} />
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--cf-border)] px-2">
            {/* The tabs give way to the picker when the panel is narrow: which rendering you're
                reading the body in has to stay reachable, where a tab you can scroll to doesn't. */}
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
              {TAB_ORDER.map((id) => (
                <ViewTab
                  key={id}
                  label={t(TAB_LABELS[id])}
                  active={tab === id}
                  onClick={() => setTab(id)}
                  badge={
                    id === "tests" && response.tests.length > 0
                      ? {
                          text: t("api.response.testsPassed", {
                            passed: testsPassed,
                            total: response.tests.length,
                          }),
                          tone: testsPassed === response.tests.length ? "success" : "danger",
                        }
                      : countBadge(id, response)
                  }
                />
              ))}
            </div>
            {tab === "body" && <BodyViewPicker value={bodyView} onChange={setPickedBodyView} />}
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === "body" && (
              <>
                {bodyView === "pretty" &&
                  (binary ? (
                    <BinaryBody response={response} onSave={() => void saveToFile()} />
                  ) : (
                    <BodyEditor
                      path={`inmemory://api-response/${tabId}/pretty`}
                      text={pretty.text}
                      language={pretty.language}
                      defaultWrap
                      notices={[
                        ...notices,
                        ...(pretty.skipped
                          ? [t("api.response.prettySkipped", { size: formatBytes(bodyText.length) })]
                          : []),
                      ]}
                    />
                  ))}

                {bodyView === "raw" &&
                  (binary ? (
                    <BinaryBody response={response} onSave={() => void saveToFile()} />
                  ) : (
                    <BodyEditor
                      path={`inmemory://api-response/${tabId}/raw`}
                      text={bodyText}
                      language="plaintext"
                      notices={notices}
                    />
                  ))}

                {bodyView === "preview" && (
                  <PreviewView response={response} contentType={contentType} />
                )}
                {bodyView === "visualize" && <VisualizeView response={response} />}
              </>
            )}

            {tab === "headers" && <HeadersView headers={response.headers} />}
            {tab === "cookies" && <CookiesView response={response} />}
            {tab === "tests" && <TestsView response={response} />}
            {tab === "console" && <ConsoleView response={response} />}
            {tab === "timeline" && <TimelineView timings={response.timings} />}
          </div>
        </>
      )}
    </div>
  );
}

function StatusPill({ response }: { response: ApiResponse }) {
  const t = useT();
  const color = response.error ? "var(--cf-danger)" : statusColor(response.status);
  const label = response.error
    ? t("api.response.failed")
    : `${response.status} ${response.status_text}`.trim();
  return (
    <span
      className="shrink-0 rounded-md border px-1.5 py-0.5 text-[11px] font-semibold"
      style={{
        color,
        borderColor: `color-mix(in oklab, ${color} 40%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="whitespace-nowrap">
      {label} <span className="font-medium text-[var(--cf-text)]">{value}</span>
    </span>
  );
}

function IconButton({
  icon: Icon,
  title,
  onClick,
  active,
}: {
  icon: LucideIcon;
  title: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      className={`rounded p-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
        active ? "text-[var(--cf-success)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      <Icon size={14} />
    </button>
  );
}

function ViewTab({
  label,
  active,
  onClick,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge: { text: string; tone: "muted" | "success" | "danger" } | null;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2 py-1.5 text-[12px] ${
        active
          ? "border-[var(--cf-accent)] text-[var(--cf-accent)]"
          : "border-transparent text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      }`}
    >
      {label}
      {badge && (
        <span
          className="rounded-full px-1.5 py-px text-[10px] font-medium"
          style={{
            color: badgeColor(badge.tone),
            backgroundColor: `color-mix(in oklab, ${badgeColor(badge.tone)} 14%, transparent)`,
          }}
        >
          {badge.text}
        </span>
      )}
    </button>
  );
}

function badgeColor(tone: "muted" | "success" | "danger"): string {
  if (tone === "success") return "var(--cf-success)";
  if (tone === "danger") return "var(--cf-danger)";
  return "var(--cf-text-muted)";
}

/**
 * The body's renderings, as a segmented control rather than four more tabs.
 *
 * Sits on the tab strip's own row: the response pane is the short one in the builder, and a
 * second row would cost real reading height for four buttons.
 */
function BodyViewPicker({ value, onChange }: { value: BodyView; onChange: (view: BodyView) => void }) {
  const t = useT();
  return (
    <div
      role="tablist"
      className="flex shrink-0 items-center gap-px rounded-md border border-[var(--cf-border)] bg-[var(--cf-bg)] p-px"
    >
      {BODY_VIEWS.map(({ id, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={value === id}
          onClick={() => onChange(id)}
          // Accent-soft for the selected one, the same pair the tree and the tab strip use for
          // "this is the one you're on" — the earlier grey-on-grey pill had to be hunted for.
          className={`whitespace-nowrap rounded-[5px] px-2 py-[3px] text-[11px] transition-colors ${
            value === id
              ? "bg-[var(--cf-accent-soft)] font-medium text-[var(--cf-accent)]"
              : "text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
          }`}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}

function countBadge(
  tab: ResponseTab,
  response: ApiResponse,
): { text: string; tone: "muted" | "success" | "danger" } | null {
  const count =
    tab === "headers"
      ? response.headers.length
      : tab === "cookies"
        ? response.set_cookies.length
        : tab === "console"
          ? response.consoleLines.length
          : 0;
  return count > 0 ? { text: String(count), tone: "muted" } : null;
}

function ErrorView({ response }: { response: ApiResponse }) {
  const t = useT();
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="rounded-lg border border-[var(--cf-danger)]/40 bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] p-3">
        <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--cf-danger)]">
          <AlertTriangle size={15} />
          {t("api.response.failed")}
        </div>
        <p className="mt-2 break-all font-mono text-[11px] text-[var(--cf-text-muted)]">
          {response.sent?.method} {response.sent?.url}
        </p>
        <p className="mt-2 whitespace-pre-wrap text-[12px] text-[var(--cf-text)]">{response.error}</p>
      </div>
    </div>
  );
}

function BinaryBody({ response, onSave }: { response: ApiResponse; onSave: () => void }) {
  const t = useT();
  // The type is the first thing you want to know about bytes you can't read — "application/pdf"
  // answers "what did I get?" where a byte count alone only answers "how much of it?".
  const mime = mimeOf(headerValue(response.headers, "content-type"));
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileWarning size={26} className="text-[var(--cf-text-muted)]" />
      {mime && <p className="font-mono text-[12px] text-[var(--cf-text-muted)]">{mime}</p>}
      <p className="text-[13px] text-[var(--cf-text)]">
        {t("api.response.binary", { size: formatBytes(response.size_bytes) })}
      </p>
      <button
        type="button"
        onClick={onSave}
        className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[12px] text-[var(--cf-text)] hover:bg-black/[0.03] dark:hover:bg-white/[0.05]"
      >
        <Download size={13} />
        {t("api.response.save")}
      </button>
      {/* `api_save_file` writes a Rust `String`, so the bytes can only leave as Base64 text. */}
      <p className="max-w-sm text-[11px] text-[var(--cf-text-muted)]">{t("api.response.binaryBase64")}</p>
    </div>
  );
}

function BodyEditor({
  path,
  text,
  language,
  notices,
  defaultWrap = false,
}: {
  path: string;
  text: string;
  language: string;
  notices: string[];
  defaultWrap?: boolean;
}) {
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const t = useT();
  const [wrap, setWrap] = useState(defaultWrap);
  const editorRef = useRef<MonacoEditorNS.IStandaloneCodeEditor | null>(null);

  const capped = text.length > DISPLAY_LIMIT;
  const shown = capped ? text.slice(0, DISPLAY_LIMIT) : text;
  const allNotices = capped
    ? [...notices, t("api.response.truncated", { size: formatBytes(DISPLAY_LIMIT) })]
    : notices;

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor;
  };

  // Monaco owns ⌘F once it has focus; the button is for the mouse-driven path into the same widget.
  const openFind = () => {
    editorRef.current?.focus();
    void editorRef.current?.getAction("actions.find")?.run();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 py-1">
        <button
          type="button"
          onClick={openFind}
          title={t("api.response.search")}
          aria-label={t("api.response.search")}
          className="rounded p-1 text-[var(--cf-text-muted)] hover:bg-black/[0.04] hover:text-[var(--cf-text)] dark:hover:bg-white/[0.06]"
        >
          <Search size={13} />
        </button>
        <button
          type="button"
          onClick={() => setWrap((current) => !current)}
          title={t("api.response.wrapLines")}
          aria-label={t("api.response.wrapLines")}
          aria-pressed={wrap}
          className={`rounded p-1 hover:bg-black/[0.04] dark:hover:bg-white/[0.06] ${
            wrap ? "text-[var(--cf-accent)]" : "text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
          }`}
        >
          <WrapText size={13} />
        </button>
        {allNotices.length > 0 && (
          <span className="ml-1 truncate text-[11px] text-[var(--cf-warning)]" title={allNotices.join(" · ")}>
            {allNotices.join(" · ")}
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          path={path}
          language={language}
          value={shown}
          theme={monacoTheme}
          onMount={handleMount}
          options={{
            ...OVERFLOW_SAFE_OPTIONS,
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize: 12,
            automaticLayout: true,
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            wordWrap: wrap ? "on" : "off",
            // Every entry in the default menu edits the buffer, which this one refuses.
            contextmenu: false,
            scrollbar: { alwaysConsumeMouseWheel: false },
          }}
        />
      </div>
    </div>
  );
}

function PreviewView({ response, contentType }: { response: ApiResponse; contentType: string }) {
  const t = useT();
  const mime = mimeOf(contentType);

  if (mime.startsWith("image/")) {
    const source =
      response.body_base64 != null && response.body_base64 !== ""
        ? `data:${mime};base64,${response.body_base64}`
        : `data:${mime};charset=utf-8,${encodeURIComponent(response.body_text)}`;
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-4">
        <img src={source} alt={t("api.response.preview")} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  if (mime.includes("html") || mime.includes("xhtml")) {
    return (
      <iframe
        title={t("api.response.preview")}
        // No `allow-same-origin` and no `allow-scripts`: this markup came off the network, and an
        // iframe that shared this document's origin could read the app's storage and DOM.
        sandbox=""
        srcDoc={response.body_text}
        // A page written for a browser assumes the UA's light canvas; painting it over the app's
        // dark surface would hide every unstyled element on it.
        style={{ colorScheme: "light", background: "Canvas" }}
        className="h-full w-full border-0"
      />
    );
  }

  return <EmptyState icon={Inbox} title={t("api.response.noPreview")} />;
}

function VisualizeView({ response }: { response: ApiResponse }) {
  const t = useT();
  const themeMode = useThemeStore((s) => s.resolved);
  const visualizer = response.visualizer;

  const srcDoc = useMemo(() => {
    if (!visualizer) return null;
    return visualizerDocument(renderVisualizerTemplate(visualizer.template, visualizer.data));
    // `themeMode` is not read here, but the document embeds the theme's colors — recompute on flip.
  }, [visualizer, themeMode]);

  if (!srcDoc) return <EmptyState icon={Inbox} title={t("api.response.noVisualizer")} />;

  return (
    <iframe
      title={t("api.response.visualize")}
      sandbox=""
      srcDoc={srcDoc}
      className="h-full w-full border-0"
    />
  );
}

/**
 * Wraps script-authored markup in a minimal document. The colors are read off the app's own custom
 * properties rather than hardcoded, since the iframe is a separate document and inherits none of
 * them — a light-theme visualizer on a dark background is the alternative.
 */
function visualizerDocument(body: string): string {
  const styles = getComputedStyle(window.document.documentElement);
  const cssVar = (name: string) => styles.getPropertyValue(name).trim();
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body { margin: 0; padding: 12px; font-family: ${cssVar("--font-sans")}; font-size: 13px; line-height: 1.5;
  color: ${cssVar("--cf-text")}; background: ${cssVar("--cf-bg")}; }
table { border-collapse: collapse; }
th, td { border: 1px solid ${cssVar("--cf-border")}; padding: 4px 8px; text-align: left; }
th { background: ${cssVar("--cf-surface-raised")}; }
a { color: ${cssVar("--cf-accent")}; }
</style></head><body>${body}</body></html>`;
}

function HeadersView({ headers }: { headers: [string, string][] }) {
  const t = useT();
  const [copied, markCopied] = useCopyFlag();

  if (headers.length === 0) return <EmptyState icon={Inbox} title={t("api.response.noHeaders")} />;

  const copyAll = () => {
    void navigator.clipboard.writeText(headers.map(([key, value]) => `${key}: ${value}`).join("\n"));
    markCopied();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 justify-end px-2 py-1">
        <IconButton
          icon={copied ? Check : Copy}
          title={t("api.response.copyHeaders")}
          onClick={copyAll}
          active={copied}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full table-fixed text-[12px]">
          <tbody>
            {headers.map(([key, value], index) => (
              <tr key={`${key}-${index}`} className="border-b border-[var(--cf-border)] align-top">
                <td className="w-1/3 break-words px-3 py-1.5 font-medium text-[var(--cf-text)]">{key}</td>
                <td className="break-words px-3 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
                  {value}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CookiesView({ response }: { response: ApiResponse }) {
  const t = useT();
  if (response.set_cookies.length === 0) {
    return <EmptyState icon={Inbox} title={t("api.response.noCookies")} />;
  }
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-left text-[12px]">
        <thead className="sticky top-0 bg-[var(--cf-surface)] text-[11px] uppercase tracking-wide text-[var(--cf-text-muted)]">
          <tr className="border-b border-[var(--cf-border)]">
            <th className="px-3 py-1.5 font-medium">{t("api.key")}</th>
            <th className="px-3 py-1.5 font-medium">{t("api.value")}</th>
            <th className="px-3 py-1.5 font-medium">{t("api.response.cookieDomain")}</th>
            <th className="px-3 py-1.5 font-medium">{t("api.response.cookiePath")}</th>
            <th className="px-3 py-1.5 font-medium">{t("api.response.cookieExpires")}</th>
            <th className="px-3 py-1.5 font-medium">{t("api.response.cookieFlags")}</th>
          </tr>
        </thead>
        <tbody>
          {response.set_cookies.map((cookie, index) => (
            <tr key={`${cookie.name}-${index}`} className="border-b border-[var(--cf-border)] align-top">
              <td className="px-3 py-1.5 font-medium text-[var(--cf-text)]">{cookie.name}</td>
              <td className="break-all px-3 py-1.5 font-mono text-[11px] text-[var(--cf-text-muted)]">
                {cookie.value}
              </td>
              <td className="px-3 py-1.5 text-[var(--cf-text-muted)]">{cookie.domain}</td>
              <td className="px-3 py-1.5 text-[var(--cf-text-muted)]">{cookie.path}</td>
              <td className="px-3 py-1.5 text-[var(--cf-text-muted)]">{cookie.expires ?? "—"}</td>
              <td className="px-3 py-1.5 text-[var(--cf-text-muted)]">
                {[cookie.secure ? "Secure" : "", cookie.http_only ? "HttpOnly" : ""]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TestsView({ response }: { response: ApiResponse }) {
  const t = useT();
  if (response.tests.length === 0) return <EmptyState icon={Inbox} title={t("api.response.noTests")} />;
  return (
    <div className="h-full overflow-auto py-1">
      {response.tests.map((test, index) => (
        <div
          key={`${test.name}-${index}`}
          className="flex items-start gap-2 border-b border-[var(--cf-border)] px-3 py-1.5 text-[12px]"
        >
          {test.passed ? (
            <CheckCircle2 size={14} className="mt-px shrink-0 text-[var(--cf-success)]" />
          ) : (
            <XCircle size={14} className="mt-px shrink-0 text-[var(--cf-danger)]" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-[var(--cf-text)]">{test.name}</p>
            {test.error && (
              <p className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] text-[var(--cf-danger)]">
                {test.error}
              </p>
            )}
          </div>
          <span className="shrink-0 text-[11px] text-[var(--cf-text-muted)]">
            {formatDuration(test.duration_ms)}
          </span>
        </div>
      ))}
    </div>
  );
}

const CONSOLE_COLORS: Record<string, string> = {
  log: "var(--cf-text)",
  info: "var(--cf-accent)",
  warn: "var(--cf-warning)",
  error: "var(--cf-danger)",
};

function ConsoleView({ response }: { response: ApiResponse }) {
  const t = useT();
  if (response.consoleLines.length === 0) {
    return <EmptyState icon={Inbox} title={t("api.response.noConsole")} />;
  }
  return (
    <div className="h-full overflow-auto py-1 font-mono text-[11px]">
      {response.consoleLines.map((line, index) => (
        <div key={index} className="flex gap-2 px-3 py-0.5">
          <span className="shrink-0 text-[var(--cf-text-muted)]">{formatClock(line.at)}</span>
          <span
            className="whitespace-pre-wrap break-all"
            style={{ color: CONSOLE_COLORS[line.level] ?? "var(--cf-text)" }}
          >
            {line.text}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The phases in wire order, with a monotone accent ramp so the bar reads left-to-right as one
 * request rather than as five unrelated categories.
 */
const TIMING_PHASES: { key: keyof ResponseTimings; labelKey: TranslationKey; color: string }[] = [
  { key: "dns_ms", labelKey: "api.timings.dns", color: "color-mix(in oklab, var(--cf-accent) 30%, var(--cf-surface))" },
  { key: "connect_ms", labelKey: "api.timings.connect", color: "color-mix(in oklab, var(--cf-accent) 50%, var(--cf-surface))" },
  { key: "tls_ms", labelKey: "api.timings.tls", color: "color-mix(in oklab, var(--cf-accent) 70%, var(--cf-surface))" },
  { key: "first_byte_ms", labelKey: "api.timings.firstByte", color: "var(--cf-accent)" },
  { key: "download_ms", labelKey: "api.timings.download", color: "var(--cf-success)" },
];

/** What an unmeasured span looks like: hatched, so it can never be mistaken for a real duration. */
const HATCH =
  "repeating-linear-gradient(45deg, var(--cf-border) 0 4px, color-mix(in oklab, var(--cf-border) 40%, transparent) 4px 8px)";

function TimelineView({ timings }: { timings: ResponseTimings }) {
  const t = useT();

  const measured = TIMING_PHASES.filter((phase) => timings[phase.key] >= 0);
  const sum = measured.reduce((total, phase) => total + timings[phase.key], 0);
  // `total_ms` is the authority on how long the request took; anything the phases don't account
  // for is real time that simply wasn't attributed, and it gets its own hatched span.
  const scale = Math.max(sum, timings.total_ms, 1);
  const remainder = Math.max(0, timings.total_ms - sum);

  return (
    <div className="h-full overflow-auto p-4">
      <div className="flex h-4 w-full overflow-hidden rounded border border-[var(--cf-border)]">
        {measured.map((phase) => (
          <div
            key={phase.key}
            title={`${t(phase.labelKey)} · ${formatDuration(timings[phase.key])}`}
            style={{ width: `${(timings[phase.key] / scale) * 100}%`, background: phase.color }}
          />
        ))}
        {remainder > 0 && (
          <div
            title={`${t("api.timings.other")} · ${formatDuration(remainder)}`}
            style={{ width: `${(remainder / scale) * 100}%`, background: HATCH }}
          />
        )}
      </div>

      <div className="mt-3 space-y-1">
        {TIMING_PHASES.map((phase) => {
          const value = timings[phase.key];
          const available = value >= 0;
          return (
            <div key={phase.key} className="flex items-center gap-2 text-[12px]">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: available ? phase.color : HATCH }}
              />
              <span className="flex-1 text-[var(--cf-text-muted)]">{t(phase.labelKey)}</span>
              <span
                className={
                  available ? "font-medium text-[var(--cf-text)]" : "italic text-[var(--cf-text-muted)]"
                }
              >
                {available ? formatDuration(value) : t("api.timings.unavailable")}
              </span>
            </div>
          );
        })}
        {remainder > 0 && (
          <div className="flex items-center gap-2 text-[12px]">
            <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: HATCH }} />
            <span className="flex-1 text-[var(--cf-text-muted)]">{t("api.timings.other")}</span>
            <span className="font-medium text-[var(--cf-text)]">{formatDuration(remainder)}</span>
          </div>
        )}
        <div className="flex items-center gap-2 border-t border-[var(--cf-border)] pt-1 text-[12px]">
          <span className="h-2.5 w-2.5 shrink-0" />
          <span className="flex-1 font-medium text-[var(--cf-text)]">{t("api.timings.total")}</span>
          <span className="font-medium text-[var(--cf-text)]">{formatDuration(timings.total_ms)}</span>
        </div>
      </div>
    </div>
  );
}

/** Flips true for a moment after a copy, so the button can acknowledge without a toast. */
function useCopyFlag(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const mark = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };
  return [copied, mark];
}

function headerValue(headers: [string, string][], name: string): string {
  const wanted = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === wanted)?.[1] ?? "";
}

function mimeOf(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/**
 * Which rendering a response opens in, from what the server said it sent.
 *
 * The point is that a PNG shouldn't land you on a screen of mojibake and an HTML page shouldn't
 * land you on its source: the payload already says which of the four views can read it, so the
 * panel picks that one instead of always starting at Pretty.
 *
 * A visualizer wins over everything — a post-response script that called `pm.visualizer.set()`
 * built a view of this exact response on purpose, which is a stronger statement of intent than
 * any header.
 */
function autoBodyView(contentType: string, hasVisualizer: boolean): BodyView {
  if (hasVisualizer) return "visualize";
  const mime = mimeOf(contentType);
  // Only what `PreviewView` can actually render. Sending anything else there would land on
  // "nothing to preview", which is worse than the body view's own account of the payload — a PDF
  // lands on Pretty, where `BinaryBody` names the type and offers to save it.
  if (mime.startsWith("image/") || mime.includes("html") || mime.includes("xhtml")) return "preview";
  return "pretty";
}

function languageForContentType(contentType: string): string {
  const mime = mimeOf(contentType);
  if (mime.includes("json")) return "json";
  if (mime.includes("html") || mime.includes("xhtml")) return "html";
  if (mime.includes("xml")) return "xml";
  if (mime.includes("javascript") || mime.includes("ecmascript")) return "javascript";
  if (mime.includes("css")) return "css";
  return "plaintext";
}

const EXTENSIONS: Record<string, string> = {
  json: "json",
  html: "html",
  xml: "xml",
  javascript: "js",
  css: "css",
  plaintext: "txt",
};

function defaultFileName(contentType: string, binary: boolean): string {
  // Base64 is what actually lands on disk for a binary body, and the name should say so.
  if (binary) return "response.b64";
  return `response.${EXTENSIONS[languageForContentType(contentType)] ?? "txt"}`;
}

/** Leaves a body that isn't valid JSON exactly as it arrived — the server's bytes are the truth. */
function formatJson(text: string): string {
  if (text.trim() === "") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function formatClock(at: number): string {
  return new Date(at).toLocaleTimeString();
}

function headerRow(key: string, value: string, index: number): KeyValue {
  return { id: `${newId("h")}-${index}`, key, value, description: "", enabled: true, type: "text" };
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
