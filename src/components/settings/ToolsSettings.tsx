import { SkillsSettings } from "./SkillsSettings";
import { McpSettings } from "./McpSettings";
import { RailSection } from "./settingsNav";
import { useT } from "../../state/languageStore";

/**
 * «Herramientas de IA»: what a model may use besides reading and writing code — skills and MCP
 * servers. They used to be two entries of the nav's «Workspace» group although each one picks its
 * own scope; here they are one section and each row says whether it is for every workspace or one.
 */
export function ToolsSettings() {
  const t = useT();
  return (
    <RailSection section="tools" title={t("settings.toolsTitle")} hint={t("settings.toolsHint")} fallback="skills">
      {(tab) => (
        <>
          {tab === "skills" && <SkillsSettings bare />}
          {tab === "mcp" && <McpSettings bare />}
        </>
      )}
    </RailSection>
  );
}
