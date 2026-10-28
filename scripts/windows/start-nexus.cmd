@echo off
rem Porneste serverul NEXUS CHAT si il reporneste automat daca se opreste.
rem Folosit de pornirea automata (install-autostart.cmd); poate fi rulat si manual.
rem Jurnal: %LOCALAPPDATA%\NexusChat\logs\server.log
setlocal
set "ROOT=%~dp0..\.."

rem Node.js instalat fara drepturi de administrator (arhiva zip in profilul utilizatorului).
for /d %%D in ("%LOCALAPPDATA%\Programs\node-v24*") do set "NODEDIR=%%D"
if defined NODEDIR set "PATH=%NODEDIR%;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nu a fost gasit. Instaleaza Node 24 si incearca din nou.
  exit /b 1
)

set "LOGDIR=%LOCALAPPDATA%\NexusChat\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
title NEXUS CHAT server

:loop
rem Un server media ramas de la o oprire brusca ar tine porturile ocupate.
taskkill /f /im livekit-server.exe >nul 2>nul
echo [%date% %time%] pornire server >> "%LOGDIR%\server.log"
node "%ROOT%\server\src\main.ts" >> "%LOGDIR%\server.log" 2>&1
echo [%date% %time%] serverul s-a oprit (cod %errorlevel%), repornesc in 15 s >> "%LOGDIR%\server.log"
timeout /t 15 /nobreak >nul
goto loop
