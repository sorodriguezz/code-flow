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

Open an [issue](../../issues). For a bug, include your OS, the app version and
the steps to reproduce it — **Settings › About and diagnostics › Copy
diagnostics** gathers the first two for you. For a security problem,
please open a private security advisory instead of a public issue.

## Sending a pull request

```bash
pnpm install
pnpm tauri dev
```

### On macOS: one certificate, once

Ask macOS for your Keychain password on every launch and you have hit this. The
linker ad-hoc signs each build, and an ad-hoc signature is a bare hash of the
executable — so every rebuild is a new app as far as the Keychain is concerned,
and "Always Allow" means "until you next press save".

Give it one signature that never changes and the authorization sticks:

1. Open **Keychain Access** → menu **Keychain Access › Certificate Assistant ›
   Create a Certificate…**
2. Name it **`CodeFlow Dev`**, Identity Type **Self Signed Root**, Certificate
   Type **Code Signing**. Nothing else needs changing, and no Apple account is
   involved.
3. Rebuild. `src-tauri/scripts/sign-dev.sh` finds it from then on and says so in
   your terminal while it cannot.

Answer the password prompt once more after that and it should be the last one.
A different name works if you export `CODEFLOW_SIGN_IDENTITY`. Skip all of this
and everything still builds and runs — you just keep typing your password.

Before you open a pull request, run what CI runs on every one — plus the Rust
suite, which CI does not run:

```bash
node scripts/check-translations.mjs && node scripts/check-control-bytes.mjs
pnpm exec tsc --noEmit
pnpm test                 # the vitest suite
pnpm notices:check        # THIRD-PARTY-NOTICES.md still matches the dependencies
cd src-tauri && cargo test --lib   # from src-tauri/, where the signing runner applies
```

All of it must pass. The translation check is the trap that catches most
newcomers: **every English string needs its Spanish twin**. The app ships in
both languages and a missing translation fails the build.

`cargo test --lib` has a baseline of **zero failures**, so anything red is
yours to look at. Some tests use the macOS Keychain, and after a rebuild macOS
may ask for access; with the `CodeFlow Dev` certificate above, allowing it once
is enough.

Added, removed or upgraded a dependency? Then `pnpm notices:check` fails until
you run `pnpm notices` and commit the regenerated `THIRD-PARTY-NOTICES.md`. It
works offline, from the lockfiles. A licence it has never seen gets a warning
and copyleft stops it — say so in the pull request rather than working around
it.

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
versión de la app y los pasos para reproducirlo — **Ajustes › Acerca de y
diagnóstico › Copiar diagnóstico** reúne los dos primeros por ti. Si
es un problema de seguridad, abre un aviso de seguridad privado en lugar de un
issue público.

## Enviar un pull request

```bash
pnpm install
pnpm tauri dev
```

### En macOS: un certificado, una sola vez

Si macOS te pide la contraseña del llavero en cada arranque, es esto. El linker
firma cada build en modo ad-hoc, y una firma ad-hoc no es más que un hash del
ejecutable — así que cada recompilación es una app nueva para el llavero, y
"Permitir siempre" dura hasta que vuelvas a guardar.

Dale una firma que no cambie y la autorización se queda:

1. Abre **Acceso a Llaveros** → menú **Acceso a Llaveros › Asistente de
   certificados › Crear un certificado…**
2. Llámalo **`CodeFlow Dev`**, tipo de identidad **Raíz autofirmada**, tipo de
   certificado **Firma de código**. No hace falta tocar nada más, y no
   interviene ninguna cuenta de Apple.
3. Recompila. A partir de ahí `src-tauri/scripts/sign-dev.sh` lo encuentra solo,
   y mientras no pueda te lo dice por la terminal.

Responde al aviso de contraseña una vez más y debería ser la última. Si
prefieres otro nombre, exporta `CODEFLOW_SIGN_IDENTITY`. Si te saltas todo esto
igual compila y funciona — solo seguirás escribiendo la contraseña.

Antes de abrir un pull request, corre lo mismo que corre CI en cada uno — y
además la suite de Rust, que CI no corre:

```bash
node scripts/check-translations.mjs && node scripts/check-control-bytes.mjs
pnpm exec tsc --noEmit
pnpm test                 # la suite de vitest
pnpm notices:check        # THIRD-PARTY-NOTICES.md sigue al día con las dependencias
cd src-tauri && cargo test --lib   # desde src-tauri/, donde aplica el runner que firma
```

Todo tiene que pasar. La comprobación de traducciones es la trampa que pilla a
casi todo el mundo: **cada texto en inglés necesita su gemelo en español**. La
app se publica en los dos idiomas y una traducción que falta rompe el build.

`cargo test --lib` tiene una línea base de **cero fallos**, así que cualquier
rojo te toca revisarlo. Algunos tests usan el llavero de macOS, y después de
recompilar macOS puede pedirte acceso; con el certificado `CodeFlow Dev` de
arriba, basta con permitirlo una vez.

¿Agregaste, quitaste o actualizaste una dependencia? Entonces `pnpm notices:check`
falla hasta que corras `pnpm notices` y hagas commit del
`THIRD-PARTY-NOTICES.md` regenerado. Funciona sin conexión, desde los lockfiles.
Una licencia que nunca ha visto genera un aviso, y una licencia copyleft lo
detiene — dilo en el pull request en vez de esquivarlo.

Un buen pull request:

- hace **una** sola cosa, y explica en su descripción qué y por qué;
- respeta el estilo del código que lo rodea;
- añade tests cuando cambia comportamiento;
- no sube la versión ni toca los workflows de release — eso es del
  mantenedor.

No hay obligación de integrar ninguna contribución, ni plazos. Si un PR se
queda quieto, puedes darle un toque.
