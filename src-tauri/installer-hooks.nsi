; installer-hooks.nsi
; Registers / unregisters $INSTDIR\bin in HKCU PATH using only NSIS
; built-ins — no external plugins required.
;
; Also skips installing the bundled CodeMie CLI when one is already
; resolvable on PATH (EPMCDME-14581): NSIS_HOOK_PREINSTALL runs first and
; records the detection result in $ExistingCliFound; NSIS_HOOK_POSTINSTALL
; (same install Section, so the Var is still set) deletes the just-copied
; bundled runtime/CLI and skips the PATH write when an existing CLI was found.

Var ExistingCliFound

!macro NSIS_HOOK_PREINSTALL
  ; Detect a CodeMie CLI already on PATH that is NOT this app's own bundled
  ; bin dir. The bundled bin dir only matches during an upgrade/reinstall —
  ; at this point (before the File copy below) the previous install's files
  ; are still there, so excluding it stops a reinstall from being
  ; misdetected as "a foreign CLI exists" and wrongly deleting the fresh copy.
  ; $R0 = 0 means an existing (foreign) CLI was found.
  ExecWait 'powershell.exe -NoProfile -NonInteractive -Command \
    "$cmd = Get-Command codemie -ErrorAction SilentlyContinue | Select-Object -First 1; \
     if ($cmd -and ($cmd.Source -notlike $\"$INSTDIR\bin*$\")) { exit 0 } else { exit 1 }"' $R0
  StrCpy $ExistingCliFound $R0
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $ExistingCliFound == 0
    ; An existing CodeMie CLI takes precedence — remove the bundled
    ; runtime/CLI we just copied and leave PATH untouched (EPMCDME-14581).
    RMDir /r "$INSTDIR\bin"
    RMDir /r "$INSTDIR\node"
    RMDir /r "$INSTDIR\cli"
  ${Else}
    ; Read the current user PATH (may be empty on a fresh account).
    ReadRegStr $0 HKCU "Environment" "PATH"
    ; Append a semicolon only when PATH is non-empty.
    ${If} $0 != ""
      StrCpy $0 "$0;"
    ${EndIf}
    ; Write bin dir as REG_EXPAND_SZ (correct type for PATH).
    WriteRegExpandStr HKCU "Environment" "PATH" "$0$INSTDIR\bin"
    ; Broadcast WM_SETTINGCHANGE so open shells inherit the new PATH.
    SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove our entry from PATH via PowerShell (available on all supported Windows).
  ExecWait 'powershell.exe -NoProfile -NonInteractive -Command \
    "$p=[Environment]::GetEnvironmentVariable($\"PATH$\",$\"User$\"); \
     $p=($p.Split($\";\") | Where-Object { $_ -ne $\"$INSTDIR\bin$\" }) -join $\";\"; \
     [Environment]::SetEnvironmentVariable($\"PATH$\", $p, $\"User$\")"'
!macroend
