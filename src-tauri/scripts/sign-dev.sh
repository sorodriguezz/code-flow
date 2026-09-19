#!/bin/sh
# Signs the dev binary with a stable local identity, then runs it. Cargo invokes this through
# `target.<triple>.runner`, which puts it between `cargo run` — what `tauri dev` shells out to —
# and the executable itself.
#
# The reason it exists is the Keychain prompt described at the top of src/secrets.rs. On Apple
# silicon the linker ad-hoc signs every binary it produces, and an ad-hoc signature's designated
# requirement is a bare hash of the executable. macOS records Keychain "Always Allow" — and TCC
# grants such as screen recording — against that requirement, so a hash that changes on every
# rebuild means every rebuild is a new app asking for the password again. Signing with one
# certificate that never changes gives the binary a requirement of
# `identifier "..." and certificate leaf = H"..."` instead, which survives rebuilds, so the
# authorization granted once stays granted.
#
# IDENTITY is a self-signed code-signing certificate in the login keychain, created once by hand
# in Keychain Access; it needs no Apple account. When it is absent — a fresh clone, another
# machine, CI — this skips signing and runs the binary exactly as it did before.
IDENTITY="${CODEFLOW_SIGN_IDENTITY:-CodeFlow Dev}"

BIN="$1"
[ -n "$BIN" ] || { echo "sign-dev.sh: cargo passed no binary" >&2; exit 64; }
shift

if [ "$(uname -s)" != "Darwin" ]; then
    exec "$BIN" "$@"
fi

if security find-identity -v -p codesigning 2>/dev/null | grep -qF "$IDENTITY"; then
    # Pinning the bundle identifier onto the bare binary lets `tauri dev` and a locally signed
    # .app share one Keychain ACL rather than needing an authorization each. Test binaries keep
    # the default identifier, so they stay on their own ACL and their own com.codeflow.app.test
    # service, as the tests in src/secrets.rs expect.
    if [ "${BIN##*/}" = "codeflow" ]; then
        codesign --force --sign "$IDENTITY" --identifier com.codeflow.app --timestamp=none "$BIN" \
            >/dev/null 2>&1 || echo "sign-dev.sh: codesign failed, running unsigned" >&2
    else
        codesign --force --sign "$IDENTITY" --timestamp=none "$BIN" \
            >/dev/null 2>&1 || echo "sign-dev.sh: codesign failed, running unsigned" >&2
    fi
elif [ "${BIN##*/}" = "codeflow" ]; then
    # Said out loud, because the silent version of this branch is indistinguishable from the fix
    # working. Everything here is conditional on a certificate somebody has to create by hand once,
    # and when it is missing the only symptom is the Keychain asking for the password again after a
    # rebuild — which looks exactly like the bug this was written to remove, with nothing anywhere
    # connecting the two. One line naming the missing identity is the difference between "this is
    # broken" and "this machine has not done the one-time step".
    #
    # Only for the app binary: the test harness runs this wrapper too, and a notice per test binary
    # would bury the output of `cargo test`.
    echo "sign-dev.sh: no \"$IDENTITY\" code-signing identity found, running unsigned — macOS will ask for your Keychain password again after every rebuild. CONTRIBUTING.md has the one-time fix." >&2
fi

exec "$BIN" "$@"
