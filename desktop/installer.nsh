; Runs inside the installer (it already has administrator rights).
; Opens the POS ports for the phones on the Private network profile.
!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe POS"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Cafe POS" dir=in action=allow protocol=TCP localport=80,8080 profile=private'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Cafe POS"'
!macroend
