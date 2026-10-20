@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-local.ps1" -Action stop
set "NADO_STOP_EXIT=%ERRORLEVEL%"
if not "%NADO_STOP_EXIT%"=="0" pause
exit /b %NADO_STOP_EXIT%
