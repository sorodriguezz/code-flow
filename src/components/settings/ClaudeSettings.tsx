import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, RotateCcw, X } from "lucide-react";
import {
  defaultAnalyzeTemplate,
  defaultCommitTemplate,
  defaultReviewTemplate,
  getSetting,
  setSetting,
} from "../../lib/tauri/commands";
import { useT } from "../../state/languageStore";
import type { TranslationKey } from "../../lib/i18n/translations";
import { Checkbox } from "../common/Checkbox";

const KEYS = {
  binary: "claude_binary_path",
  model: "claude_model",
  tools: "claude_allowed_tools",
  commitTemplate: "claude_commit_template",
  reviewTemplate: "claude_review_template",
  analyzeTemplate: "claude_analyze_template",
};

const CUSTOM_MODEL = "__custom__";

const MODEL_OPTIONS: { id: string; labelKey?: TranslationKey; label?: string }[] = [
  { id: "", labelKey: "settings.modelDefault" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
  { id: "claude-fable-5", label: "Fable 5" },
  { id: CUSTOM_MODEL, labelKey: "settings.modelCustom" },
];

interface ToolOption {
  id: string;
  descriptionKey: TranslationKey;
  recommended?: boolean;
}

const TOOL_OPTIONS: ToolOption[] = [
  { id: "Read", descriptionKey: "settings.toolReadDesc", recommended: true },
  { id: "Grep", descriptionKey: "settings.toolGrepDesc", recommended: true },
  { id: "Glob", descriptionKey: "settings.toolGlobDesc", recommended: true },
  { id: "WebFetch", descriptionKey: "settings.toolWebFetchDesc" },
  { id: "WebSearch", descriptionKey: "settings.toolWebSearchDesc" },
  { id: "Bash", descriptionKey: "settings.toolBashDesc" },
  { id: "Edit", descriptionKey: "settings.toolEditDesc" },
  { id: "Write", descriptionKey: "settings.toolWriteDesc" },
  { id: "NotebookEdit", descriptionKey: "settings.toolNotebookEditDesc" },
];

const KNOWN_TOOL_IDS = new Set(TOOL_OPTIONS.map((t) => t.id));
const DEFAULT_TOOLS = TOOL_OPTIONS.filter((t) => t.recommended).map((t) => t.id);

export function ClaudeSettings() {
  const t = useT();
  const [binaryPath, setBinaryPath] = useState("claude");
  const [modelChoice, setModelChoice] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [tools, setTools] = useState<string[]>(DEFAULT_TOOLS);
  const [customTool, setCustomTool] = useState("");
  const [commitTemplate, setCommitTemplate] = useState("");
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [reviewTemplate, setReviewTemplate] = useState("");
  const [defaultReviewTemplateText, setDefaultReviewTemplateText] = useState("");
  const [analyzeTemplate, setAnalyzeTemplate] = useState("");
  const [defaultAnalyzeTemplateText, setDefaultAnalyzeTemplateText] = useState("");
  const [saved, setSaved] = useState(false);
  const [snapshot, setSnapshot] = useState({
    binaryPath: "claude",
    model: "",
    tools: DEFAULT_TOOLS,
    commitTemplate: "",
    reviewTemplate: "",
    analyzeTemplate: "",
  });

  useEffect(() => {
    (async () => {
      const [b, m, t, ct, fallback, rt, reviewFallback, at, analyzeFallback] = await Promise.all([
        getSetting(KEYS.binary),
        getSetting(KEYS.model),
        getSetting(KEYS.tools),
        getSetting(KEYS.commitTemplate),
        defaultCommitTemplate(),
        getSetting(KEYS.reviewTemplate),
        defaultReviewTemplate(),
        getSetting(KEYS.analyzeTemplate),
        defaultAnalyzeTemplate(),
      ]);
      const loadedBinary = b || "claude";
      let loadedModelChoice = "";
      let loadedCustomModel = "";
      if (m) {
        if (MODEL_OPTIONS.some((opt) => opt.id === m)) {
          loadedModelChoice = m;
        } else {
          loadedModelChoice = CUSTOM_MODEL;
          loadedCustomModel = m;
        }
      }
      const loadedTools = t ? t.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TOOLS;
      const loadedTemplate = ct || fallback;
      const loadedReviewTemplate = rt || reviewFallback;
      const loadedAnalyzeTemplate = at || analyzeFallback;

      setBinaryPath(loadedBinary);
      setModelChoice(loadedModelChoice);
      setCustomModel(loadedCustomModel);
      setTools(loadedTools);
      setDefaultTemplate(fallback);
      setCommitTemplate(loadedTemplate);
      setDefaultReviewTemplateText(reviewFallback);
      setReviewTemplate(loadedReviewTemplate);
      setDefaultAnalyzeTemplateText(analyzeFallback);
      setAnalyzeTemplate(loadedAnalyzeTemplate);
      setSnapshot({
        binaryPath: loadedBinary,
        model: loadedModelChoice === CUSTOM_MODEL ? loadedCustomModel : loadedModelChoice,
        tools: loadedTools,
        commitTemplate: loadedTemplate,
        reviewTemplate: loadedReviewTemplate,
        analyzeTemplate: loadedAnalyzeTemplate,
      });
    })();
  }, []);

  const toggleTool = (id: string) => {
    setTools((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  };

  const addCustomTool = () => {
    const name = customTool.trim();
    if (!name || tools.includes(name)) return;
    setTools((prev) => [...prev, name]);
    setCustomTool("");
  };

  const removeTool = (id: string) => setTools((prev) => prev.filter((t) => t !== id));

  const browseBinary = async () => {
    const file = await open({ multiple: false, directory: false, title: t("settings.selectClaudeBinaryTitle") });
    if (typeof file === "string") setBinaryPath(file);
  };

  const customTools = tools.filter((t) => !KNOWN_TOOL_IDS.has(t));
  const resolvedModel = modelChoice === CUSTOM_MODEL ? customModel.trim() : modelChoice;
  const sortedTools = [...tools].sort();
  const dirty =
    binaryPath !== snapshot.binaryPath ||
    resolvedModel !== snapshot.model ||
    commitTemplate !== snapshot.commitTemplate ||
    reviewTemplate !== snapshot.reviewTemplate ||
    analyzeTemplate !== snapshot.analyzeTemplate ||
    sortedTools.join(",") !== [...snapshot.tools].sort().join(",");

  const save = async () => {
    await Promise.all([
      setSetting(KEYS.binary, binaryPath),
      setSetting(KEYS.model, resolvedModel),
      setSetting(KEYS.tools, tools.join(",")),
      setSetting(KEYS.commitTemplate, commitTemplate.trim()),
      setSetting(KEYS.reviewTemplate, reviewTemplate.trim()),
      setSetting(KEYS.analyzeTemplate, analyzeTemplate.trim()),
    ]);
    setSnapshot({
      binaryPath,
      model: resolvedModel,
      tools,
      commitTemplate: commitTemplate.trim(),
      reviewTemplate: reviewTemplate.trim(),
      analyzeTemplate: analyzeTemplate.trim(),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section>
      <h3 className="mb-1 text-sm font-semibold">{t("settings.claudeTitle")}</h3>
      <p className="mb-3 text-[13px] text-[var(--cf-text-muted)]">{t("settings.claudeHint")}</p>

      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
            {t("settings.claudeBinaryLabel")}
          </label>
          <div className="flex gap-1.5">
            <input
              value={binaryPath}
              onChange={(e) => setBinaryPath(e.target.value)}
              className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] font-mono outline-none focus:border-[var(--cf-accent)]"
            />
            <button
              onClick={browseBinary}
              title={t("settings.selectClaudeBinaryTitle")}
              className="flex items-center gap-1 rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              <FolderOpen size={13} />
              {t("settings.browse")}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--cf-text-muted)]">{t("settings.claudeBinaryHint")}</p>
        </div>

        <div>
          <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">{t("settings.model")}</label>
          <select
            value={modelChoice}
            onChange={(e) => setModelChoice(e.target.value)}
            className="w-full rounded-md border border-[var(--cf-border)] bg-[var(--cf-surface)] px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
          >
            {MODEL_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.labelKey ? t(opt.labelKey) : opt.label}
              </option>
            ))}
          </select>
          {modelChoice === CUSTOM_MODEL && (
            <input
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="e.g. claude-sonnet-5-20260115"
              className="mt-1.5 w-full rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] font-mono outline-none focus:border-[var(--cf-accent)]"
            />
          )}
        </div>

        <div>
          <label className="mb-1 block text-[12px] font-medium text-[var(--cf-text-muted)]">
            {t("settings.allowedTools")}
          </label>
          <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.allowedToolsHint")}</p>
          <div className="space-y-1.5 rounded-lg border border-[var(--cf-border)] p-2.5">
            {TOOL_OPTIONS.map((tool) => (
              <label
                key={tool.id}
                className="flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <Checkbox checked={tools.includes(tool.id)} onChange={() => toggleTool(tool.id)} className="mt-0.5" />
                <span>
                  <span className="block text-[13px] font-medium">{tool.id}</span>
                  <span className="block text-[11px] text-[var(--cf-text-muted)]">{t(tool.descriptionKey)}</span>
                </span>
              </label>
            ))}
          </div>

          {customTools.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {customTools.map((t) => (
                <span
                  key={t}
                  className="flex items-center gap-1 rounded-md bg-[var(--cf-accent-soft)] px-2 py-0.5 text-[11px] text-[var(--cf-accent)]"
                >
                  {t}
                  <button onClick={() => removeTool(t)}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="mt-2 flex gap-1.5">
            <input
              value={customTool}
              onChange={(e) => setCustomTool(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomTool();
                }
              }}
              placeholder={t("settings.addCustomTool")}
              className="flex-1 rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] font-mono outline-none focus:border-[var(--cf-accent)]"
            />
            <button
              onClick={addCustomTool}
              className="rounded-md border border-[var(--cf-border)] px-2.5 text-[12px] text-[var(--cf-text-muted)] hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
            >
              {t("settings.add")}
            </button>
          </div>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[12px] font-medium text-[var(--cf-text-muted)]">
              {t("settings.commitTemplate")}
            </label>
            <button
              onClick={() => setCommitTemplate(defaultTemplate)}
              title={t("settings.reset")}
              className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              <RotateCcw size={11} />
              {t("settings.reset")}
            </button>
          </div>
          <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.commitTemplateHint")}</p>
          <textarea
            value={commitTemplate}
            onChange={(e) => setCommitTemplate(e.target.value)}
            rows={5}
            className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 text-[13px] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[12px] font-medium text-[var(--cf-text-muted)]">
              {t("settings.reviewTemplate")}
            </label>
            <button
              onClick={() => setReviewTemplate(defaultReviewTemplateText)}
              title={t("settings.reset")}
              className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              <RotateCcw size={11} />
              {t("settings.reset")}
            </button>
          </div>
          <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.reviewTemplateHint")}</p>
          <textarea
            value={reviewTemplate}
            onChange={(e) => setReviewTemplate(e.target.value)}
            rows={10}
            className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <label className="block text-[12px] font-medium text-[var(--cf-text-muted)]">
              {t("settings.analyzeTemplate")}
            </label>
            <button
              onClick={() => setAnalyzeTemplate(defaultAnalyzeTemplateText)}
              title={t("settings.reset")}
              className="flex items-center gap-1 text-[11px] text-[var(--cf-text-muted)] hover:text-[var(--cf-accent)]"
            >
              <RotateCcw size={11} />
              {t("settings.reset")}
            </button>
          </div>
          <p className="mb-2 text-[11px] text-[var(--cf-text-muted)]">{t("settings.analyzeTemplateHint")}</p>
          <textarea
            value={analyzeTemplate}
            onChange={(e) => setAnalyzeTemplate(e.target.value)}
            rows={10}
            className="w-full resize-none rounded-md border border-[var(--cf-border)] bg-transparent px-2.5 py-1.5 font-mono text-[12px] outline-none focus:border-[var(--cf-accent)]"
          />
        </div>

        <button
          onClick={save}
          disabled={!dirty}
          className="flex items-center gap-1.5 rounded-md bg-[var(--cf-accent)] px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-40"
        >
          {saved ? <Check size={13} /> : null}
          {saved ? t("settings.saved") : t("common.save")}
        </button>
      </div>
    </section>
  );
}
