/**
 * Raw messages from git and the file system, said the way a person would — with what to do next.
 *
 * Most errors reach a toast as the tool printed them («cannot set HEAD to reference … linked
 * repository»). The ones users actually hit are matched here and replaced; anything unknown passes
 * through untouched, so nothing is ever hidden.
 */

type Phrase = [es: string, en: string];

const RULES: { test: RegExp; say: (m: RegExpMatchArray) => Phrase }[] = [
  {
    test: /cannot (?:set HEAD to reference|delete branch) '?refs\/heads\/([^' ]+)'? as it is the current HEAD of a linked repository/i,
    say: (m) => [
      `La rama «${m[1]}» está abierta en otro worktree. Una rama vive en una sola copia a la vez: ábrela ahí o elimina ese worktree primero.`,
      `The branch «${m[1]}» is checked out in another worktree. A branch lives in one working copy at a time: open it there or remove that worktree first.`,
    ],
  },
  {
    test: /failed to resolve path '([^']+)': No such file or directory/i,
    say: (m) => [
      `La carpeta ${m[1]} ya no existe (se integró o se borró). Ábrela de nuevo desde su tarea o elimínala de la lista.`,
      `The folder ${m[1]} no longer exists (it was merged or removed). Open it again from its task or remove it from the list.`,
    ],
  },
  {
    test: /'([^']+)' is already checked out at '([^']+)'/i,
    say: (m) => [`La rama «${m[1]}» ya está abierta en ${m[2]}.`, `The branch «${m[1]}» is already checked out at ${m[2]}.`],
  },
  {
    test: /could not lock config file|index\.lock': File exists/i,
    say: () => [
      "Otro proceso de git está usando el repositorio. Espera un momento y vuelve a intentarlo.",
      "Another git process is using the repository. Wait a moment and try again.",
    ],
  },
  {
    test: /Authentication failed|could not read Username|Permission denied \(publickey\)/i,
    say: () => [
      "El servidor rechazó tus credenciales. Revisa la cuenta conectada en Configuración › Cuentas.",
      "The server refused your credentials. Check the connected account in Settings › Accounts.",
    ],
  },
];

/** `raw` in plain words, or `raw` itself when it is not one of the known ones. */
export function humanizeRaw(raw: string, spanish: boolean): string {
  for (const rule of RULES) {
    const match = raw.match(rule.test);
    if (match) return rule.say(match)[spanish ? 0 : 1];
  }
  return raw;
}
