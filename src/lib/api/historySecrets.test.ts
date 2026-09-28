import { describe, expect, it } from "vitest";
import type { ApiCollection, ApiEnvironment, ApiFolder } from "../../types/api";
import { historySecrets } from "./historySecrets";

const collection = (auth: string, variables: string): ApiCollection => ({
  id: "c1",
  workspace_id: "w1",
  name: "Orders",
  description: "",
  auth,
  pre_script: "",
  post_script: "",
  variables,
  sort_order: 0,
  pinned: false,
  created_at: "",
  updated_at: "",
  scope: "workspace",
});

const folder = (auth: string): ApiFolder => ({
  id: "f1",
  collection_id: "c1",
  parent_id: null,
  name: "v1",
  description: "",
  auth,
  pre_script: "",
  post_script: "",
  sort_order: 0,
  created_at: "",
  updated_at: "",
});

const environment = (variables: string): ApiEnvironment => ({
  id: "e1",
  workspace_id: "w1",
  name: "Dev",
  variables,
  is_global: false,
  sort_order: 0,
  created_at: "",
  updated_at: "",
});

describe("historySecrets", () => {
  it("hands over every auth block and variable list that could have put a credential on the wire", () => {
    const bearer = '{"type":"bearer","bearer":{"token":"tok"}}';
    const secretVars = '[{"key":"apiKey","initialValue":"k","currentValue":"","secret":true}]';
    const envVars = '[{"key":"password","initialValue":"p","currentValue":"","secret":true}]';
    const folderAuth = '{"type":"basic","basic":{"username":"u","password":"pw"}}';

    const secrets = historySecrets({
      collections: [collection(bearer, secretVars)],
      folders: [folder(folderAuth)],
      environments: [environment(envVars)],
    });

    expect(secrets.auths).toEqual([bearer, folderAuth]);
    expect(secrets.variables).toEqual([secretVars, envVars]);
  });

  it("leaves out what holds nothing, so an unconfigured workspace sends nothing", () => {
    const secrets = historySecrets({
      collections: [collection("", "[]")],
      folders: [folder("  ")],
      environments: [environment("")],
    });

    expect(secrets).toEqual({ auths: [], variables: [] });
  });
});
