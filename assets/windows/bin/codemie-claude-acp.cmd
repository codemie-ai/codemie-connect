@echo off
:: CodeMie CLI shim. Node and the CLI tree are not in the app: it downloads them
:: on first launch (src-tauri/src/commands/runtime.rs) into a folder named by
:: runtime-key, which scripts/pack-runtime.ps1 writes next to this file.
setlocal
set "KEY="
if exist "%~dp0runtime-key" set /p KEY=<"%~dp0runtime-key"
set "RT=%LOCALAPPDATA%\CodeMie\runtime\%KEY%"
if not defined KEY goto notready
if not exist "%RT%\.complete" goto notready
:: Agent installs and every uninstall shell out to `npm` by name, so the
:: runtime's npm.cmd has to be findable. It sits next to node.exe, a directory kept
:: off the user's own PATH on purpose, so it is added here instead: only for this
:: process tree (setlocal), and appended, so a user's own npm still wins.
:: The `if defined` guard keeps an empty PATH from becoming a leading ";",
:: which resolves to the current directory.
if defined PATH (set "PATH=%PATH%;%RT%\node") else (set "PATH=%RT%\node")

:: The app ships this one file under every command name the CLI declares
:: (codemie, codemie-claude, ...), the way npm would; the name it runs as picks
:: the CLI entry point.
set "NAME=%~n0"
set "ENTRY=%NAME%.js"
if /i "%NAME%"=="codemie" set "ENTRY=codemie.js"
if /i "%NAME%"=="codemie-code" set "ENTRY=agent-executor.js"
set "ENTRY=%RT%\cli\node_modules\@codemieai\code\bin\%ENTRY%"
if not exist "%ENTRY%" (
  echo %NAME%: this CodeMie CLI has no such command. 1>&2
  exit /b 127
)
"%RT%\node\node.exe" "%ENTRY%" %*
exit /b %ERRORLEVEL%

:notready
echo CodeMie is not set up yet. Open CodeMie Connect once to finish setting it up. 1>&2
exit /b 1
