import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  detectFormat,
  importVaultExport,
  parseBitwardenCsv,
  parseBitwardenJson,
  parseOnePasswordCsv,
  parseOnePux,
  type ImportedItem,
} from "./import";

/**
 * Reading another password manager's export — and our own Bitwarden export read back.
 *
 * The parsers were once checked by 42 assertions run through the vendored esbuild, never committed
 * because the repository had no test runner. These are their committed successors, one fixture per
 * format, each carrying the awkward cases: a nameless entry, a hidden field, an archived row, a
 * vault as a folder. The last block reads the files `keyvault::export` is pinned to in Rust
 * (`src/lib/vault/fixtures/`), so "what we export, Bitwarden's format reader takes" is checked
 * across the language boundary rather than assumed on each side of it.
 */

const find = (items: ImportedItem[], title: string) => {
  const item = items.find((entry) => entry.title === title);
  expect(item, title).toBeDefined();
  return item as ImportedItem;
};

const BITWARDEN_JSON = JSON.stringify({
  encrypted: false,
  folders: [{ id: "f1", name: "Trabajo" }],
  items: [
    {
      type: 1,
      name: "GitHub",
      folderId: "f1",
      favorite: true,
      notes: "  la cuenta del equipo ",
      login: {
        username: " ana ",
        password: " con espacios ",
        totp: "JBSWY3DPEHPK3PXP",
        uris: [{ uri: "https://github.com" }],
      },
      fields: [
        { name: "PIN", value: "1234", type: 1 },
        { name: "Pregunta", value: "azul", type: 0 },
        { name: "", value: "" },
      ],
    },
    {
      type: 3,
      name: "Visa",
      card: { cardholderName: "Ana Pérez", number: "4111", code: "123", expMonth: "8", expYear: "2029" },
    },
    {
      type: 4,
      name: "Pasaporte",
      identity: { firstName: "Ana", middleName: null, lastName: "Pérez", passportNumber: "X123" },
    },
    { type: 2, name: "Nota", notes: "secreto", secureNote: { type: 0 } },
    { type: 1, name: "  ", login: { username: "nadie" } },
  ],
});

describe("Bitwarden JSON", () => {
  const result = parseBitwardenJson(BITWARDEN_JSON);

  it("reads every kind, files by folder name, and skips — and counts — the nameless", () => {
    expect(result.format).toBe("bitwarden-json");
    expect(result.items.map((item) => [item.title, item.kind])).toEqual([
      ["GitHub", "login"],
      ["Visa", "card"],
      ["Pasaporte", "identity"],
      ["Nota", "note"],
    ]);
    expect(result.folders).toEqual(["Trabajo"]);
    expect(result.warnings).toEqual([{ key: "vault.import.skippedUnnamed", params: { n: 1 } }]);
  });

  it("trims identifiers and nothing else, and keeps a hidden field hidden", () => {
    const github = find(result.items, "GitHub");
    expect(github).toMatchObject({ subtitle: "ana", site: "https://github.com", folder: "Trabajo", favorite: true });
    expect(github.secret).toMatchObject({ username: "ana", totp: "JBSWY3DPEHPK3PXP", notes: "la cuenta del equipo" });
    expect(github.secret.custom).toEqual([
      { name: "PIN", value: "1234", secret: true },
      { name: "Pregunta", value: "azul", secret: false },
    ]);
  });

  it("maps a card and an identity onto their own fields", () => {
    expect(find(result.items, "Visa").secret).toMatchObject({
      cardholder: "Ana Pérez",
      cardNumber: "4111",
      cvv: "123",
      expiry: "8/2029",
    });
    expect(find(result.items, "Pasaporte").secret).toMatchObject({ fullName: "Ana Pérez", documentNumber: "X123" });
  });

  it("refuses an encrypted export, and a file that is not JSON, with the reason", () => {
    expect(parseBitwardenJson('{"encrypted": true, "items": []}').warnings).toEqual([
      { key: "vault.import.bitwardenEncrypted" },
    ]);
    expect(parseBitwardenJson("{nope").warnings).toEqual([{ key: "vault.import.notJson" }]);
  });
});

const BITWARDEN_CSV = [
  "folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp",
  'Trabajo,1,login,"Correo, del equipo",hola,"PIN: 1234\nColor: azul",0,https://mail.test,ana,pw,',
  ",,note,Receta,\"línea 1\nlínea 2\",,0,,,,",
  ",,login,,,,0,https://x.test,x,y,",
].join("\n");

describe("Bitwarden CSV", () => {
  const result = parseBitwardenCsv(BITWARDEN_CSV);

  it("reads logins and notes, quoted cells and custom fields included", () => {
    expect(result.items.map((item) => [item.title, item.kind])).toEqual([
      ["Correo, del equipo", "login"],
      ["Receta", "note"],
    ]);
    const mail = find(result.items, "Correo, del equipo");
    expect(mail).toMatchObject({ folder: "Trabajo", favorite: true, site: "https://mail.test", subtitle: "ana" });
    expect(mail.secret.custom).toEqual([
      { name: "PIN", value: "1234", secret: false },
      { name: "Color", value: "azul", secret: false },
    ]);
    expect(find(result.items, "Receta").secret.notes).toBe("línea 1\nlínea 2");
    expect(result.warnings).toContainEqual({ key: "vault.import.skippedUnnamed", params: { n: 1 } });
  });

  it("says which columns are missing, and refuses a CSV with no names at all", () => {
    expect(parseBitwardenCsv("name,login_password\nA,b").warnings[0]).toMatchObject({
      key: "vault.import.missingColumns",
    });
    expect(parseBitwardenCsv("a,b\n1,2").warnings).toEqual([{ key: "vault.import.notBitwardenCsv" }]);
    expect(parseBitwardenCsv("").warnings).toEqual([{ key: "vault.import.emptyFile" }]);
  });
});

const ONEPASSWORD_CSV = [
  "Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes,Type,Recovery email",
  "GitHub,https://github.com,ana,pw1,otpauth://totp/GitHub?secret=ABC,true,false,\"dev,trabajo\",nota,Login,ana@example.test",
  "Viejo,https://old.test,bob,pw2,,false,true,,,Login,",
  ",https://nameless.test,x,y,,,,,,,",
].join("\n");

describe("1Password CSV", () => {
  const result = parseOnePasswordCsv(ONEPASSWORD_CSV);

  it("reads logins, keeps unknown columns as custom fields, and tags what was archived", () => {
    expect(result.items.map((item) => item.title)).toEqual(["GitHub", "Viejo"]);
    const github = find(result.items, "GitHub");
    expect(github).toMatchObject({ kind: "login", favorite: true, tags: ["dev", "trabajo"], site: "https://github.com" });
    expect(github.secret).toMatchObject({ username: "ana", password: "pw1", totp: "otpauth://totp/GitHub?secret=ABC" });
    expect(github.secret.custom).toEqual([{ name: "Recovery email", value: "ana@example.test", secret: false }]);
    expect(find(result.items, "Viejo").tags).toEqual(["archived"]);
  });

  it("warns about the nameless row, the archive and the missing folders", () => {
    expect(result.warnings).toEqual([
      { key: "vault.import.skippedUnnamed", params: { n: 1 } },
      { key: "vault.import.archivedTagged", params: { n: 1 } },
      { key: "vault.import.csvNoFolders" },
    ]);
  });
});

/** `export.data`, as `keyvault_read_import_file` lifts it out of a `.1pux`. */
const ONEPUX = JSON.stringify({
  accounts: [
    {
      attrs: { accountName: "Personal" },
      vaults: [
        {
          attrs: { name: "Privado" },
          items: [
            {
              item: {
                categoryUuid: "001",
                favIndex: 1,
                overview: { title: "Correo", url: "https://mail.test", tags: ["email"] },
                details: {
                  loginFields: [
                    { designation: "username", value: "ana" },
                    { designation: "password", value: "pw" },
                  ],
                  notesPlain: "nota",
                  sections: [
                    {
                      fields: [
                        { title: "one-time password", value: { totp: "otpauth://totp/x?secret=Q" } },
                        { title: "PIN", value: { concealed: "1234" } },
                        { title: "Pista", value: { string: "azul" } },
                        { title: "Vacío", value: { string: "" } },
                      ],
                    },
                  ],
                },
              },
            },
            {
              item: {
                categoryUuid: "102",
                overview: { title: "Base prod" },
                details: { sections: [{ fields: [{ title: "server", value: { string: "db.test" } }] }] },
              },
            },
            { item: { categoryUuid: "006", overview: { title: "Contrato" }, details: { documentAttributes: [{}] } } },
            { item: { overview: { title: "" } } },
          ],
        },
      ],
    },
  ],
});

describe("1Password .1pux", () => {
  const result = parseOnePux(ONEPUX);

  it("walks accounts and vaults, and files each entry under its vault's name", () => {
    expect(result.items.map((item) => [item.title, item.kind, item.folder])).toEqual([
      ["Correo", "login", "Privado"],
      ["Base prod", "database", "Privado"],
      ["Contrato", "file", "Privado"],
    ]);
    expect(result.folders).toEqual(["Privado"]);
  });

  it("reads the login fields by designation and the sections by value type", () => {
    const mail = find(result.items, "Correo");
    expect(mail).toMatchObject({ favorite: true, tags: ["email"], site: "https://mail.test" });
    expect(mail.secret).toMatchObject({ username: "ana", password: "pw", totp: "otpauth://totp/x?secret=Q", notes: "nota" });
    expect(mail.secret.custom).toEqual([
      { name: "PIN", value: "1234", secret: true },
      { name: "Pista", value: "azul", secret: false },
    ]);
    expect(find(result.items, "Base prod").secret.custom).toEqual([{ name: "server", value: "db.test", secret: false }]);
  });

  it("counts what it had to leave behind", () => {
    expect(result.warnings).toEqual([
      { key: "vault.import.skippedUnnamed", params: { n: 1 } },
      { key: "vault.import.attachmentsSkipped", params: { n: 1 } },
    ]);
  });
});

describe("detectFormat", () => {
  it("recognises each format by its shape, whatever the file is called", () => {
    expect(detectFormat(BITWARDEN_JSON, "export.txt")).toBe("bitwarden-json");
    expect(detectFormat(BITWARDEN_CSV)).toBe("bitwarden-csv");
    expect(detectFormat(ONEPASSWORD_CSV)).toBe("onepassword-csv");
    expect(detectFormat(ONEPUX)).toBe("onepassword-1pux");
    expect(detectFormat('{"hello": 1}')).toBe("unknown");
    expect(detectFormat("a,b\n1,2", "cosas.csv")).toBe("bitwarden-csv");
    expect(importVaultExport("hola").warnings).toEqual([{ key: "vault.import.unknownFormat" }]);
  });
});

/**
 * The export round trip: the Bitwarden files `keyvault::export` writes (pinned there byte for byte)
 * read back by this importer. What survives is the contract; what does not is what the export dialog
 * says it leaves out — a database entry comes back a login, a key comes back a note, both with their
 * values as custom fields; a nested folder comes back as one folder named by its path.
 */
describe("our own Bitwarden export, read back", () => {
  const fixture = (name: string) =>
    readFileSync(new URL(`./fixtures/codeflow-export.bitwarden.${name}`, import.meta.url), "utf8");

  it("from JSON keeps every secret, the hidden flag and the folder path", () => {
    const result = importVaultExport(fixture("json"), "export.json");
    expect(result.format).toBe("bitwarden-json");
    expect(result.warnings).toEqual([]);
    expect(result.items.map((item) => [item.title, item.kind, item.folder])).toEqual([
      ["Correo, del equipo", "login", "Trabajo"],
      ["Prod", "login", "Trabajo/Bases"],
      ["Visa", "card", null],
      ["API", "note", null],
    ]);
    const mail = find(result.items, "Correo, del equipo");
    expect(mail.favorite).toBe(true);
    expect(mail.secret).toMatchObject({
      username: "ana@example.test",
      password: 'p"ss,word',
      totp: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP",
      notes: "línea 1\nlínea 2",
    });
    expect(mail.secret.custom).toEqual([{ name: "PIN", value: "1234", secret: true }]);
    expect(find(result.items, "Prod").secret.custom).toEqual([
      { name: "engine", value: "postgres", secret: false },
      { name: "host", value: "db.example.test", secret: false },
    ]);
    expect(find(result.items, "Visa").secret).toMatchObject({ cardNumber: "4111111111111111", cvv: "123", expiry: "08/29" });
    expect(find(result.items, "API").secret.custom).toEqual([{ name: "apiKey", value: "sk-test-123", secret: true }]);
  });

  it("from CSV keeps logins whole and carries every other value as a field", () => {
    const result = importVaultExport(fixture("csv"), "export.csv");
    expect(result.format).toBe("bitwarden-csv");
    expect(result.items.map((item) => [item.title, item.kind, item.folder])).toEqual([
      ["Correo, del equipo", "login", "Trabajo"],
      ["Prod", "login", "Trabajo/Bases"],
      ["Visa", "note", null],
      ["API", "note", null],
    ]);
    expect(find(result.items, "Correo, del equipo").secret).toMatchObject({ password: 'p"ss,word', notes: "línea 1\nlínea 2" });
    expect(find(result.items, "Visa").secret.custom).toContainEqual({ name: "cardNumber", value: "4111111111111111", secret: false });
  });
});
