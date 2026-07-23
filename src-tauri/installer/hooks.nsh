; Custom NSIS hooks for the CodeFlow installer/uninstaller.
;
; Install side needs no hook at all: CodeFlow itself creates C:\CodeFlow on first launch via
; `paths::ensure_dirs()` (`std::fs::create_dir_all`, a no-op if it already exists) — so a
; previous install's config/credentials/MD files/skills are picked up automatically with zero
; installer-side logic, and a fresh machine gets a fresh directory the same way.
;
; Uninstall asks whether to keep or wipe that directory, since it holds the SQLite DB, workspace
; MD/skill files and (via the OS keychain, untouched here) references to saved credentials.

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} ${FileExists} "C:\CodeFlow\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION "Delete CodeFlow's saved configuration, credentials, and data in C:\CodeFlow?$\n$\nChoose No to keep them for the next time you install CodeFlow." IDYES codeflow_delete_data IDNO codeflow_keep_data
    codeflow_delete_data:
      RMDir /r "C:\CodeFlow"
      Goto codeflow_data_done
    codeflow_keep_data:
    codeflow_data_done:
  ${EndIf}
!macroend
