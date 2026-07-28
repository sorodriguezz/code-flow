import { useMemo, useRef, useState, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import {
  AlertTriangle,
  Braces,
  Download,
  FileCode,
  Loader2,
  Network,
  Play,
  Plus,
  Tags,
  X,
} from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { CollapsibleSection } from "../common/CollapsibleSection";
import { EmptyState } from "../common/EmptyState";
import { Select } from "../common/Select";
import { KeyValueTable } from "./KeyValueTable";
import { useApiStore } from "../../state/apiStore";
import { useApiRuntimeStore } from "../../state/apiRuntimeStore";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";
import { pushErrorToast } from "../../state/toastStore";
import { resolveRequest } from "../../lib/api/send";
import { resolveKeyValues } from "../../lib/api/variables";
import { apiCancelHttp, apiGrpcCall, apiGrpcDescribe, apiPickFile } from "../../lib/tauri/apiCommands";
import type { GrpcCallKind, GrpcMethodInfo, GrpcResponse, GrpcSettings, KeyValue } from "../../types/api";

/**
 * The gRPC workbench: point it at a `.proto` file or at server reflection, pick a service and a
 * method, fill in the request message, invoke.
 *
 * The one rule that shapes the response side: **a non-OK gRPC status is a response, not a
 * crash.** `NOT_FOUND` comes back through the same happy path as `OK` and is rendered like an
 * HTTP 404 would be — a status line, a message, trailers. Only a failure to *make* the call
 * (no route to host, an unparseable proto) is an error.
 */

type Translate = ReturnType<typeof useT>;

/**
 * Kinds whose request is a *batch* of messages rather than one: the editor holds a JSON array and
 * the backend sends every element before reading the replies.
 *
 * That covers client-streaming exactly, and covers bidi only in the request/response-batch sense —
 * a genuinely interactive bidi conversation, where what you send next depends on what just came
 * back, can't be expressed by a textarea. Hence the warning rather than a silent success.
 */
const BATCH_STREAMING_KINDS: GrpcCallKind[] = ["client_stream", "bidi_stream"];

/** Canonical gRPC status names — protocol constants, not UI copy, so they are not translated. */
const GRPC_STATUS_NAMES: Record<number, string> = {
  0: "OK",
  1: "CANCELLED",
  2: "UNKNOWN",
  3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED",
  5: "NOT_FOUND",
  6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED",
  8: "RESOURCE_EXHAUSTED",
  9: "FAILED_PRECONDITION",
  10: "ABORTED",
  11: "OUT_OF_RANGE",
  12: "UNIMPLEMENTED",
  13: "INTERNAL",
  14: "UNAVAILABLE",
  15: "DATA_LOSS",
  16: "UNAUTHENTICATED",
};

const INPUT =
  "w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2 py-1 text-[12px] outline-none focus:border-[var(--cf-accent)]";

export function GrpcPanel({ tabId }: { tabId: string }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);

  const tab = useApiStore((s) => s.openTabs.find((x) => x.id === tabId) ?? null);
  const collections = useApiStore((s) => s.collections);
  const environments = useApiStore((s) => s.environments);
  const activeEnvironmentId = useApiStore((s) => s.activeEnvironmentId);
  const updateDraft = useApiStore((s) => s.updateDraft);

  const services = useApiRuntimeStore((s) => s.grpcServices[tabId]);
  const setGrpcServices = useApiRuntimeStore((s) => s.setGrpcServices);
  const busy = useApiRuntimeStore((s) => s.sending[tabId] ?? false);
  const setSending = useApiRuntimeStore((s) => s.setSending);

  const [describing, setDescribing] = useState(false);
  const [response, setResponse] = useState<GrpcResponse | null>(null);
  const [callError, setCallError] = useState<string | null>(null);
  const callIdRef = useRef<string | null>(null);

  const collectionId = tab?.collectionId ?? null;
  const variableContext = useMemo(
    () => useApiStore.getState().variableContext(collectionId),
    [collectionId, collections, environments, activeEnvironmentId],
  );

  const grpc = tab?.draft.grpc;
  const patch = (next: Partial<GrpcSettings>) => {
    if (!grpc) return;
    updateDraft(tabId, { grpc: { ...grpc, ...next } });
  };

  const service = services?.find((candidate) => candidate.name === grpc?.service) ?? null;
  const method = service?.methods.find((candidate) => candidate.name === grpc?.method) ?? null;
  const kind = method ? callKindOf(method) : (grpc?.callKind ?? "unary");
  const batched = BATCH_STREAMING_KINDS.includes(kind);

  const loadServices = async () => {
    if (!tab || !grpc) return;
    setDescribing(true);
    try {
      const { endpoint, metadata, options } = await resolveTransport(tabId);
      const loaded = await apiGrpcDescribe({
        source: grpc.source,
        proto_path: grpc.protoPath,
        import_paths: grpc.importPaths,
        endpoint,
        use_tls: grpc.useTls,
        metadata,
        options,
      });
      setGrpcServices(tabId, loaded);
      // A descriptor that no longer contains the saved selection would leave the two pickers
      // showing names that resolve to nothing; land on the first service/method instead.
      const first = loaded.find((candidate) => candidate.name === grpc.service) ?? loaded[0];
      const firstMethod =
        first?.methods.find((candidate) => candidate.name === grpc.method) ?? first?.methods[0];
      patch({
        service: first?.name ?? "",
        method: firstMethod?.name ?? "",
        callKind: firstMethod ? callKindOf(firstMethod) : "unary",
      });
    } catch (e) {
      pushErrorToast(t("api.grpc.describeFailed", { error: String(e) }));
    } finally {
      setDescribing(false);
    }
  };

  const invoke = async () => {
    if (!tab || !grpc) return;
    // Held so Cancel can reach this call: the backend registers gRPC invocations under the same
    // cancellation registry as HTTP, so `api_cancel_http` aborts them by id.
    const callId = `grpc-${tabId}-${Date.now().toString(36)}`;
    callIdRef.current = callId;
    setSending(tabId, true);
    setCallError(null);
    try {
      const { endpoint, metadata, options } = await resolveTransport(tabId);
      const result = await apiGrpcCall(callId, {
        source: grpc.source,
        proto_path: grpc.protoPath,
        import_paths: grpc.importPaths,
        endpoint,
        service: grpc.service,
        method: grpc.method,
        message_json: grpc.messageJson,
        metadata,
        use_tls: grpc.useTls,
        authority: grpc.authority,
        options,
      });
      setResponse(result);
    } catch (e) {
      // Only a call that never happened lands here — a NOT_FOUND arrives as a `GrpcResponse`.
      setResponse(null);
      setCallError(t("api.grpc.callFailed", { error: String(e) }));
    } finally {
      callIdRef.current = null;
      setSending(tabId, false);
    }
  };

  const cancel = () => {
    const id = callIdRef.current;
    if (id) void apiCancelHttp(id).catch(() => undefined);
  };

  const pickProto = async () => {
    const path = await apiPickFile(["proto"]).catch((e: unknown) => {
      pushErrorToast(String(e));
      return null;
    });
    if (path) patch({ protoPath: path });
  };

  const generateExample = () => {
    if (!method) return;
    patch({ messageJson: prettyJson(method.input_example) });
  };

  if (!tab || !grpc) return <></>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 space-y-2 border-b border-[var(--cf-border)] px-3 py-2">
        <div className="flex items-end gap-2">
          <div className="w-56">
            <Field label={t("api.grpc.source")}>
              <Select
                size="sm"
                value={grpc.source}
                onChange={(value) => patch({ source: value === "proto" ? "proto" : "reflection" })}
                options={[
                  { value: "reflection", label: t("api.grpc.useReflection") },
                  { value: "proto", label: t("api.grpc.useProto") },
                ]}
              />
            </Field>
          </div>

          {grpc.source === "proto" && (
            <div className="flex min-w-0 flex-1 items-end gap-1.5">
              <div className="min-w-0 flex-1">
                <Field label={t("api.grpc.protoFile")}>
                  <input
                    value={grpc.protoPath}
                    onChange={(e) => patch({ protoPath: e.target.value })}
                    placeholder="/path/to/service.proto"
                    className={`${INPUT} font-mono`}
                  />
                </Field>
              </div>
              <button
                onClick={() => void pickProto()}
                className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-1 text-[12px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)]"
              >
                <FileCode size={13} />
                {t("api.body.chooseFile")}
              </button>
            </div>
          )}

          <div className="flex items-center gap-3 pb-1">
            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--cf-text)]">
              <Checkbox checked={grpc.useTls} onChange={(checked) => patch({ useTls: checked })} />
              {t("api.grpc.useTls")}
            </label>
          </div>

          <div className="w-48">
            <Field label={t("api.grpc.authority")}>
              <input
                value={grpc.authority}
                onChange={(e) => patch({ authority: e.target.value })}
                className={`${INPUT} font-mono`}
              />
            </Field>
          </div>
        </div>

        {grpc.source === "proto" && (
          <ImportPaths paths={grpc.importPaths} onChange={(importPaths) => patch({ importPaths })} t={t} />
        )}

        <div className="flex items-end gap-2">
          <button
            onClick={() => void loadServices()}
            disabled={describing}
            className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[12px] text-[var(--cf-text)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-50"
          >
            {describing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {t("api.grpc.loadServices")}
          </button>

          <div className="min-w-0 flex-1">
            <Field label={t("api.grpc.service")}>
              <Select
                size="sm"
                value={grpc.service}
                placeholder={t("api.grpc.service")}
                disabled={!services || services.length === 0}
                onChange={(value) => {
                  const next = services?.find((candidate) => candidate.name === value);
                  const firstMethod = next?.methods[0];
                  patch({
                    service: value,
                    method: firstMethod?.name ?? "",
                    callKind: firstMethod ? callKindOf(firstMethod) : "unary",
                  });
                }}
                options={(services ?? []).map((candidate) => ({
                  value: candidate.name,
                  label: candidate.name,
                }))}
              />
            </Field>
          </div>

          <div className="min-w-0 flex-1">
            <Field label={t("api.grpc.method")}>
              <Select
                size="sm"
                value={grpc.method}
                placeholder={t("api.grpc.method")}
                disabled={!service}
                onChange={(value) => {
                  const next = service?.methods.find((candidate) => candidate.name === value);
                  patch({ method: value, callKind: next ? callKindOf(next) : "unary" });
                }}
                options={(service?.methods ?? []).map((candidate) => ({
                  value: candidate.name,
                  label: candidate.name,
                }))}
              />
            </Field>
          </div>

          {method && <KindBadge kind={kind} t={t} />}

          <button
            onClick={() => void invoke()}
            disabled={busy || !grpc.service || !grpc.method}
            className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1 text-[12px] font-medium text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
            {t("api.grpc.invoke")}
          </button>

          {busy && (
            <button
              onClick={cancel}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2.5 py-1 text-[12px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
            >
              <X size={13} />
              {t("api.cancel")}
            </button>
          )}
        </div>

        {method && batched && (
          <p className="flex items-start gap-1.5 text-[11px] text-[var(--cf-warning)]">
            <AlertTriangle size={12} className="mt-px shrink-0" />
            {t("api.grpc.batchHint")}
          </p>
        )}
      </div>

      <div className="shrink-0 border-b border-[var(--cf-border)] px-3 py-2">
        <CollapsibleSection icon={Tags} title={t("api.tab.metadata")} defaultOpen={grpc.metadata.length > 0}>
          <KeyValueTable
            rows={grpc.metadata}
            onChange={(metadata: KeyValue[]) => patch({ metadata })}
            variableContext={variableContext}
            keyPlaceholder={t("api.key")}
            valuePlaceholder={t("api.value")}
          />
        </CollapsibleSection>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-[var(--cf-border)]">
          <div className="flex shrink-0 items-center gap-2 px-3 py-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
              {t("api.tab.message")}
            </span>
            <div className="flex-1" />
            <button
              onClick={generateExample}
              disabled={!method}
              className="flex items-center gap-1.5 rounded-md border border-[var(--cf-border)] px-2 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:border-[var(--cf-accent)] hover:text-[var(--cf-accent)] disabled:opacity-40"
            >
              <Braces size={12} />
              {t("api.grpc.generateExample")}
            </button>
          </div>
          <div className="min-h-0 flex-1">
            <Editor
              height="100%"
              language="json"
              value={grpc.messageJson}
              theme={monacoTheme}
              onChange={(value) => patch({ messageJson: value ?? "" })}
              options={{
            ...OVERFLOW_SAFE_OPTIONS,
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
                wordWrap: "on",
                automaticLayout: true,
                overviewRulerLanes: 0,
              }}
            />
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <ResponseSide response={response} error={callError} servicesLoaded={!!services} t={t} monacoTheme={monacoTheme} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

function ResponseSide({
  response,
  error,
  servicesLoaded,
  t,
  monacoTheme,
}: {
  response: GrpcResponse | null;
  error: string | null;
  servicesLoaded: boolean;
  t: Translate;
  monacoTheme: string;
}) {
  if (error) {
    return (
      <div className="flex h-full items-start gap-2 p-4 text-[12px] text-[var(--cf-danger)]">
        <AlertTriangle size={14} className="mt-px shrink-0" />
        <span className="min-w-0 break-words">{error}</span>
      </div>
    );
  }

  if (!response) {
    return (
      <EmptyState
        icon={Network}
        title={t("api.grpc.noResponse")}
        subtitle={servicesLoaded ? undefined : t("api.grpc.noServices")}
      />
    );
  }

  const ok = response.status_code === 0;
  const statusName = GRPC_STATUS_NAMES[response.status_code] ?? String(response.status_code);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
          {t("api.response.title")}
        </span>
        <span
          className="rounded px-1.5 py-px font-mono text-[11px] font-medium"
          style={{
            color: ok ? "var(--cf-success)" : "var(--cf-danger)",
            backgroundColor: ok
              ? "color-mix(in oklab, var(--cf-success) 14%, transparent)"
              : "color-mix(in oklab, var(--cf-danger) 14%, transparent)",
          }}
        >
          {response.status_code} {statusName}
        </span>
        {response.status_message && (
          <span className="min-w-0 truncate text-[11px] text-[var(--cf-text-muted)]" title={response.status_message}>
            {response.status_message}
          </span>
        )}
        <div className="flex-1" />
        <span className="shrink-0 font-mono text-[11px] text-[var(--cf-text-muted)]">
          {t("api.response.time")} {response.duration_ms} ms
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language="json"
          value={prettyJson(response.message_json)}
          theme={monacoTheme}
          options={{
            ...OVERFLOW_SAFE_OPTIONS,
            readOnly: true,
            minimap: { enabled: false },
            fontSize: 12,
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            overviewRulerLanes: 0,
          }}
        />
      </div>

      <div className="max-h-48 shrink-0 space-y-2 overflow-y-auto border-t border-[var(--cf-border)] px-3 py-2">
        <CollapsibleSection icon={Tags} title={t("api.response.headers")} defaultOpen={response.headers.length > 0}>
          <PairTable pairs={response.headers} />
        </CollapsibleSection>
        <CollapsibleSection icon={Tags} title={t("api.grpc.trailers")} defaultOpen={response.trailers.length > 0}>
          <PairTable pairs={response.trailers} />
        </CollapsibleSection>
      </div>
    </div>
  );
}

function PairTable({ pairs }: { pairs: [string, string][] }) {
  if (pairs.length === 0) return <p className="text-[11px] text-[var(--cf-text-muted)]">—</p>;
  return (
    <div className="space-y-0.5">
      {pairs.map(([key, value], index) => (
        <div key={`${key}-${index}`} className="flex gap-2 text-[11px]">
          <span className="w-40 shrink-0 truncate font-mono text-[var(--cf-text-muted)]" title={key}>
            {key}
          </span>
          <span className="min-w-0 flex-1 break-all font-mono text-[var(--cf-text)]">{value}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bits
// ---------------------------------------------------------------------------

function KindBadge({ kind, t }: { kind: GrpcCallKind; t: Translate }) {
  const label =
    kind === "unary"
      ? t("api.grpc.unary")
      : kind === "server_stream"
        ? t("api.grpc.serverStream")
        : kind === "client_stream"
          ? t("api.grpc.clientStream")
          : t("api.grpc.bidiStream");
  const batched = BATCH_STREAMING_KINDS.includes(kind);
  return (
    <span
      className={`shrink-0 self-center rounded px-1.5 py-px text-[10px] uppercase tracking-wide ${
        batched
          ? "border border-[var(--cf-border)] text-[var(--cf-text-muted)]"
          : "bg-[var(--cf-accent-soft)] text-[var(--cf-accent)]"
      }`}
    >
      {label}
    </span>
  );
}

function ImportPaths({
  paths,
  onChange,
  t,
}: {
  paths: string[];
  onChange: (paths: string[]) => void;
  t: Translate;
}) {
  return (
    <div className="space-y-1">
      <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {t("api.grpc.importPaths")}
      </span>
      {paths.map((path, index) => (
        <div key={index} className="flex items-center gap-1.5">
          <input
            value={path}
            onChange={(e) => onChange(paths.map((other, i) => (i === index ? e.target.value : other)))}
            placeholder="/path/to/protos"
            className={`${INPUT} font-mono`}
          />
          <button
            onClick={() => onChange(paths.filter((_, i) => i !== index))}
            title={t("api.removeRow")}
            className="shrink-0 rounded p-1 text-[var(--cf-text-muted)] hover:text-[var(--cf-danger)]"
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <button
        onClick={() => onChange([...paths, ""])}
        className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
      >
        <Plus size={12} />
        {t("api.grpc.addImportPath")}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">
        {label}
      </span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callKindOf(method: GrpcMethodInfo): GrpcCallKind {
  if (method.client_streaming && method.server_streaming) return "bidi_stream";
  if (method.client_streaming) return "client_stream";
  if (method.server_streaming) return "server_stream";
  return "unary";
}

/**
 * The endpoint, metadata and network options for a describe or a call.
 *
 * `resolveRequest` is reused rather than re-interpolating by hand so a gRPC endpoint honours the
 * same `{{variables}}`, proxy, timeout and mTLS settings as everything else — and so an
 * Authorization set on the request or inherited from the collection reaches the wire, which for
 * gRPC means going out as metadata.
 */
async function resolveTransport(tabId: string) {
  const store = useApiStore.getState();
  const tab = store.openTabs.find((x) => x.id === tabId);
  if (!tab) throw new Error("tab is gone");
  const ctx = store.variableContext(tab.collectionId);
  const resolved = await resolveRequest(
    tab.draft,
    ctx,
    store.authChainForTab(tabId),
    store.settings,
    store.cookies,
  );
  const metadata: [string, string][] = [
    ...resolved.headers,
    ...resolveKeyValues(tab.draft.grpc.metadata, ctx)
      .filter((row) => row.enabled && row.key.trim() !== "")
      .map((row): [string, string] => [row.key, row.value]),
  ];
  return { endpoint: resolved.url, metadata, options: resolved.options };
}

/** Formats a JSON string, and returns it untouched when it isn't JSON — a descriptor's example
 * or a streaming response is still worth showing when it can't be parsed. */
function prettyJson(text: string): string {
  if (text.trim() === "") return "";
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
