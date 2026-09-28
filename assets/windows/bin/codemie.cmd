@echo off
:: CodeMie CLI shim. Runs the bundled Node runtime against the bundled CLI tree.
:: %~dp0.. is the install root, so this file is correct regardless of where
:: the product is installed and needs no update if productName changes.
setlocal
set "BUNDLE_DIR=%~dp0.."
if not exist "%BUNDLE_DIR%\node\node.exe" (
    echo error: bundled node runtime not found: %BUNDLE_DIR%\node\node.exe 1>&2
    exit /b 1
)
if not exist "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\bin\codemie.js" (
    echo error: bundled CLI entry not found: %BUNDLE_DIR%\cli\node_modules\@codemieai\code\bin\codemie.js 1>&2
    exit /b 1
)
:: Agent installs and every uninstall shell out to `npm` by name, so the bundled
:: npm.cmd has to be findable. It sits next to node.exe, a directory kept off the
:: user's own PATH on purpose, so it is added here instead: only for this process
:: tree (setlocal), and appended, so a user's own npm still wins.
:: The `if defined` guard keeps an empty PATH from becoming a leading ";",
:: which resolves to the current directory.
if defined PATH (set "PATH=%PATH%;%BUNDLE_DIR%\node") else (set "PATH=%BUNDLE_DIR%\node")

"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\bin\codemie.js" %*
exit /b %ERRORLEVEL%
