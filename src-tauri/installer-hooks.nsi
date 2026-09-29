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

!macro NSIS_HOOK_PREINSTALL
  ; Silently uninstall a prior install (if any) before proceeding, so nothing
  ; is left registered to trigger the NSIS "Already Installed" dialog.
  ; SHCTX resolves to the hive matching this app's installMode ("currentUser"
  ; -> HKCU). PRODUCTNAME is Tauri's default uninstall registry subkey name;
  ; confirm the exact key/hive against a real built installer during the
  ; manual Windows install-then-upgrade smoke verification (no NSIS test
  ; harness exists in this repo to check it automatically).
  ReadRegStr $0 SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCTNAME}" "UninstallString"
  StrCmp $0 "" done
  ExecWait '$0 /S' $1
  StrCmp $1 "0" done
  Abort "Failed to uninstall the previous version (exit code $1). Please uninstall it manually and try again."
  done:
!macroend
