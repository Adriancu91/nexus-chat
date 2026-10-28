@echo off
rem Porneste serverul NEXUS CHAT automat la autentificarea utilizatorului in Windows.
rem Fara drepturi de administrator: adauga un lansator in folderul Startup al utilizatorului.
rem Dezinstalare: install-autostart.cmd /remove
setlocal
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "LAUNCHER=%STARTUP%\NexusChat-server.cmd"

if /i "%~1"=="/remove" (
  if exist "%LAUNCHER%" del "%LAUNCHER%"
  echo Pornirea automata NEXUS a fost eliminata.
  exit /b 0
)

> "%LAUNCHER%" echo @echo off
>> "%LAUNCHER%" echo rem Lansator NEXUS CHAT (creat de install-autostart.cmd)
>> "%LAUNCHER%" echo start "NEXUS CHAT server" /min "%~dp0start-nexus.cmd"
echo Pornire automata instalata: %LAUNCHER%
echo Serverul porneste la urmatoarea autentificare (fereastra minimizata "NEXUS CHAT server").
