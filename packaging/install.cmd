@echo off
rem Install Message Agent: double-click this file.
rem Equivalent to right-click install.ps1 > "Run with PowerShell",
rem but immune to execution-policy and -Command path quirks.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 pause
