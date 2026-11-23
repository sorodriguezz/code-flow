import { describe, expect, it } from "vitest";
import { shortRepoNames } from "./repoShortNames";

describe("short repository names", () => {
  it("drops the prefix siblings share, the organisation path, and widens names that would clash", () => {
    const names = shortRepoNames([
      "Dev.Agenda.Node.DataSync",
      "Dev.Agenda.Node.Core",
      "Agendamiento",
      "Org-Transporte/FichaClinica.Transporte.React.Web",
      "Org-Transporte/FichaClinica.Transporte.Node.Bff",
      "Org-Transporte/FichaClinica.Transporte.Node.Core",
    ]);
    expect(names.get("Dev.Agenda.Node.DataSync")).toBe("DataSync");
    expect(names.get("Agendamiento")).toBe("Agendamiento");
    expect(names.get("Org-Transporte/FichaClinica.Transporte.React.Web")).toBe("React.Web");
    expect(names.get("Org-Transporte/FichaClinica.Transporte.Node.Bff")).toBe("Bff");
    // Both would be «Core»: each keeps segments until they differ.
    expect(names.get("Dev.Agenda.Node.Core")).toBe("Agenda.Node.Core");
    expect(names.get("Org-Transporte/FichaClinica.Transporte.Node.Core")).toBe("Transporte.Node.Core");
  });

  it("leaves a lone name whole", () => {
    expect(shortRepoNames(["Acme.Widgets.Api"]).get("Acme.Widgets.Api")).toBe("Acme.Widgets.Api");
  });
});
