@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-registration.ps1" -Action status
set "NADO_REGISTRATION_EXIT=%ERRORLEVEL%"
pause
exit /b %NADO_REGISTRATION_EXIT%
