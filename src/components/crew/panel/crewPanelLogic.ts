/** What the panel's «Equipos» says and narrows by, apart from how it is drawn. */
import type { Team } from "../../../types/team";

type L = (es: string, en: string) => string;

/** Case and accents aside, as every search in the app compares. */
const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** What narrows the lists: every word typed, anywhere in what a row says. */
export function matchesQuery(query: string, ...said: string[]): boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = fold(said.join(" "));
  return words.every((word) => text.includes(word));
}

/** What a team's second line says when nothing is happening: how many it is and who leads it. */
export function teamLine(team: Team, l: L): string {
  const members = team.members.filter((member) => !member.advisor).length;
  const lead = team.members.find((member) => member.id === team.lead);
  const count = members === 1 ? l("1 miembro", "1 member") : l(`${members} miembros`, `${members} members`);
  if (team.members.length === 0) return l("Sin miembros todavía", "No members yet");
  return lead ? `${count} · ${l(`Lidera ${lead.name}`, `Led by ${lead.name}`)}` : `${count} · ${l("Flujo fijo, sin líder", "Fixed flow, no lead")}`;
}
