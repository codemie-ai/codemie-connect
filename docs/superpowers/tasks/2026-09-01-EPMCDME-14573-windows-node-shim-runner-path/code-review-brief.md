# Code review — 2026-09-01-EPMCDME-14573-windows-node-shim-runner-path (2026-09-02)

**approve** · confidence: high · 0 blocking · 9 resolved · 0 deferred
Coverage: targeted verifier ✓  (9/9 prior findings graded)

No blocking findings — all 9 prior blocking findings from code-review-final.json are resolved.

## Finding status

- CR-001 resolved — probe_with_bin closure tries d then d/bin/; both exe and resource_dir branches use it
- CR-002 resolved — persist() called under #[cfg(windows)] after set_var; errors surface via log::warn!
- CR-003 resolved — three probe_dir() tests in tests_windows_probe replace the tautological existence check
- CR-004 resolved — line 3 comment updated to cmd.exe /c
- CR-005 resolved — self_update_direct() extracted and tested via error path; success path deferred to stage-7
- CR-006 resolved — log::warn! names the specific missing path before falling back to shim
- CR-007 resolved — SAFETY comment cites Tauri 2.x setup() threading guarantee and relocation guidance
- CR-008 resolved — eprintln! replaced with log::error! with explanatory comment
- CR-009 resolved — decision made (defer to EPMCDME-14505); NOTE comment in lib.rs documents the fallback

## Carried forward

commit-format ✓ · code-quality na · security na · 2 deferred → code-review-deferred.md
