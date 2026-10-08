; installer-hooks.nsi
; PATH registration is conditional (only when no system codemie exists) and is
; handled by the Tauri app itself on first launch (pathman::inject_bundled_bin_path),
; not by the installer. Uninstall must still remove that entry if it was added,
; otherwise it survives reinstalls and future uninstalls indefinitely.

!macro NSIS_HOOK_POSTINSTALL
  ; PATH registration removed — the app decides at runtime whether to persist it.
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove our entry from PATH via PowerShell (available on all supported Windows).
  ExecWait 'powershell.exe -NoProfile -NonInteractive -Command \
    "$p=[Environment]::GetEnvironmentVariable($\"PATH$\",$\"User$\"); \
     $p=($p.Split($\";\") | Where-Object { $_ -ne $\"$INSTDIR\bin$\" }) -join $\";\"; \
     [Environment]::SetEnvironmentVariable($\"PATH$\", $p, $\"User$\")"'
  ; Node and the CLI the app downloaded on first launch. Per-user, no admin.
  ; The user's own CodeMie config folder is not touched.
  ; Keep it on an in-place update: the download is ~200 MB.
  ; cmd rmdir, not NSIS RMDir /r: that prints all ~14k files to the details
  ; list and the uninstaller looks hung (users kill it mid-delete).
  StrCmp $UpdateMode 1 +3
  nsExec::Exec 'cmd.exe /d /c rmdir /s /q "$LOCALAPPDATA\CodeMie\runtime"'
  Pop $0
!macroend
