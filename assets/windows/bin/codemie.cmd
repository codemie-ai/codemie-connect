@echo off
set BUNDLE_DIR=%~dp0..
"%BUNDLE_DIR%\node\node.exe" "%BUNDLE_DIR%\cli\node_modules\@codemieai\code\dist\index.js" %*
