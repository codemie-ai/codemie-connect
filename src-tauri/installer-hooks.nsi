; installer-hooks.nsi
; Disabled PATH registration — codemie binary is no longer added to HKCU PATH.

!macro NSIS_HOOK_POSTINSTALL
  ; PATH registration removed
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; PATH unregistration removed
!macroend
