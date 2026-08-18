import { useState } from "react";
import { Download, RotateCcw } from "lucide-react";
import { ApiModal, Field, GhostButton, PrimaryButton, Row } from "../api/ApiModal";
import { Checkbox } from "../common/Checkbox";
import { Select } from "../common/Select";
import { useDiagramsStore } from "../../state/diagramsStore";
import {
  DEFAULT_EXPORT_OPTIONS,
  parseExportOptions,
  supportsOption,
  type ExportOptionKey,
  type ImageExportFormat,
  type ImageExportOptions,
} from "../../lib/diagrams/exportOptions";
import { useT } from "../../state/languageStore";

/**
 * What the picture should look like, asked once, before the file dialog.
 *
 * # Why this exists at all, when draw.io ships one
 *
 * The editor's own "Image" dialog is `EditorUi` code, inside the iframe: it wears draw.io's chrome,
 * speaks draw.io's language rather than the app's, and — the part that settles it — finishes by
 * downloading the file itself, which is not how anything else in this app writes to disk. So the
 * questions are asked out here, in this app's own dialog, and the answers travel to the frame as
 * an ordinary `export` message. See `exportOptions.ts` for what the frame actually honours.
 *
 * # Why unavailable rows are greyed out instead of removed
 *
 * Two of these rows are PNG-only and one is SVG/PDF-only, so a dialog that rendered only what
 * applied would change height and content between formats. Two consequences, both bad: the buttons
 * move under the pointer, and — worse — a user who exported a PNG with a grid and then chose SVG
 * would find the grid row simply gone and conclude they had imagined it. Disabled, with the reason
 * beside it, says both "this exists" and "not here".
 *
 * There is deliberately no DPI field and no pixel-width field, however much the draw.io dialog has
 * them. The reasons are in `exportOptions.ts`: the vendored embed reads neither on this path, and a
 * control that changes nothing is a worse answer than an absent one.
 *
 * The `format` prop is `ImageExportFormat`, not `ExportFormat`, and that is the guard that stops
 * this ever opening for `.drawio` — a format with no picture to have options about.
 */
export function ExportImageModal({
  format,
  onClose,
}: {
  format: ImageExportFormat;
  onClose: () => void;
}) {
  const t = useT();
  const setExportOptions = useDiagramsStore((s) => s.setExportOptions);
  const requestExport = useDiagramsStore((s) => s.requestExport);

  /**
   * A copy of the remembered options, taken once — read with `getState()` rather than subscribed
   * to, because nothing outside this dialog changes them while it is up, and a subscription would
   * mean the panel re-rendering itself out from under a half-typed field on its own confirm.
   *
   * **The two numbers are held as strings.** A controlled `<input type="number">` that reparses on
   * every keystroke cannot be emptied: clearing "200" to type "150" produces `""`, which parses to
   * `NaN` or, worse, to `0`, and the field snaps back before the second digit arrives. They are
   * kept exactly as typed and normalised once, on confirm, by the same `parseExportOptions` that
   * filters what comes out of the database — so a keyed value and a stored value are subject to
   * the identical clamp.
   */
  const [draft, setDraft] = useState(() => useDiagramsStore.getState().exportOptions);
  const [zoom, setZoom] = useState(() => String(useDiagramsStore.getState().exportOptions.zoom));
  const [border, setBorder] = useState(() =>
    String(useDiagramsStore.getState().exportOptions.border),
  );

  const set = <K extends keyof ImageExportOptions>(key: K, value: ImageExportOptions[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /** The reason a row is off, or `undefined` when it is on and the row shows its own hint. */
  const unavailable = (option: ExportOptionKey): string | undefined =>
    supportsOption(format, option)
      ? undefined
      : option === "appearance"
        ? t("diagrams.exportOptions.onlyVector")
        : t("diagrams.exportOptions.onlyPng");

  const off = (option: ExportOptionKey) => !supportsOption(format, option);

  const restore = () => {
    setDraft(DEFAULT_EXPORT_OPTIONS);
    setZoom(String(DEFAULT_EXPORT_OPTIONS.zoom));
    setBorder(String(DEFAULT_EXPORT_OPTIONS.border));
  };

  /**
   * Remember, then ask.
   *
   * The write happens here and not on every keystroke, because what is worth remembering is the
   * choice that was *used* — not the 900 % somebody typed while thinking about it and then
   * cancelled out of.
   */
  const confirm = () => {
    const next = parseExportOptions(JSON.stringify({ ...draft, zoom, border }));
    setExportOptions(next);
    requestExport({ format, options: next });
    onClose();
  };

  return (
    <ApiModal
      icon={Download}
      title={t("diagrams.exportOptions.title")}
      subtitle={t("diagrams.exportOptions.subtitle", { format: format.toUpperCase() })}
      width="max-w-md"
      // The body is a form the user has been typing into, so a press that starts inside a field and
      // is released past the panel's edge must not be read as "clicked away". Escape, Cancel and
      // the close button remain the exits — and Escape is already ApiModal's, so nothing here adds
      // a second listener for it.
      dismissOnBackdrop={false}
      onClose={onClose}
      footer={
        <>
          <GhostButton onClick={restore}>
            <RotateCcw size={12} />
            {t("diagrams.exportOptions.reset")}
          </GhostButton>
          <div className="flex-1" />
          <GhostButton onClick={onClose}>{t("common.cancel")}</GhostButton>
          <PrimaryButton onClick={confirm}>
            <Download size={12} />
            {t("diagrams.exportOptions.confirm")}
          </PrimaryButton>
        </>
      }
    >
      {/* `ApiModal`'s body brings no padding of its own — the house body is the header's `px-4`
          with room to breathe, scrolling rather than clipping on a short window. */}
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-4 py-3">
        <Row label={t("diagrams.exportOptions.zoom")} hint={t("diagrams.exportOptions.zoomHint")}>
          <Field type="number" value={zoom} onChange={setZoom} />
        </Row>
        <Row
          label={t("diagrams.exportOptions.border")}
          hint={t("diagrams.exportOptions.borderHint")}
        >
          <Field type="number" value={border} onChange={setBorder} />
        </Row>
        <Row label={t("diagrams.exportOptions.transparent")} hint={unavailable("transparent")}>
          <Checkbox
            checked={draft.transparent}
            disabled={off("transparent")}
            onChange={(on) => set("transparent", on)}
          />
        </Row>
        <Row label={t("diagrams.exportOptions.shadow")} hint={unavailable("shadow")}>
          <Checkbox
            checked={draft.shadow}
            disabled={off("shadow")}
            onChange={(on) => set("shadow", on)}
          />
        </Row>
        <Row label={t("diagrams.exportOptions.grid")} hint={unavailable("grid")}>
          <Checkbox
            checked={draft.grid}
            disabled={off("grid")}
            onChange={(on) => set("grid", on)}
          />
        </Row>
        <Row label={t("diagrams.exportOptions.size")} hint={unavailable("size")}>
          <Select
            size="field"
            value={draft.size}
            disabled={off("size")}
            onChange={(value) => set("size", value === "page" ? "page" : "diagram")}
            options={[
              { value: "diagram", label: t("diagrams.exportOptions.sizeDiagram") },
              { value: "page", label: t("diagrams.exportOptions.sizePage") },
            ]}
          />
        </Row>
        <Row label={t("diagrams.exportOptions.appearance")} hint={unavailable("appearance")}>
          <Select
            size="field"
            value={draft.appearance}
            disabled={off("appearance")}
            onChange={(value) =>
              set("appearance", value === "light" || value === "dark" ? value : "auto")
            }
            options={[
              { value: "auto", label: t("diagrams.exportOptions.appearanceAuto") },
              { value: "light", label: t("diagrams.exportOptions.appearanceLight") },
              { value: "dark", label: t("diagrams.exportOptions.appearanceDark") },
            ]}
          />
        </Row>
      </div>
    </ApiModal>
  );
}
