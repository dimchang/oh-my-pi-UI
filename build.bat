@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo  OMP Codex UI - Build & Package (portable)
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] node not found. Please install Node.js and add it to PATH.
  pause
  exit /b 1
)

echo [1/4] Type checking (tsc --noEmit)...
call npx tsc --noEmit -p tsconfig.json
if errorlevel 1 (
  echo [ERROR] Type check failed. Fix errors above and retry.
  pause
  exit /b 1
)

echo [2/4] Cleaning old release artifacts...
if exist release\win-unpacked rmdir /s /q release\win-unpacked
if exist release\*.7z del /q release\*.7z
if exist release\*.exe del /q release\*.exe

echo [3/4] Building with electron-vite...
call npx electron-vite build
if errorlevel 1 (
  echo [ERROR] electron-vite build failed.
  pause
  exit /b 1
)

echo [4/4] Packaging portable exe (electron-builder --win portable)...
call npx electron-builder --win portable
if errorlevel 1 (
  echo [ERROR] Packaging failed.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  DONE. Output:
for /f "delims=" %%v in ('node -p "require(\'./package.json\').version"') do set APPVER=%%v
echo  release\OMP Codex-%APPVER%-portable.exe
echo ============================================
pause
