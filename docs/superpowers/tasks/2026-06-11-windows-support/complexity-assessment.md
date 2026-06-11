# Complexity Assessment: windows tauri cross-platform installer pty-terminal bundling

**Task**: Add a Windows target to the macOS-only Tauri installer so identical UI/UX runs on Windows, porting platform-specific backend behavior (shell, PATH, downloads, elevation, logging, bundle) without regressing macOS.
**Generated**: 2026-06-11

---

## Dimension Scores

| Dimension            | Score | Label    |
|----------------------|-------|----------|
| Component Scope      | 5     | XL       |
| Requirements Clarity | 4     | L        |
| Technical Risk       | 5     | XL       |
| File Change Estimate | 5     | XL       |
| Dependencies         | 4     | L        |
| Affected Layers      | 5     | XL       |

**Total: 28/36 — XL**

---

## Key Reasoning

- **Component Scope (XL)**: ~6 Rust command modules (`runner`, `pty`, `pathman`, `inspector`, `installer`, `logger`) plus `lib.rs` startup, `Cargo.toml`, `tauri.conf.json`, a Windows `steps.yaml`, and frontend strings — with two new abstractions (Windows elevation, registry PATH).
- **Technical Risk (XL)**: No `cfg` precedent in repo; elevation model (per-op UAC vs full-process relaunch+resume) is novel and unresolved; PATH is a structural registry reimplementation; Windows half cannot be validated on this macOS box (CI required). Raw L bumped to XL for elevation/UAC security-sensitivity.
- **File Change Estimate (XL)**: 12–15 files modified, ~2–6 new (Windows `steps.yaml`, elevation/registry code), spanning backend, build, and frontend.
- **Affected Layers (XL)**: Distinct tiers — Service/backend (heavy), UI (minor strings), Build-Infra (NSIS/MSI bundle + Windows CI runner + WebView2), External (Node/Git downloads), and persistence-like registry writes.
- **Requirements Clarity (L)**: Goal clear with strong Python reference; raw M bumped to L — elevation model is an open ("TBD") design decision that can swing scope.
- **Red flags applied**: Security/UAC bumped Technical Risk (M→XL via novelty+security); open elevation design bumped Requirements Clarity (M→L). No "new external service" (downloads pre-exist) and no "migrate/refactor" (additive port).

---

## Routing

SPLIT REQUIRED

## Splitting Recommendation

- **By layer**: Land the build/bundle + target-gated deps foundation first (`Cargo.toml` `cfg(windows)` deps, `tauri.conf.json` NSIS/MSI, Windows CI runner, WebView2), then the command-layer ports, then frontend string cleanup.
- **By feature**: Establish the `cfg`-gated command pattern on low-risk files first (`runner`, `pty` shell string, `inspector` `/dev/null`→`NUL`, `logger`), then tackle the two novel subsystems (registry PATH, elevation) as dedicated stories.
- **By dependency**: Reimplement PATH (registry `HKCU\Environment` + `WM_SETTINGCHANGE`) as a standalone story before the installer story that relies on a usable PATH.
- **By phase**: Read/probe path first (inspector + PATH read), then write path (PATH persistence, installer downloads, elevation) which carries the irreversible/elevation risk.

> XL: Splitting is strongly recommended. Provide decomposed stories or confirm you want to proceed as-is.
