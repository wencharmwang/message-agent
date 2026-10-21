@echo off
rem Message Agent one-click installer.
rem Put this file NEXT TO MessageAgent-*.zip (same folder), then double-click it.
rem It extracts the zip with the built-in tar (fast, long-path safe) and starts the installer.
setlocal enabledelayedexpansion
set "ZIP="
for %%f in ("%~dp0MessageAgent-*.zip") do set "ZIP=%%~ff"
if not defined ZIP (
  echo [!] MessageAgent-*.zip not found in this folder.
  echo     Put this file in the SAME folder as the zip, then run it again.
  pause
  exit /b 1
)
echo Found: %ZIP%
set "STAGE=%LOCALAPPDATA%\Programs\MessageAgent-pkg"
echo Extracting to %STAGE% ...
echo (this takes 2-5 minutes depending on disk - do NOT close this window)
if exist "%STAGE%" rmdir /s /q "%STAGE%"
mkdir "%STAGE%" 2>nul
tar -xf "%ZIP%" -C "%STAGE%"
if errorlevel 1 (
  echo [!] Extract failed.
  pause
  exit /b 1
)
set "PKGDIR="
for /d %%d in ("%STAGE%\MessageAgent-*") do set "PKGDIR=%%d"
if not defined PKGDIR (
  echo [!] Unexpected package layout inside zip.
  pause
  exit /b 1
)
echo Starting the installer...
powershell -NoProfile -ExecutionPolicy Bypass -File "%PKGDIR%\install.ps1"
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" rmdir /s /q "%STAGE%"
if not "%RC%"=="0" pause
endlocal
