@echo off
setlocal

rem Builds the extension into a .vsix package in the repository root.
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo npm was not found on PATH. Install Node.js first.
    exit /b 1
)

if not exist node_modules (
    echo Installing dependencies...
    call npm ci
    if errorlevel 1 goto :fail
)

echo Packaging extension...
call npm run package
if errorlevel 1 goto :fail

echo.
echo Done. Package(s) created:
dir /b *.vsix
exit /b 0

:fail
echo.
echo Build failed.
exit /b 1
