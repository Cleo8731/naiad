; Extra steps for the Windows installer, so that a terminal knows the `naiad` command.
;
; After an install: the small terminal program (built as naiad-cli.exe) is put in a
; `bin` folder inside the install folder, under the name naiad.exe, and that folder
; is added to the user's PATH. Before an uninstall: both are undone.
;
; The PATH is not changed by this script, because an installer script cuts a long
; text short when it reads one. The program changes it itself, reading it whole
; (src/bin/naiad-cli.rs, "The user's PATH"). If that step fails, the install still
; finishes; only the short command is missing, and the program still runs by its
; full path.

!macro NSIS_HOOK_POSTINSTALL
  ; The installer has just put naiad-cli.exe beside the app (it installs every
  ; program of the project); it is moved, so that it exists once.
  CreateDirectory "$INSTDIR\bin"
  Delete "$INSTDIR\bin\naiad.exe"
  Rename "$INSTDIR\naiad-cli.exe" "$INSTDIR\bin\naiad.exe"
  nsExec::Exec '"$INSTDIR\bin\naiad.exe" --add-to-path'
  Pop $0
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; An update runs the old uninstaller first and then installs again: the PATH is
  ; left as it is, and only the program is replaced.
  ${If} $UpdateMode <> 1
    nsExec::Exec '"$INSTDIR\bin\naiad.exe" --remove-from-path'
    Pop $0
  ${EndIf}
  Delete "$INSTDIR\bin\naiad.exe"
  RMDir "$INSTDIR\bin"
!macroend
