@echo off
chcp 65001 >nul 2>&1
REM ===== Double-click to auto-commit the directory containing this script =====
REM Commit message is fixed to "auto commit". If no git repo here, git init first.

cd /d "%~dp0"

REM 1. If there is no .git, init one and write a minimal .gitignore
if not exist ".git" (
    echo [auto-commit] No git repo found, initializing...
    git init >nul 2>&1
    if not exist ".gitignore" (
        echo node_modules/ > .gitignore
        echo .workbuddy/ >> .gitignore
        echo .temp/ >> .gitignore
        echo .qoder/ >> .gitignore
        echo. >> .gitignore
        echo # one-off debug probes >> .gitignore
        echo probe-*.mjs >> .gitignore
    )
)

REM 2. Stage all changes (respecting .gitignore)
git add -A

REM 3. Skip if there is nothing to commit
git diff --cached --quiet
if %errorlevel% == 0 (
    echo [auto-commit] Nothing to commit, skipped.
    goto :end
)

REM 4. Commit
git commit -m "auto commit"
echo [auto-commit] Committed: auto commit

:end
echo.
echo Press any key to close...
pause >nul
