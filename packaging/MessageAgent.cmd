@echo off
rem Launch Message Agent: start it if not running, then open the page.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Open
if errorlevel 1 pause
