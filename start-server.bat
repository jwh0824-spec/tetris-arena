@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo [Tetris Arena] Node.js is not installed.
  echo Install it from https://nodejs.org then run this file again.
  pause
  exit /b 1
)
cd /d "%~dp0"
echo [Tetris Arena] Starting local multiplayer server...
echo Closing this window stops the server and disconnects everyone.
echo.
node server.js
pause
