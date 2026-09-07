; installer-hooks.nsi
; Registers / unregisters $INSTDIR\bin in HKCU PATH using only NSIS
; built-ins — no external plugins required.

!macro NSIS_HOOK_POSTINSTALL
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
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Remove our entry from PATH via PowerShell (available on all supported Windows).
  ExecWait 'powershell.exe -NoProfile -NonInteractive -Command \
    "$p=[Environment]::GetEnvironmentVariable($\"PATH$\",$\"User$\"); \
     $p=($p.Split($\";\") | Where-Object { $_ -ne $\"$INSTDIR\bin$\" }) -join $\";\"; \
     [Environment]::SetEnvironmentVariable($\"PATH$\", $p, $\"User$\")"'
!macroend
