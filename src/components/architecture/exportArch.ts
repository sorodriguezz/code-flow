/**
 * Exports: the same scene the canvas draws, rendered on the fixed light (or dark) palette so the
 * file looks the same wherever it is opened — SVG (optionally with the flow, notes and legend to the
 * right, as an architecture sheet), PNG at twice the size, vector PDF, and the document itself.
 */
import { saveBytes, safeFileName } from "../../lib/diagrams/exportFile";
import { renderSvg, LIGHT_PALETTE, DARK_PALETTE, type PanelLabels } from "../../lib/architecture/svg";
import type { Scene } from "../../lib/architecture/layout";
import type { ArchDoc, Category } from "../../lib/architecture/types";
import type { TranslationKey } from "../../lib/i18n/translations";
import { translate } from "../../state/languageStore";
import { pushErrorToast, pushSuccessToast } from "../../state/toastStore";

export type ArchExport = "svg" | "svgSheet" | "png" | "pdf" | "json";

const CATEGORIES: Category[] = ["actor", "compute", "data", "messaging", "network", "identity", "security", "observability", "external"];

export function panelLabels(): PanelLabels {
  return {
    flow: translate("arch.tab.flow"),
    notes: translate("arch.tab.notes"),
    legend: translate("arch.tab.legend"),
    sync: translate("arch.legend.sync"),
    async: translate("arch.legend.async"),
    step: translate("arch.legend.step"),
    own: translate("arch.legend.own"),
    shared: translate("arch.legend.shared"),
    note: translate("arch.legend.note"),
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, translate(`arch.cat.${c}` as TranslationKey)])) as Record<Category, string>,
  };
}

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function svgToPng(svg: string, background: string): Promise<Uint8Array> {
  const image = new Image();
  image.src = `data:image/svg+xml;base64,${base64(svg)}`;
  await image.decode();
  const scale = Math.min(2, Math.sqrt(40e6 / Math.max(1, image.naturalWidth * image.naturalHeight)));
  const width = Math.max(1, Math.ceil(image.naturalWidth * scale));
  const height = Math.max(1, Math.ceil(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas unavailable");
  context.fillStyle = background;
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("PNG export failed");
  return new Uint8Array(await blob.arrayBuffer());
}

export async function exportArchitecture(kind: ArchExport, args: { scene: Scene; doc: ArchDoc; text: string; title: string; dark?: boolean }): Promise<void> {
  const palette = args.dark ? DARK_PALETTE : LIGHT_PALETTE;
  const name = safeFileName(args.title, "architecture");
  const sheet = (withPanels: boolean) =>
    renderSvg(args.scene, { palette, missingLabel: translate("arch.missing"), panels: withPanels ? { doc: args.doc, labels: panelLabels() } : null, background: true });
  try {
    let saved = false;
    if (kind === "json") saved = await saveBytes(new TextEncoder().encode(args.text), "arch", `${name}.arch.json`);
    else if (kind === "svg" || kind === "svgSheet") saved = await saveBytes(new TextEncoder().encode(sheet(kind === "svgSheet")), "svg", name);
    else if (kind === "png") saved = await saveBytes(await svgToPng(sheet(true), palette.canvas), "png", name);
    else {
      const { svgToPdf } = await import("../../lib/diagrams/pdf");
      saved = await saveBytes(await svgToPdf(sheet(true)), "pdf", name);
    }
    if (saved) pushSuccessToast(translate("arch.exported"));
  } catch (error) {
    pushErrorToast(String(error));
  }
}
