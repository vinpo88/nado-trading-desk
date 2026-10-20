@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\manage-registration.ps1" -Action setup
set "NADO_REGISTRATION_EXIT=%ERRORLEVEL%"
if not "%NADO_REGISTRATION_EXIT%"=="0" pause
exit /b %NADO_REGISTRATION_EXIT%
