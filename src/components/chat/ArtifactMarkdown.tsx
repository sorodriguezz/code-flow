import { useEffect, useState } from "react";
import { renderArtifactMarkdown } from "../../lib/artifactMarkdown";
import { useT } from "../../state/languageStore";
import { useThemeStore } from "../../state/themeStore";

const DARK_THEME = "dark";
const FAILURE_LABEL = "artifact.diagramFailed";
const LOADING_LABEL = "editor.loading";
const PREVIEW_CLASS = "cf-markdown-preview min-w-0 max-w-full select-text overflow-x-auto";
const STATUS_CLASS = "text-[12px] text-[var(--cf-text-muted)]";
const FAILURE_CLASS = "text-[12px] text-[var(--cf-danger)]";
const STATUS_ROLE = "status";
const FAILURE_ROLE = "alert";

interface RenderedDocument {
  source: string;
  dark: boolean;
  failureLabel: string;
  html: string | null;
}

export function ArtifactMarkdown({ source }: { source: string }) {
  const t = useT();
  const theme = useThemeStore((state) => state.resolved);
  const dark = theme === DARK_THEME;
  const failureLabel = t(FAILURE_LABEL);
  const loadingLabel = t(LOADING_LABEL);
  const [rendered, setRendered] = useState<RenderedDocument | null>(null);

  useEffect(() => {
    let active = true;
    const render = async () => {
      let html: string | null = null;
      try {
        html = await renderArtifactMarkdown(source, dark, failureLabel);
      } catch {
        html = null;
      }
      if (!active) return;
      setRendered({ source, dark, failureLabel, html });
    };
    void render();
    return () => {
      active = false;
    };
  }, [source, dark, failureLabel]);

  const current = rendered?.source === source && rendered.dark === dark && rendered.failureLabel === failureLabel;
  if (!current) return <p className={STATUS_CLASS} role={STATUS_ROLE}>{loadingLabel}</p>;
  if (rendered.html === null) return <p className={FAILURE_CLASS} role={FAILURE_ROLE}>{failureLabel}</p>;
  return <div className={PREVIEW_CLASS} dangerouslySetInnerHTML={{ __html: rendered.html }} />;
}
