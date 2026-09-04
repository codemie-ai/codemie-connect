@echo off
:: CodeMie CLI shim. Runs the bundled Node runtime against the bundled CLI tree.
:: %~dp0.. is the install root, so this file is correct regardless of where
:: the product is installed and needs no update if productName changes.
setlocal
set "BUNDLE_DIR=%~dp0.."
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\bin\codemie.js" %*
exit /b %ERRORLEVEL%
