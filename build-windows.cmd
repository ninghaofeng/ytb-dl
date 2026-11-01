@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1
if not "%~2"=="" (
  echo Usage: build-windows.cmd [x64^|arm64^|all]
  pause
  exit /b 2
)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22+ is required. Install it from https://nodejs.org/ and retry.
  pause
  exit /b 1
)

node "%~dp0scripts\build-platform.mjs" win "%~1"
set "BUILD_EXIT=%ERRORLEVEL%"
if not "%BUILD_EXIT%"=="0" echo Build failed. See the error above.
pause
exit /b %BUILD_EXIT%
