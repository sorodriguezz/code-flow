/**
 * The exact line "Install ipykernel" runs — shown in the confirmation before anything runs, then
 * typed into a terminal of the dock, where its output is seen and it can be stopped like anything
 * else there. The interpreter's path is quoted for the shell that terminal runs: POSIX single
 * quotes (with a quote inside closed, escaped and reopened), or PowerShell's call operator on
 * Windows.
 */
export function installCommand(python: string, windows: boolean): string {
  if (windows) return `& "${python}" -m pip install ipykernel`;
  const quoted = /^[\w@%+=:,./-]+$/.test(python) ? python : `'${python.replace(/'/g, `'\\''`)}'`;
  return `${quoted} -m pip install ipykernel`;
}
