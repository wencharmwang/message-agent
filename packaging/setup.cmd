@echo off
rem Message Agent one-click installer.
rem Put this file NEXT TO MessageAgent-*.zip (same folder), then double-click it.
rem It extracts the zip with the built-in tar (fast, long-path safe) and starts the installer.
setlocal enabledelayedexpansion
rem 同一目录里可能同时躺着全量包和升级小包（MessageAgent-app-*.zip）。
rem 通配取"最后一个"会随手抓到升级包 —— 那个包装在新机器上会直接失败
rem（没有可沿用的引擎/运行时）。所以显式跳过名字里带 -app- 的。
set "ZIP="
for %%f in ("%~dp0MessageAgent-*.zip") do (
  set "NAME=%%~nf"
  if /i "!NAME:-app-=!"=="!NAME!" set "ZIP=%%~ff"
)
if not defined ZIP (
  echo [!] MessageAgent-*.zip not found in this folder.
  echo     Put the FULL package zip in the SAME folder as this file, then run it again.
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
