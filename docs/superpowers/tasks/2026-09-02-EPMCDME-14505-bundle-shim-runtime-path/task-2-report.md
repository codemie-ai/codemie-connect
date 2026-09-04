DONE

commit: 8320129
changed paths:
- assets/windows/bin/codemie.cmd
- ui/test/shim.test.mjs

test command: npm test

summary:
Rewrote assets/windows/bin/codemie.cmd to invoke the bundled Node runtime
(%BUNDLE_DIR%\node\node.exe) against the CLI entry point
(%BUNDLE_DIR%\cli\node_modules\@codemieai\code\bin\codemie.js) using
%~dp0.. as the install root, so no product name or hardcoded path is
embedded. Added exit /b %ERRORLEVEL% for correct exit code propagation.

Created ui/test/shim.test.mjs with 5 tests (TDD: RED -> GREEN verified).
All 24 tests pass (24/24). Smoke test against staged tree printed 0.14.1.
