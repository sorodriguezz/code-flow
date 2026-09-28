import { memo, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";
import { isJsonObject, JsonNumber, type JsonObject, type JsonValue } from "../../../lib/notebook/json";
import { textOf } from "../../../lib/notebook/nbformat";
import { chooseMime, clipLines, fixOverwrites, imageSrc, outputText } from "../../../lib/notebook/outputs";
import { ansiToHtml } from "../../../lib/notebook/ansi";
import { renderMarkdown } from "../../../lib/markdown";
import { pushErrorToast } from "../../../state/toastStore";
import { useT } from "../../../state/languageStore";
import { Tooltip } from "../../common/Tooltip";
import { iconButtonClass } from "../../common/Button";
import { HtmlOutput, type OutputPalette } from "./HtmlOutput";

/**
 * A code cell's outputs, as Jupyter draws them: streams as text (stderr tinted), rich results by
 * the first representation this app can show (`chooseMime`), errors as their traceback in colour.
 *
 * Everything drawn here is text the user can select and copy — the page is `user-select: none`
 * by default, so the area opts back in — and each output has a copy button for its plain text.
 */
export const CellOutputs = memo(function CellOutputs({
  outputs,
  palette,
  onOpenLink,
}: {
  outputs: JsonObject[];
  palette: OutputPalette;
  onOpenLink: (href: string) => void;
}) {
  if (outputs.length === 0) return null;
  return (
    <div className="nb-outputs select-text space-y-1 px-2 py-1.5">
      {outputs.map((output, index) => (
        <OutputItem key={index} output={output} palette={palette} onOpenLink={onOpenLink} />
      ))}
    </div>
  );
});

function OutputItem({
  output,
  palette,
  onOpenLink,
}: {
  output: JsonObject;
  palette: OutputPalette;
  onOpenLink: (href: string) => void;
}) {
  const t = useT();
  const copy = () => {
    void navigator.clipboard.writeText(outputText(output)).catch((e) => pushErrorToast(String(e)));
  };
  const body = (() => {
    switch (output.output_type) {
      case "stream": {
        // Carriage returns applied for display too: a file written elsewhere can hold a progress
        // bar's every frame, and a pending `\r` at the end is not a line.
        const text = fixOverwrites(textOf(output.text)).replace(/\r$/, "");
        return <TextBlock text={text} tone={output.name === "stderr" ? "stderr" : "plain"} />;
      }
      case "error": {
        const trace = Array.isArray(output.traceback) ? output.traceback.map((line) => textOf(line)).join("\n") : "";
        return <TextBlock text={trace || `${textOf(output.ename)}: ${textOf(output.evalue)}`} tone="error" />;
      }
      case "execute_result":
      case "display_data":
        return <RichOutput output={output} palette={palette} onOpenLink={onOpenLink} />;
      default:
        return null;
    }
  })();
  if (!body) return null;
  return (
    <div className="group/output relative">
      {body}
      <span className="absolute right-0 top-0 opacity-0 transition-opacity group-hover/output:opacity-100">
        <Tooltip side="left" label={t("notebook.copyOutput")}>
          <button onClick={copy} aria-label={t("notebook.copyOutput")} className={iconButtonClass({ size: "xs" })}>
            <Copy size={11} />
          </button>
        </Tooltip>
      </span>
    </div>
  );
}

/** Kernel text, colours and all, cut to its head and tail when it runs to thousands of lines. */
function TextBlock({ text, tone }: { text: string; tone: "plain" | "stderr" | "error" }) {
  const t = useT();
  const [whole, setWhole] = useState(false);
  const clipped = useMemo(() => (whole ? null : clipLines(text)), [text, whole]);
  // Escaped before a single tag is added — see `ansiToHtml`. Memoised: a long log is re-read only
  // when it changes, not whenever the cell around it renders.
  const html = useMemo(
    () => (clipped ? { head: ansiToHtml(clipped.head), tail: ansiToHtml(clipped.tail) } : { head: ansiToHtml(text), tail: "" }),
    [clipped, text],
  );
  const toneClass =
    tone === "error"
      ? "rounded-md bg-[color-mix(in_oklab,var(--cf-danger)_8%,transparent)] px-2 py-1"
      : tone === "stderr"
        ? "rounded-md bg-[color-mix(in_oklab,var(--cf-warning)_8%,transparent)] px-2 py-1"
        : "";
  const pre = (markup: string) => (
    <pre
      className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.45] text-[var(--cf-text)]"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
  if (!clipped) return <div className={toneClass}>{pre(html.head)}</div>;
  return (
    <div className={toneClass}>
      {pre(html.head)}
      <button
        onClick={() => setWhole(true)}
        className="my-1 rounded-md border border-dashed border-[var(--cf-border)] px-2 py-0.5 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
      >
        {clipped.hiddenLines > 0 ? t("notebook.showAllLines", { n: clipped.hiddenLines }) : t("notebook.showAll")}
      </button>
      {pre(html.tail)}
    </div>
  );
}

function RichOutput({
  output,
  palette,
  onOpenLink,
}: {
  output: JsonObject;
  palette: OutputPalette;
  onOpenLink: (href: string) => void;
}) {
  const t = useT();
  const data = isJsonObject(output.data) ? output.data : {};
  const metadata = isJsonObject(output.metadata) ? output.metadata : {};
  const choice = chooseMime(data);
  const note = choice.needsJs ? (
    <p className="text-[11px] italic text-[var(--cf-text-muted)]">{t("notebook.needsJavaScript")}</p>
  ) : null;
  if (!choice.mime) {
    return (
      note ?? (
        <p className="text-[11px] italic text-[var(--cf-text-muted)]">
          {t("notebook.unsupportedOutput", { types: choice.available.join(", ") || "—" })}
        </p>
      )
    );
  }
  const value = data[choice.mime];
  const rendered = (() => {
    switch (choice.mime) {
      case "image/png":
      case "image/jpeg":
      case "image/gif":
      case "image/svg+xml": {
        const size = isJsonObject(metadata[choice.mime]) ? (metadata[choice.mime] as JsonObject) : {};
        const width = typeof size.width === "number" ? size.width : undefined;
        const height = typeof size.height === "number" ? size.height : undefined;
        // An `<img>`, SVG included: an image element runs nothing inside the file it shows.
        return (
          <img
            alt=""
            src={imageSrc(choice.mime, value)}
            width={width}
            height={height}
            className="max-w-full rounded-sm bg-white/0"
            draggable={false}
          />
        );
      }
      case "text/html":
        return <HtmlOutput html={textOf(value)} palette={palette} />;
      case "text/markdown":
        return <MarkdownBlock source={textOf(value)} onOpenLink={onOpenLink} />;
      case "application/json":
        return (
          <div className="font-mono text-[12px] leading-[1.5]">
            <JsonNode value={value} depth={0} expanded={isJsonObject(metadata["application/json"]) ? (metadata["application/json"] as JsonObject).expanded !== false : true} />
          </div>
        );
      case "text/latex":
        return (
          <pre className="m-0 whitespace-pre-wrap font-mono text-[12px] text-[var(--cf-text)]">{textOf(value)}</pre>
        );
      case "text/plain":
      default:
        return <TextBlock text={textOf(value)} tone="plain" />;
    }
  })();
  return (
    <>
      {note}
      {rendered}
    </>
  );
}

export function MarkdownBlock({ source, onOpenLink, className = "" }: { source: string; onOpenLink: (href: string) => void; className?: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return (
    <div
      className={`cf-markdown-preview ${className}`}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        // A link inside the page would navigate the app itself away.
        event.preventDefault();
        const href = anchor.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) onOpenLink(href);
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** `application/json`, as a tree whose objects and arrays fold. */
function JsonNode({ value, depth, expanded }: { value: JsonValue; depth: number; expanded: boolean }) {
  const [open, setOpen] = useState(expanded && depth < 2);
  if (value === null) return <span className="text-[var(--cf-text-muted)]">null</span>;
  if (value instanceof JsonNumber || typeof value === "number") {
    return <span className="text-[var(--cf-blue)]">{String(value)}</span>;
  }
  if (typeof value === "boolean") return <span className="text-[var(--cf-violet)]">{String(value)}</span>;
  if (typeof value === "string") return <span className="text-[var(--cf-success)]">{JSON.stringify(value)}</span>;
  const entries: [string, JsonValue][] = Array.isArray(value)
    ? value.map((item, i) => [String(i), item])
    : Object.entries(value);
  const [openMark, closeMark] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  if (entries.length === 0) return <span>{`${openMark}${closeMark}`}</span>;
  return (
    <span>
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center text-[var(--cf-text-muted)] hover:text-[var(--cf-text)]"
        aria-expanded={open}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {openMark}
        {!open && <span className="px-1">… {entries.length}</span>}
        {!open && closeMark}
      </button>
      {open && (
        <>
          <div className="pl-4">
            {entries.map(([key, item]) => (
              <div key={key}>
                {!Array.isArray(value) && <span className="text-[var(--cf-text)]">{JSON.stringify(key)}: </span>}
                <JsonNode value={item} depth={depth + 1} expanded={expanded} />
              </div>
            ))}
          </div>
          <span className="text-[var(--cf-text-muted)]">{closeMark}</span>
        </>
      )}
    </span>
  );
}
