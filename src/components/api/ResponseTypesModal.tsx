import { useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import { Braces, Check, Copy } from "lucide-react";
import { ApiModal } from "./ApiModal";
import { buttonClass } from "../common/Button";
import { Select } from "../common/Select";
import { fieldClass } from "../common/recipes";
import { OVERFLOW_SAFE_OPTIONS } from "../../lib/monacoSetup";
import { isTypeName, PASTE_JSON_LANGUAGES, targetFor } from "../../lib/pasteJson/targets";
import { useThemeStore } from "../../state/themeStore";
import { useT } from "../../state/languageStore";

/** How each language is called in the picker — product names, the same in every language. */
const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript (JSDoc)",
  python: "Python",
  go: "Go",
  rust: "Rust",
  csharp: "C#",
  java: "Java",
  kotlin: "Kotlin",
  swift: "Swift",
  dart: "Dart",
};

/** The language picked last, so the next response opens in it. */
let lastLanguage = "typescript";

/** `GET /users/:id` → `UsersResponse`; anything else that is not a type name → `Response`. */
function typeNameFor(requestName: string): string {
  const words = requestName
    .replace(/^[A-Z]+\s+/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word && !/^\d/.test(word))
    .slice(-2);
  const name = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  const candidate = name ? `${name}Response` : "Response";
  return isTypeName(candidate) ? candidate : "Response";
}

/**
 * «Generar tipos»: the response body as the declarations that read it — TypeScript interfaces, Go
 * structs, C# records… — through the same quicktype engine «Pegar JSON como código» uses, loaded
 * the first time it is asked for.
 */
export function ResponseTypesModal({ json, requestName, onClose }: { json: string; requestName: string; onClose: () => void }) {
  const t = useT();
  const monacoTheme = useThemeStore((s) => s.monacoTheme);
  const [language, setLanguage] = useState(lastLanguage);
  const [name, setName] = useState(() => typeNameFor(requestName));
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const validName = isTypeName(name);

  useEffect(() => {
    lastLanguage = language;
    const target = targetFor(language);
    if (!target || !validName) return;
    let live = true;
    setError("");
    const timer = window.setTimeout(() => {
      void import("../../lib/pasteJson/generate")
        .then((engine) => engine.renderJsonAsCode({ json, name, target, indentation: "  ", fileName: `${name}.${language}` }))
        .then((generated) => {
          if (!live) return;
          setCode(generated);
          if (!generated) setError(t("pasteJson.nothing"));
        })
        .catch((e: unknown) => live && setError(t("pasteJson.failed", { error: e instanceof Error ? e.message : String(e) })));
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [json, language, name, t, validName]);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <ApiModal
      icon={Braces}
      title={t("api.types.title")}
      subtitle={requestName}
      width="max-w-4xl"
      height="h-[75vh]"
      onClose={onClose}
      toolbar={
        <div className="flex items-center gap-2">
          <input
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            aria-label={t("api.types.name")}
            title={validName ? t("api.types.name") : t("pasteJson.badName")}
            className={fieldClass({ size: "sm", className: `w-44 font-mono ${validName ? "" : "border-[var(--cf-danger)]"}` })}
          />
          <div className="w-[170px]">
            <Select
              size="sm"
              value={language}
              onChange={setLanguage}
              options={PASTE_JSON_LANGUAGES.map((id) => ({ value: id, label: LANGUAGE_NAMES[id] ?? id }))}
              ariaLabel={t("api.types.language")}
            />
          </div>
          <button type="button" onClick={copy} disabled={!code} className={buttonClass({ variant: "secondary", size: "sm" })}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {t("api.types.copy")}
          </button>
        </div>
      }
    >
      <div className="min-h-0 flex-1">
        {error ? (
          <p className="p-4 text-[12px] text-[var(--cf-danger)]">{error}</p>
        ) : (
          <Editor
            height="100%"
            path="inmemory://api-response-types/generated"
            language={language}
            value={code}
            theme={monacoTheme}
            saveViewState={false}
            options={{
              ...OVERFLOW_SAFE_OPTIONS,
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              fontSize: 12,
              automaticLayout: true,
              scrollBeyondLastLine: false,
            }}
          />
        )}
      </div>
    </ApiModal>
  );
}
