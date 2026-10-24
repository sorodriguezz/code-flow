/**
 * Test fixtures: fake people, companies and identifiers — including Chilean RUTs with a correct
 * check digit, which is what the user's own systems validate (user, 2026-10-23: «RUT chileno
 * válido»). A seed makes a set reproducible, so a fixture can be regenerated exactly.
 *
 * None of this is real data. The names are common first names and surnames, the e-mail domains are
 * the reserved `example.*` ones (RFC 2606) and the IBANs are well-formed but invented.
 */

/** mulberry32: small, fast, good enough for fixtures. Not for secrets — `ids.ts` is. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// RUT
// ---------------------------------------------------------------------------------------------

/** The check digit of a RUT body: modulo 11 with weights 2–7 from the right. */
export function rutCheckDigit(body: number | string): string {
  const digits = String(body).replace(/\D/g, "");
  let sum = 0;
  let weight = 2;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const dv = 11 - (sum % 11);
  return dv === 11 ? "0" : dv === 10 ? "K" : String(dv);
}

export function formatRut(body: number | string, dots = true): string {
  const digits = String(body).replace(/\D/g, "").replace(/^0+/, "");
  const grouped = dots ? digits.replace(/\B(?=(\d{3})+$)/g, ".") : digits;
  return `${grouped}-${rutCheckDigit(digits)}`;
}

export interface RutCheck {
  valid: boolean;
  /** The RUT written the standard way (`12.345.678-5`), when it has a body to write. */
  formatted: string;
  expected: string;
  given: string;
}

export function validateRut(text: string): RutCheck {
  const clean = text.trim().toUpperCase().replace(/[.\s]/g, "");
  const m = /^(\d{1,9})-?([\dK])$/.exec(clean);
  if (!m) return { valid: false, formatted: "", expected: "", given: "" };
  const expected = rutCheckDigit(m[1]);
  return { valid: expected === m[2], formatted: formatRut(m[1]), expected, given: m[2] };
}

export function randomRut(random: () => number = Math.random, min = 5_000_000, max = 25_000_000, dots = true): string {
  return formatRut(Math.floor(min + random() * (max - min)), dots);
}

// ---------------------------------------------------------------------------------------------
// IBAN
// ---------------------------------------------------------------------------------------------

function mod97(digits: string): number {
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
}

function ibanNumeric(text: string): string {
  return Array.from(text, (c) => (/[A-Z]/.test(c) ? String(c.charCodeAt(0) - 55) : c)).join("");
}

/** ISO 13616: move the country and check digits to the end, letters to numbers, mod 97 = 1. */
export function validateIban(text: string): boolean {
  const t = text.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(t)) return false;
  return mod97(ibanNumeric(t.slice(4) + t.slice(0, 4))) === 1;
}

const IBAN_SHAPES: Record<string, number> = { ES: 20, DE: 18, FR: 23, IT: 23, NL: 14, PT: 21, GB: 18 };

export function randomIban(random: () => number = Math.random, country = "ES"): string {
  const length = IBAN_SHAPES[country] ?? 20;
  const bban = Array.from({ length }, () => Math.floor(random() * 10)).join("");
  const check = 98 - mod97(ibanNumeric(`${bban}${country}00`));
  return `${country}${String(check).padStart(2, "0")}${bban}`.replace(/(.{4})(?=.)/g, "$1 ");
}

// ---------------------------------------------------------------------------------------------
// People and the rest
// ---------------------------------------------------------------------------------------------

const FIRST = "Sofía Valentina Isidora Florencia Catalina Emilia Martina Josefa Antonia Amanda Agustina Fernanda Camila Javiera Ignacia Mateo Agustín Benjamín Vicente Tomás Martín Joaquín Lucas Maximiliano Gaspar Felipe Diego Sebastián Cristóbal Matías Nicolás Alonso Francisco Gabriel Daniel".split(" ");
const LAST = "González Muñoz Rojas Díaz Pérez Soto Contreras Silva Martínez Sepúlveda Morales Rodríguez López Fuentes Hernández Torres Araya Flores Espinoza Valenzuela Castillo Tapia Reyes Gutiérrez Castro Pizarro Álvarez Vásquez Sánchez Fernández Ramírez Carrasco Gómez Cortés Herrera Núñez Jara Vergara Rivera Figueroa".split(" ");
const STREETS = "Av. Providencia|Av. Libertador Bernardo O'Higgins|Av. Apoquindo|Los Leones|Av. Italia|Irarrázaval|San Diego|Av. Vicuña Mackenna|Huérfanos|Agustinas|Av. Grecia|Pedro de Valdivia|Av. Matta|Manuel Montt|Av. Kennedy".split("|");
const COMMUNES = "Santiago|Providencia|Las Condes|Ñuñoa|La Florida|Maipú|Puente Alto|Viña del Mar|Valparaíso|Concepción|Temuco|La Serena|Antofagasta|Rancagua|Puerto Montt".split("|");
const COMPANY_A = "Andes Austral Pacífico Cordillera Litoral Araucaria Copihue Lago Volcán Desierto".split(" ");
const COMPANY_B = "Soluciones Servicios Logística Tecnologías Consultores Industrias Alimentos Energía Comercial Digital".split(" ");
const COMPANY_C = "SpA|S.A.|Ltda.|EIRL".split("|");
const DOMAINS = ["example.com", "example.org", "example.net", "example.cl"];

export type FakeField =
  | "name"
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "rut"
  | "address"
  | "commune"
  | "company"
  | "birthdate"
  | "date"
  | "uuid"
  | "iban"
  | "number"
  | "boolean";

export const FAKE_FIELDS: FakeField[] = ["name", "firstName", "lastName", "email", "phone", "rut", "address", "commune", "company", "birthdate", "date", "uuid", "iban", "number", "boolean"];

const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function uuidFrom(random: () => number): string {
  const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16));
  hex[12] = "4";
  hex[16] = ((Math.floor(random() * 4) + 8) as number).toString(16);
  const h = hex.join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** One fake record with the chosen fields, internally consistent (the e-mail is the person's). */
export function fakeRecord(fields: FakeField[], random: () => number): Record<string, unknown> {
  const pickOne = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  const first = pickOne(FIRST);
  const last = `${pickOne(LAST)} ${pickOne(LAST)}`;
  const out: Record<string, unknown> = {};
  const isoDate = (from: number, to: number) => new Date(from + random() * (to - from)).toISOString().slice(0, 10);
  for (const f of fields) {
    switch (f) {
      case "name":
        out.name = `${first} ${last}`;
        break;
      case "firstName":
        out.firstName = first;
        break;
      case "lastName":
        out.lastName = last;
        break;
      case "email":
        out.email = `${ascii(first)}.${ascii(last.split(" ")[0])}${Math.floor(random() * 100)}@${pickOne(DOMAINS)}`;
        break;
      case "phone":
        out.phone = `+56 9 ${String(Math.floor(random() * 1e4)).padStart(4, "0")} ${String(Math.floor(random() * 1e4)).padStart(4, "0")}`;
        break;
      case "rut":
        out.rut = randomRut(random);
        break;
      case "address":
        out.address = `${pickOne(STREETS)} ${100 + Math.floor(random() * 9900)}`;
        break;
      case "commune":
        out.commune = pickOne(COMMUNES);
        break;
      case "company":
        out.company = `${pickOne(COMPANY_B)} ${pickOne(COMPANY_A)} ${pickOne(COMPANY_C)}`;
        break;
      case "birthdate":
        out.birthdate = isoDate(Date.UTC(1950, 0, 1), Date.UTC(2006, 0, 1));
        break;
      case "date":
        out.date = new Date(Date.UTC(2020, 0, 1) + random() * (Date.UTC(2027, 0, 1) - Date.UTC(2020, 0, 1))).toISOString();
        break;
      case "uuid":
        out.uuid = uuidFrom(random);
        break;
      case "iban":
        out.iban = randomIban(random);
        break;
      case "number":
        out.number = Math.floor(random() * 10000);
        break;
      case "boolean":
        out.boolean = random() < 0.5;
        break;
    }
  }
  return out;
}

export function fakeRecords(fields: FakeField[], count: number, seed?: number): Record<string, unknown>[] {
  const random = seed === undefined ? Math.random : seededRandom(seed);
  return Array.from({ length: count }, () => fakeRecord(fields, random));
}
