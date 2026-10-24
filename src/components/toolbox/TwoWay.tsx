/**
 * The shape most encoders share: text in, a direction (encode / decode), text out, live — and a
 * swap that moves the output into the input and flips the direction, for round-tripping.
 */
import type { ReactNode } from "react";
import { ArrowDownUp } from "lucide-react";
import { Segmented } from "../common/Segmented";
import { buttonClass } from "../common/Button";
import { useT } from "../../state/languageStore";
import { OptionsRow, Split, TextPane, useAsyncResult } from "./kit";
import { useToolField } from "../../state/toolboxStore";
import type { TranslationKey } from "../../lib/i18n/translations";

export type Direction = "encode" | "decode";

export function TwoWayTool({
  tool,
  run,
  options,
  labels = ["toolbox.encode", "toolbox.decode"],
  placeholder,
  sample,
}: {
  tool: string;
  run: (input: string, direction: Direction) => string | Promise<string>;
  options?: ReactNode;
  labels?: [TranslationKey, TranslationKey];
  placeholder?: string;
  /** Filled in by "Ejemplo", so the tool can be tried without hunting for input. */
  sample?: string;
}) {
  const t = useT();
  const [input, setInput] = useToolField(tool, "input", "");
  const [direction, setDirection] = useToolField<Direction>(tool, "direction", "encode");
  const result = useAsyncResult(() => (input ? run(input, direction) : ""), [input, direction, run], 60);
  return (
    <>
      <OptionsRow>
        <Segmented
          layoutId={`toolbox-${tool}-dir`}
          size="sm"
          value={direction}
          onChange={setDirection}
          options={[
            { value: "encode", label: t(labels[0]) },
            { value: "decode", label: t(labels[1]) },
          ]}
        />
        {options}
        <span className="flex-1" />
        {sample && !input ? (
          <button type="button" className={buttonClass({ variant: "ghost", size: "sm" })} onClick={() => setInput(sample)}>
            {t("toolbox.sample")}
          </button>
        ) : null}
        <button
          type="button"
          className={buttonClass({ variant: "ghost", size: "sm" })}
          disabled={!result.value}
          onClick={() => {
            setInput(result.value ?? "");
            setDirection(direction === "encode" ? "decode" : "encode");
          }}
        >
          <ArrowDownUp size={13} />
          {t("toolbox.swap")}
        </button>
      </OptionsRow>
      <Split>
        <TextPane label={t("toolbox.input")} value={input} onChange={setInput} placeholder={placeholder} />
        <TextPane label={t("toolbox.output")} value={result.value ?? ""} error={result.error} />
      </Split>
    </>
  );
}
