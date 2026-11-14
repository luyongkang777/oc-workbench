@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0diag-shell.ps1"
echo.
echo === finished, window will stay open ===
pause
