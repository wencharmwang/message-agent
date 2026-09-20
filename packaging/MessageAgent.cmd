@echo off
rem 双击这个文件就能用：没在运行就启动，然后打开页面。
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -Open
if errorlevel 1 pause
