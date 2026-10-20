@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-local.ps1" -Action start -Mode online
set "NADO_START_EXIT=%ERRORLEVEL%"
if not "%NADO_START_EXIT%"=="0" pause
exit /b %NADO_START_EXIT%
