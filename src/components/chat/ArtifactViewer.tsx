import { useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import DOMPurify from "dompurify";
import { Check, Code2, Copy, Download, Eye, FileCode2, FileText, FolderGit2, Globe, Image as ImageIcon, Workflow, type LucideIcon } from "lucide-react";
import { ApiModal, GhostButton } from "../api/ApiModal";
import { Select } from "../common/Select";
import { Markdown } from "../common/Markdown";
import { artifactFileName, type ArtifactKind, type ChatArtifactBlock } from "../../lib/chatArtifacts";
import { chatArtifactVersions, type ChatArtifact } from "../../lib/tauri/chatRefsCommands";
import { writeFileBytes } from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";
import { pushErrorToast } from "../../state/toastStore";
import { useWorkspaceStore } from "../../state/workspaceStore";

export function artifactIcon(kind: ArtifactKind | string): LucideIcon {
  switch (kind) {
    case "html":
      return Globe;
    case "markdown":
      return FileText;
    case "mermaid":
      return Workflow;
    case "svg":
      return ImageIcon;
    default:
      return FileCode2;
  }
}

/** The CSP an artifact page runs under: nothing from the network, ever; scripts only when allowed. */
function framed(html: string, scripts: boolean): string {
  const policy = `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:;${scripts ? " script-src 'unsafe-inline';" : ""}`;
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">${html}`;
}

function MermaidView({ source }: { source: string }) {
  const t = useT();
  const dark = useThemeStore((s) => s.resolved) === "dark";
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    void import("../../lib/diagrams/mermaidRuntime")
      .then(({ renderMermaid }) => renderMermaid(source, dark))
      .then((out) => alive && setSvg(DOMPurify.sanitize(out, { USE_PROFILES: { svg: true, svgFilters: true } })))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [source, dark]);
  if (failed) return <p className="text-[12px] text-[var(--cf-danger)]">{t("chat.diagramFailed")}</p>;
  return svg ? <div className="cf-chat-diagram flex justify-center" dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="text-[12px] text-[var(--cf-text-muted)]">…</p>;
}

function Preview({ kind, content, scripts }: { kind: ArtifactKind; content: string; scripts: boolean }) {
  if (kind === "html" || kind === "svg") {
    return (
      <iframe
        title="artifact"
        // No same-origin ever: the page cannot reach the app. Scripts only when the user allowed them.
        sandbox={kind === "html" && scripts ? "allow-scripts" : ""}
        referrerPolicy="no-referrer"
        srcDoc={framed(content, kind === "html" && scripts)}
        className="h-full min-h-[60vh] w-full rounded-lg border border-[var(--cf-border)] bg-white"
      />
    );
  }
  if (kind === "markdown") return <Markdown source={content} className="cf-markdown-preview" />;
  if (kind === "mermaid") return <MermaidView source={content} />;
  return <Code content={content} />;
}

function Code({ content }: { content: string }) {
  return (
    <pre className="overflow-auto rounded-lg border border-[var(--cf-border)] bg-[var(--cf-surface-sunken,var(--cf-surface))] p-3 font-mono text-[12px] leading-relaxed text-[var(--cf-text)]">
      {content}
    </pre>
  );
}

/**
 * One artifact, full size: drawn by kind (a page in a sealed frame, a document, a diagram, code),
 * with its source, its versions, copy, download and save into the chat's repository.
 *
 * `block` is the version the bubble holds — drawn at once, before (or without) the stored ones.
 */
export function ArtifactViewer({
  workspaceId,
  name,
  block,
  projectId,
  onClose,
}: {
  workspaceId: string | null;
  name: string;
  block?: ChatArtifactBlock | null;
  /** The chat's repository, for «Guardar en el repositorio». */
  projectId?: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const [versions, setVersions] = useState<ChatArtifact[]>([]);
  const [picked, setPicked] = useState<number | null>(null);
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [scripts, setScripts] = useState(false);
  const [copied, setCopied] = useState(false);
  const repoPath = useWorkspaceStore((s) => {
    if (!projectId) return null;
    for (const list of Object.values(s.projectsByWorkspace)) {
      const found = list.find((p) => p.id === projectId);
      if (found) return found.local_path;
    }
    return null;
  });

  useEffect(() => {
    if (!workspaceId) return;
    let alive = true;
    void chatArtifactVersions(workspaceId, name)
      .then((list) => {
        if (!alive) return;
        setVersions(list);
        const same = block ? list.find((v) => v.content === block.content) : null;
        setPicked(same?.version ?? list[0]?.version ?? null);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [workspaceId, name, block]);

  const current = useMemo<ChatArtifactBlock | null>(() => {
    const stored = versions.find((v) => v.version === picked);
    if (stored) return { name: stored.name, title: stored.title, kind: stored.kind, language: stored.language, content: stored.content };
    return block ?? null;
  }, [versions, picked, block]);

  if (!current) return null;
  const Icon = artifactIcon(current.kind);
  const fileName = artifactFileName(current);
  const previewable = current.kind !== "code";

  const save = async (inRepo: boolean) => {
    try {
      const path = await saveDialog({ defaultPath: inRepo && repoPath ? `${repoPath.replace(/[\\/]+$/, "")}/${fileName}` : fileName });
      if (!path) return;
      await writeFileBytes(path, new TextEncoder().encode(current.content));
    } catch (e) {
      pushErrorToast(String(e));
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(current.content).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => pushErrorToast(t("chat.copyFailed")),
    );
  };

  return (
    <ApiModal
      icon={Icon}
      title={current.title || current.name}
      subtitle={`${current.name} · ${t(`artifact.kind.${current.kind}` as never)}${current.language ? ` · ${current.language}` : ""}`}
      width="max-w-5xl"
      onClose={onClose}
      toolbar={
        <div className="flex flex-wrap items-center gap-1.5">
          {previewable && (
            <div className="flex rounded-md border border-[var(--cf-border)] p-0.5">
              {(["preview", "code"] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  onClick={() => setTab(x)}
                  className={`flex h-6 items-center gap-1 rounded px-2 text-[11.5px] ${tab === x ? "bg-[var(--cf-hover)] text-[var(--cf-text)]" : "text-[var(--cf-text-muted)]"}`}
                >
                  {x === "preview" ? <Eye size={12} /> : <Code2 size={12} />}
                  {t(x === "preview" ? "artifact.preview" : "artifact.source")}
                </button>
              ))}
            </div>
          )}
          {current.kind === "html" && tab === "preview" && (
            <label className="flex items-center gap-1 text-[11.5px] text-[var(--cf-text-muted)]" title={t("artifact.scriptsHint")}>
              <input type="checkbox" checked={scripts} onChange={(e) => setScripts(e.target.checked)} />
              {t("artifact.scripts")}
            </label>
          )}
          {versions.length > 1 && picked !== null && (
            <div className="w-28">
              <Select
                size="sm"
                value={String(picked)}
                onChange={(v) => setPicked(Number(v))}
                ariaLabel={t("artifact.version")}
                options={versions.map((v) => ({ value: String(v.version), label: t("artifact.versionN", { n: String(v.version) }) }))}
              />
            </div>
          )}
        </div>
      }
      footer={
        <>
          <GhostButton onClick={copy}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {t("artifact.copy")}
          </GhostButton>
          <GhostButton onClick={() => void save(false)}>
            <Download size={13} />
            {t("artifact.download")}
          </GhostButton>
          {repoPath && (
            <GhostButton onClick={() => void save(true)}>
              <FolderGit2 size={13} />
              {t("artifact.saveInRepo")}
            </GhostButton>
          )}
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {previewable && tab === "preview" ? <Preview kind={current.kind} content={current.content} scripts={scripts} /> : <Code content={current.content} />}
      </div>
    </ApiModal>
  );
}
