@echo off
rem start.bat - one-click setup + launch for klawz-chat-ai (Windows).
rem Assumes nothing is installed. It will:
rem   1. Ensure Git and Node.js/npm exist (via winget if missing)
rem   2. Pull latest main from git
rem   3. Run npm install if needed (missing or out of date node_modules)
rem   4. Run npm run build if needed (missing or out of date dist/, dist-server/)
rem   5. Start the server (npm start) on http://localhost:3000
setlocal enabledelayedexpansion
pushd "%~dp0"

echo === klawz-chat-ai setup ===

rem --- 1. Git ---
where git >nul 2>&1
if errorlevel 1 (
  echo [1/5] Git not found, trying to install via winget...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo ERROR: git is missing and winget is not available.
    echo Please install Git manually from https://git-scm.com/download/win and re-run start.bat.
    pause
    exit /b 1
  )
  winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
  if errorlevel 1 (
    echo ERROR: automatic Git install failed. Install it manually from https://git-scm.com/download/win
    pause
    exit /b 1
  )
  rem Git installer updates PATH; pick it up for this session.
  set "PATH=%ProgramFiles%\Git\bin;%ProgramFiles%\Git\cmd;%PATH%"
  where git >nul 2>&1
  if errorlevel 1 (
    echo ERROR: git still not found after install. Close this window, open a new one, and re-run start.bat.
    pause
    exit /b 1
  )
)
for /f "delims=" %%v in ('git --version 2^>nul') do echo Found %%v

rem --- 2. Node.js + npm ---
where node >nul 2>&1
if errorlevel 1 goto :install_node
where npm >nul 2>&1
if errorlevel 1 goto :install_node
goto :node_ok

:install_node
echo [2/5] Node.js not found, trying to install LTS via winget...
where winget >nul 2>&1
if errorlevel 1 (
  echo ERROR: node/npm is missing and winget is not available.
  echo Please install Node.js LTS manually from https://nodejs.org/ and re-run start.bat.
  pause
  exit /b 1
)
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
  echo ERROR: automatic Node.js install failed. Install LTS manually from https://nodejs.org/
  pause
  exit /b 1
)
rem Node installer updates PATH; pick it up for this session.
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was installed but is not on PATH yet. Close this window, open a new one, and re-run start.bat.
  pause
  exit /b 1
)

:node_ok
for /f "delims=" %%v in ('node --version 2^>nul') do echo Found node %%v
for /f "delims=" %%v in ('npm --version 2^>nul') do echo Found npm %%v

rem --- 3. Pull latest main ---
echo [3/5] Updating to latest main...
if not exist ".git" (
  echo WARNING: no .git directory here, skipping git pull.
) else (
  git fetch origin main
  if errorlevel 1 (
    echo WARNING: git fetch failed ^(offline?^). Continuing with local files.
  ) else (
    rem Switch to main if we are on another branch, then fast-forward only.
    for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set CURRENT_BRANCH=%%b
    if not "!CURRENT_BRANCH!"=="main" (
      echo Currently on branch !CURRENT_BRANCH!, switching to main...
      git checkout main
      if errorlevel 1 (
        echo WARNING: could not switch to main. Continuing on !CURRENT_BRANCH!.
      )
    )
    git pull --ff-only origin main
    if errorlevel 1 (
      echo WARNING: git pull failed ^(diverged or local changes?^). Continuing with local files.
      echo         Commit or stash your changes, then run: git pull --ff-only origin main
    ) else (
      echo Up to date with origin/main.
    )
  )
)

rem --- 4. npm install (only if needed) ---
echo [4/5] Checking dependencies...
set NEED_INSTALL=0
if not exist "node_modules" set NEED_INSTALL=1
if not exist "node_modules\.package-lock.json" set NEED_INSTALL=1
if exist "package-lock.json" if exist "node_modules\.package-lock.json" (
  powershell -NoProfile -NonInteractive -Command "if ((Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item 'node_modules\.package-lock.json').LastWriteTime) { exit 1 } else { exit 0 }"
  if errorlevel 1 set NEED_INSTALL=1
)
if "%NEED_INSTALL%"=="1" (
  echo node_modules missing or out of date, running npm install...
  if exist "package-lock.json" (
    call npm ci
  ) else (
    call npm install
  )
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
) else (
  echo Dependencies look fresh, skipping npm install.
)

rem --- 5. Build (only if needed) ---
echo [5/5] Checking build output...
set NEED_BUILD=0
if not exist "dist-server\index.js" set NEED_BUILD=1
if not exist "dist\index.html" set NEED_BUILD=1
if "%NEED_BUILD%"=="0" (
  rem Rebuild if any source file is newer than the last build output.
  powershell -NoProfile -NonInteractive -Command "$out = Get-Item 'dist-server\index.js'; if (Get-ChildItem -Path 'src','index.html','vite.config.ts','package.json' -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $out.LastWriteTime }) { exit 1 } else { exit 0 }"
  if errorlevel 1 set NEED_BUILD=1
)
if "%NEED_BUILD%"=="1" (
  echo Build output missing or stale, running npm run build...
  call npm run build
  if errorlevel 1 (
    echo ERROR: build failed.
    pause
    exit /b 1
  )
) else (
  echo Build looks fresh, skipping npm run build.
)

rem --- 6. Start ---
echo.
echo Starting server on http://localhost:3000 ...
echo (Correct URL is http://localhost:3000 - port 5173 only works with "npm run dev:web".)
echo Press Ctrl+C to stop.
echo.
call npm start
set EXITCODE=%errorlevel%
echo.
echo Server exited with code %EXITCODE%.
pause
popd
endlocal
