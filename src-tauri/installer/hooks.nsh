; Custom NSIS hooks for the CodeFlow installer/uninstaller.
;
; Install side needs no hook at all: CodeFlow itself creates its directories on first launch via
; `paths::ensure_dirs()` (`std::fs::create_dir_all`, a no-op if they already exist) — so a previous
; install's data is picked up automatically with zero installer-side logic, and a fresh machine gets
; fresh directories the same way.
;
; ---------------------------------------------------------------------------------------------
; What changed in v1.19, and why this file is longer than it was
;
; It used to be one question and one `RMDir /r "C:\CodeFlow"`, and that had four problems:
;
;   1. `C:\CodeFlow` was machine-wide. The NSIS package is a per-user install (tauri's default
;      `installMode`, unset here), so an uninstall by one Windows account deleted every account's
;      database, settings and password vault. That is the bug the whole v1.19 layout change exists
;      to fix.
;   2. The prompt claimed to delete "saved configuration, credentials, and data", and it did delete
;      the user's cloned repositories and every encrypted backup, which it never mentioned. Those
;      live under `%USERPROFILE%\CodeFlow` now and this file does not touch them at any price.
;   3. `targets: "all"` in tauri.conf.json ships an MSI as well as this, and the updater manifest
;      resolves `windows-x86_64` to the MSI. A user can therefore have both installed, at different
;      locations, with separate uninstall entries — and uninstalling one used to offer to delete the
;      data the other one is still using.
;   4. This macro runs inside `Section Uninstall`, which a *manual version upgrade* also executes:
;      the reinstall page preselects "Uninstall before installing" and runs the old uninstaller
;      through `ExecWait`. So every user upgrading by downloading the new .exe was shown "delete my
;      data?" mid-upgrade, with nothing on screen saying it was an upgrade.
;
; The app data now lives at %LOCALAPPDATA%\CodeFlow, per user, which `$LOCALAPPDATA` names directly.
; The old fixed path was never really about being fixed — it was about being expressible here, and
; both are.
; ---------------------------------------------------------------------------------------------

!macro NSIS_HOOK_POSTUNINSTALL
  ; Problem 4. `$UpdateMode` is declared and set by tauri's own template before this hook is
  ; inserted, and the template's own app-data deletion twelve lines earlier is gated the same way:
  ; `${If} $DeleteAppDataCheckboxState = 1 ${AndIf} $UpdateMode <> 1`. Without this, an upgrade
  ; offers to destroy the vault it is about to hand to the new version.
  ${If} $UpdateMode <> 1

    ; Problem 3. Tauri's NSIS template keys its uninstall entry on the *product name*, not the
    ; bundle identifier: `!define UNINSTKEY "…\Uninstall\${PRODUCTNAME}"`. Reading
    ; `Uninstall\com.codeflow.app` — the obvious guess — always returns "", so the guard never
    ; fires and the prompt is always shown. The current uninstaller has already removed its own copy
    ; of this key by the time POSTUNINSTALL runs, so what is left is genuinely another install.
    ;
    ; The MSI is not detectable this way and deliberately not attempted: WiX registers under a
    ; product-code GUID, so no literal key name can find it. That is what `/SD IDNO` and the
    ; conservative wording are for — this asks, and a user who has both is asked about a folder the
    ; prompt names.
    StrCpy $R0 "0"
    ReadRegStr $R1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodeFlow" "DisplayName"
    ${If} $R1 != ""
      StrCpy $R0 "1"
    ${EndIf}
    ReadRegStr $R1 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodeFlow" "DisplayName"
    ${If} $R1 != ""
      StrCpy $R0 "1"
    ${EndIf}

    ${If} $R0 == "0"
      ; This account's own app data. Everything the app owns and can recreate; nothing the user
      ; authored outside it.
      ;
      ; The AI completion models are named explicitly, and they have to be: `RMDir /r` takes
      ; `models\` with everything else, and that subdirectory alone can be eight gigabytes the user
      ; waited twenty minutes for. "Database, settings and password vault" sounds like kilobytes.
      ; Understating what a delete takes is precisely the bug the rest of this file exists to fix —
      ; see problem 2 above — so a new multi-gigabyte thing under this root gets its own clause
      ; rather than being quietly covered by the old wording.
      ;
      ; `/SD IDNO` goes *after* the text, never before it. That is not a style preference and it is
      ; what broke the first Windows bundle built from this file: the grammar is
      ; `MessageBox mode messagebox_text [/SD return] [return_check label [return_check2 label2]]`,
      ; and makensis reads the text from token 2 unconditionally. With `/SD` sitting there the
      ; message became the literal string "/SD", the real message became a jump label, and the two
      ; ID/label pairs became one pair too many — so it printed its usage and aborted the whole NSIS
      ; bundle, on a line number inside the *generated* installer that names nothing in this file.
      ${If} ${FileExists} "$LOCALAPPDATA\CodeFlow\*.*"
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
          "Delete CodeFlow's database, settings and password vault?$\n$\n\
           Location: $LOCALAPPDATA\CodeFlow$\n$\n\
           This also deletes any AI autocomplete models you downloaded, which can be several \
           gigabytes.$\n$\n\
           This does NOT delete your cloned repositories or your backups. Those are in \
           $PROFILE\CodeFlow and will be left alone.$\n$\n\
           Passwords saved in Windows Credential Manager are also left alone; remove them there if \
           you want them gone." \
          /SD IDNO IDYES codeflow_delete_data IDNO codeflow_data_done
        codeflow_delete_data:
          RMDir /r "$LOCALAPPDATA\CodeFlow"
      ${EndIf}
      codeflow_data_done:

      ; The pre-v1.19 directory, asked about separately and last.
      ;
      ; Separate because it is a different question with a different answer: this path is
      ; machine-wide, so on a shared PC it may be the only copy another account still has. Never
      ; deleted wholesale for that reason and for one more — on a machine that upgraded, it is where
      ; `repos\` and `Backups\` live. Only the database copies the migration renamed out of the way
      ; are offered.
      ;
      ; The wildcard is `codeflow.db*.migrated-*` and the `*` before `.migrated-` is load-bearing:
      ; the migration renames the WAL to `codeflow.db.migrated-<date>-wal`, and a WAL holds the most
      ; recently written pages verbatim — including the vault columns this schema stores in the
      ; clear. Leaving it in a machine-wide folder is the exposure this release exists to end.
      ${If} ${FileExists} "C:\CodeFlow\codeflow.db*.migrated-*"
        MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
          "Also delete the pre-upgrade copy of the database left in C:\CodeFlow?$\n$\n\
           It contains an older snapshot of everything, including your password vault.$\n$\n\
           Everything else in that folder — including any repositories and backups, and anything \
           belonging to other Windows accounts — is left alone." \
          /SD IDNO IDYES codeflow_delete_legacy IDNO codeflow_legacy_done
        codeflow_delete_legacy:
          Delete "C:\CodeFlow\codeflow.db*.migrated-*"
          Delete "C:\CodeFlow\MIGRATED.txt"
      ${EndIf}
      codeflow_legacy_done:
    ${EndIf}

  ${EndIf}
!macroend
