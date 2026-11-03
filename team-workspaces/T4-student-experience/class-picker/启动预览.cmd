@echo off
setlocal
cd /d "%~dp0"
set "PICKER_NODE="
for /f "delims=" %%I in ('where node.exe 2^>nul') do if not defined PICKER_NODE set "PICKER_NODE=%%I"
if not defined PICKER_NODE if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" set "PICKER_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not defined PICKER_NODE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "PICKER_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not defined PICKER_NODE (
  echo Node.js 20.11+ is required. Install Node.js or use the DSH plugin package.
  pause
  exit /b 1
)
echo Open the full URL printed below in your browser. Keep this window open.
"%PICKER_NODE%" dev-server.mjs
pause
