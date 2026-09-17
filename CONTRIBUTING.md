# Contributing to CodeFlow

*[Español más abajo](#contribuir-a-codeflow)*

Thanks for wanting to help. Contributions are welcome — bug reports, ideas and
pull requests.

## Before you start: the licence

CodeFlow is **source-available, not open source**. Read [`LICENSE`](LICENSE)
before you write a line. The short version:

- You may **read** the source, and clone it **only** to prepare a contribution.
- You may **use** the app freely, from the builds published in
  [Releases](../../releases).
- You may **not** fork it into your own product, redistribute it, or reuse its
  code elsewhere.

**By opening a pull request you grant the copyright holder a perpetual,
worldwide, irrevocable, royalty-free licence — with the right to sublicense and
relicense — to use your contribution in CodeFlow under any terms, including
proprietary and paid ones.** You keep the copyright in your own work and stay
free to use it elsewhere. This is section 4 of the licence, and opening the PR
is how you accept it — there is no separate form to sign.

If you are contributing on behalf of an employer, make sure you are allowed to.

## Reporting a bug or suggesting an idea

Open an [issue](../../issues). For a bug, include your OS, the app version
(**Settings › About**) and the steps to reproduce it. For a security problem,
please open a private security advisory instead of a public issue.

## Sending a pull request

```bash
pnpm install
pnpm tauri dev
```

Before you push, run what CI runs on every pull request:

```bash
node scripts/check-translations.mjs && pnpm exec tsc --noEmit
```

Both must pass. The first one is the trap that catches most newcomers: **every
English string needs its Spanish twin**. The app ships in both languages and a
missing translation fails the build.

If you touched Rust, run `cargo test` in `src-tauri/` too. Two tests in
`debugger::live_tests` already fail on a clean tree — that is the known
baseline, not something you broke.

A good pull request:

- does **one** thing, and says in its description what and why;
- keeps the style of the code around it;
- adds tests when it changes behaviour;
- does not bump the version or edit release workflows — those are the
  maintainer's.

There is no obligation to merge any contribution, and no timeline. If a PR sits
open, feel free to ping it.

---

# Contribuir a CodeFlow

Gracias por querer ayudar. Las contribuciones son bienvenidas: reportes de
bugs, ideas y pull requests.

## Antes de empezar: la licencia

CodeFlow es software de **código visible, no de código abierto**. Lee
[`LICENSE`](LICENSE) (hay una [traducción informativa](LICENSE.es.md)) antes de
escribir una línea. En corto:

- Puedes **leer** el código, y clonarlo **solo** para preparar una
  contribución.
- Puedes **usar** la app libremente, desde las compilaciones publicadas en
  [Releases](../../releases).
- **No** puedes bifurcarla hacia tu propio producto, redistribuirla ni
  reutilizar su código en otra parte.

**Al abrir un pull request le concedes al titular del copyright una licencia
perpetua, mundial, irrevocable y gratuita —con derecho a sublicenciar y
relicenciar— para usar tu contribución en CodeFlow bajo cualquier término,
incluidos los propietarios y de pago.** Conservas el copyright de tu trabajo y
sigues libre de usarlo en otra parte. Es la sección 4 de la licencia, y abrir
el PR es la forma de aceptarla: no hay ningún formulario que firmar.

Si contribuyes por cuenta de tu empleador, asegúrate de que puedes hacerlo.

## Reportar un bug o proponer una idea

Abre un [issue](../../issues). Para un bug, incluye tu sistema operativo, la
versión de la app (**Ajustes › Acerca de**) y los pasos para reproducirlo. Si
es un problema de seguridad, abre un aviso de seguridad privado en lugar de un
issue público.

## Enviar un pull request

```bash
pnpm install
pnpm tauri dev
```

Antes de subir, corre lo mismo que corre CI en cada pull request:

```bash
node scripts/check-translations.mjs && pnpm exec tsc --noEmit
```

Los dos tienen que pasar. El primero es la trampa que pilla a casi todo el
mundo: **cada texto en inglés necesita su gemelo en español**. La app se
publica en los dos idiomas y una traducción que falta rompe el build.

Si tocaste Rust, corre también `cargo test` en `src-tauri/`. Dos tests de
`debugger::live_tests` ya fallan en un árbol limpio: esa es la línea base
conocida, no algo que hayas roto tú.

Un buen pull request:

- hace **una** sola cosa, y explica en su descripción qué y por qué;
- respeta el estilo del código que lo rodea;
- añade tests cuando cambia comportamiento;
- no sube la versión ni toca los workflows de release — eso es del
  mantenedor.

No hay obligación de integrar ninguna contribución, ni plazos. Si un PR se
queda quieto, puedes darle un toque.
