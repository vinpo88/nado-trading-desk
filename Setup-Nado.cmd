@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-local.ps1" %*
set "NADO_SETUP_EXIT=%ERRORLEVEL%"
pause
exit /b %NADO_SETUP_EXIT%
