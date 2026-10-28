@echo off
rem Permite in firewall-ul Windows conexiunile media pentru apelurile NEXUS CHAT.
rem Regulile sunt limitate la programul livekit-server.exe si la porturile media
rem (UDP 7882, TCP 7881); nimic altceva de pe calculator nu devine accesibil.
rem Se ruleaza O SINGURA DATA, cu clic dreapta -> "Run as administrator".
rem Eliminare: allow-calls-firewall.cmd /remove   (tot ca administrator)
setlocal
set "EXE=%LOCALAPPDATA%\NexusChat\livekit\livekit-server.exe"

net session >nul 2>nul
if errorlevel 1 (
  echo Acest script trebuie rulat ca administrator: clic dreapta pe fisier, "Run as administrator".
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="NEXUS CHAT apeluri UDP" >nul 2>nul
netsh advfirewall firewall delete rule name="NEXUS CHAT apeluri TCP" >nul 2>nul
if /i "%~1"=="/remove" (
  echo Regulile NEXUS CHAT pentru apeluri au fost eliminate.
  pause
  exit /b 0
)

if not exist "%EXE%" (
  echo Nu gasesc %EXE%
  echo Instaleaza intai serverul media LiveKit, apoi ruleaza din nou acest script.
  pause
  exit /b 1
)

netsh advfirewall firewall add rule name="NEXUS CHAT apeluri UDP" dir=in action=allow protocol=UDP localport=7882 program="%EXE%" profile=any
netsh advfirewall firewall add rule name="NEXUS CHAT apeluri TCP" dir=in action=allow protocol=TCP localport=7881 program="%EXE%" profile=any
echo.
echo Gata. Apelurile NEXUS pot primi audio-video din internet (doar livekit-server.exe, porturile 7881/7882).
pause
