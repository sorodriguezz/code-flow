import { useMemo, useState } from "react";
import { FileText, Loader2, ShieldCheck } from "lucide-react";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { ApiModal, GhostButton, PrimaryButton } from "./ApiModal";
import { useApiStore } from "../../state/apiStore";
import { pushErrorToast, useToastStore } from "../../state/toastStore";
import { useT } from "../../state/languageStore";
import { buildDocDocument, docFileStem } from "../../lib/api/docs";
import { renderDocMarkdown } from "../../lib/api/docsMarkdown";
import { renderDocHtml } from "../../lib/api/docsHtml";
import { apiSaveBinaryFile, apiSaveFile } from "../../lib/tauri/apiCommands";

type Format = "markdown" | "html" | "pdf";

const EXTENSION: Record<Format, string> = { markdown: "md", html: "html", pdf: "pdf" };

/**
 * "Generate documentation" — the collection written for a person rather than for another tool.
 *
 * Separate from `ExportModal` because the two answer different questions. Export asks which *tool*
 * is going to read the file, and every option there round-trips into one. This asks who is going to
 * read it and on what: a repository, a browser, or an email attachment for somebody who has neither.
 * Folding the six into one picker would put "Postman Collection v2.1" next to "PDF" as if they were
 * alternatives to each other.
 *
 * The document is built as soon as the dialog opens, which is what lets it show the counts and the
 * undocumented warning before anything is written. Only the *rendering* is deferred to Save, and
 * only the PDF one costs anything — it pulls pdfmake over an `import()` at that moment.
 */
export function DocsModal({ collectionId, onClose }: { collectionId: string; onClose: () => void }) {
  const t = useT();
  const collection = useApiStore((s) => s.collections.find((c) => c.id === collectionId) ?? null);
  const folders = useApiStore((s) => s.folders);
  const requests = useApiStore((s) => s.requests);
  const pushToast = useToastStore((s) => s.pushToast);

  const [format, setFormat] = useState<Format>("html");
  const [includeExamples, setIncludeExamples] = useState(true);
  const [saving, setSaving] = useState(false);

  const doc = useMemo(
    () =>
      collection
        ? buildDocDocument(collection, folders, requests, { includeSecrets: false, includeExamples })
        : null,
    [collection, folders, requests, includeExamples],
  );

  const hint =
    format === "markdown"
      ? t("api.docs.formatMarkdownHint")
      : format === "html"
        ? t("api.docs.formatHtmlHint")
        : t("api.docs.formatPdfHint");

  const save = async () => {
    if (!doc) return;
    setSaving(true);
    try {
      const name = `${docFileStem(doc.title)}.${EXTENSION[format]}`;
      let path: string | null;
      if (format === "pdf") {
        // Imported here rather than at the top of the file: pdfmake and its fonts are ~2 MB, and
        // this is the only thing in the app that needs them.
        const { renderDocPdf } = await import("../../lib/api/docsPdf");
        path = await apiSaveBinaryFile(name, await renderDocPdf(doc));
      } else {
        const text = format === "markdown" ? renderDocMarkdown(doc) : renderDocHtml(doc);
        path = await apiSaveFile(name, text);
      }
      if (path) {
        pushToast(t("api.docs.done", { path }), "success");
        onClose();
      }
    } catch (e) {
      pushErrorToast(t("api.docs.failed", { error: String(e) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ApiModal
      icon={FileText}
      title={t("api.docs.generate")}
      subtitle={collection?.name}
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={onClose} disabled={saving}>
            {t("common.cancel")}
          </GhostButton>
          <span className="ml-auto" />
          <PrimaryButton onClick={() => void save()} disabled={saving || !doc}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
            {t("common.save")}
          </PrimaryButton>
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <label className="mb-1 block text-[11px] font-medium text-[var(--cf-text-muted)]">
          {t("api.export.format")}
        </label>
        <Select
          value={format}
          onChange={(value) => setFormat(value as Format)}
          ariaLabel={t("api.export.format")}
          options={[
            { value: "markdown", label: t("api.docs.formatMarkdown") },
            { value: "html", label: t("api.docs.formatHtml") },
            { value: "pdf", label: t("api.docs.formatPdf") },
          ]}
        />
        <p className="mt-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">{hint}</p>

        <label className="mt-4 flex cursor-pointer items-start gap-2">
          <Checkbox checked={includeExamples} onChange={setIncludeExamples} className="mt-[1px]" />
          <span className="min-w-0">
            <span className="block text-[12px] text-[var(--cf-text)]">
              {t("api.docs.includeExamples")}
            </span>
            <span className="block text-[11px] leading-snug text-[var(--cf-text-muted)]">
              {t("api.docs.includeExamplesHint")}
            </span>
          </span>
        </label>

        {doc && (
          <div className="mt-4 rounded-md border border-[var(--cf-border)] px-3 py-2.5">
            <p className="text-[12px] text-[var(--cf-text)]">
              {doc.counts.requests} {doc.labels.requests} · {doc.counts.folders} {doc.labels.folders}
            </p>
            {/* Named rather than merely counted: an endpoint with no description is the one thing
                the generator cannot paper over, and it is far cheaper to fix before sending the
                file than to explain afterwards. */}
            {doc.counts.undocumented > 0 && (
              <p className="mt-1 text-[11px] leading-snug text-[var(--cf-warning)]">
                {t("api.docs.undocumentedWarning", {
                  count: doc.counts.undocumented,
                  total: doc.counts.requests,
                })}
              </p>
            )}
          </div>
        )}

        <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-snug text-[var(--cf-text-muted)]">
          <ShieldCheck size={12} className="mt-[2px] shrink-0 text-[var(--cf-success)]" />
          {t("api.docs.credentialsNote")}
        </p>
      </div>
    </ApiModal>
  );
}
