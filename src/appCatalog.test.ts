import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error — a plain .mjs script, read by the test and by `node` alike.
import { CATALOG_PATH, buildCatalog, renderCatalog, riskOf } from "../scripts/app-catalog.mjs";

// The catalogue a chat's model calls the app through (`app_gateway.rs`) is generated from the
// Rust source. A command added, renamed or re-documented without regenerating it would be missing
// from what the model can do — or listed with arguments it no longer takes.
describe("the app's command catalogue", () => {
  it("is up to date with the source (run `node scripts/app-catalog.mjs`)", () => {
    expect(readFileSync(CATALOG_PATH, "utf8")).toBe(renderCatalog(buildCatalog()));
  });

  it("never offers a secret or the model's own approvals", () => {
    for (const name of ["get_github_token", "set_ado_pat", "keyvault_get_item", "remote_get_password", "agentcli_answer", "flows_bridge_answer", "db_set_password", "supabase_anon_key", "repo_env_reveal", "api_list_cookies", "speech_set_key"]) {
      expect(riskOf(name), name).toBe("blocked");
    }
  });

  it("asks before what destroys or widens what a model may do", () => {
    for (const name of ["delete_chat_conversation", "reset_app_data", "quit_app", "set_setting", "automation_set_enabled", "containers_kube_remove"]) {
      expect(riskOf(name), name).toBe("destructive");
    }
  });

  it("reads what only looks, whatever its area prefix", () => {
    for (const name of ["ado_list_projects", "list_pull_requests", "get_review_run", "list_pr_comment_threads", "deps_check_alerts", "get_setting", "pr_link_checks"]) {
      expect(riskOf(name), name).toBe("read");
    }
    for (const name of ["merge_pr_link", "reviewer_run", "get_or_create_branch", "create_pull_request"]) {
      expect(riskOf(name), name).not.toBe("read");
    }
  });
});
