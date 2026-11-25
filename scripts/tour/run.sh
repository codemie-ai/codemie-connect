#!/usr/bin/env bash
# `make tour` (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 9): builds the
# tour debug app when sources changed, seeds a fresh test root, runs the tour app in the
# background with the environment that keeps it offline and off the user's own screen (design
# § 2), writes the HTML report, and exits with the app's own code.
#
# Usage: scripts/tour/run.sh [--dry-run] [--only <value>]
#   --dry-run  prints the build command, the run folder and the full launch environment (one
#              KEY=value line each), then exits 0 without building or launching anything.
#   --only     the stops to run (CODEMIE_TOUR): "all", rollout steps ("0,3,7") or stop ids
#              ("T05,T21"). Defaults to "all".
#
# CODEMIE_TOUR_FAKE_BIN (test seam, never set by `make tour`): when set, the build and the seed
# are skipped and this path is launched instead of the real debug binary, so tests can drive the
# launch/watchdog/cleanup machinery below without a real cargo build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

ONLY="all"
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --only)
      if [[ $# -lt 2 ]]; then
        echo "--only needs a value." >&2
        exit 3
      fi
      ONLY="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 3
      ;;
  esac
done

TMPDIR="${TMPDIR:-/tmp}"
TMPDIR="${TMPDIR%/}"
mkdir -p "$TMPDIR"
LOCK="$TMPDIR/connect-tour.lock"
OWNER_FILE="$LOCK/owner"

# Atomic: mkdir fails if the lock already exists (design § 9 step 1). $TMPDIR itself was just
# made sure to exist above, so a failure here only ever means the lock is already held, or a
# stale one (left by a SIGKILL or a power loss) is still sitting there.
acquire_lock() {
  if mkdir "$LOCK" 2>/dev/null; then
    echo "$$ run.sh" > "$OWNER_FILE" 2>/dev/null || true
    return 0
  fi
  # No recorded owner: treat as held rather than guess (a bare/legacy lock).
  if [[ ! -f "$OWNER_FILE" ]]; then
    return 1
  fi
  local owner_pid
  owner_pid="$(cut -d' ' -f1 "$OWNER_FILE" 2>/dev/null || true)"
  if [[ -n "$owner_pid" ]] && ps -p "$owner_pid" -o command= 2>/dev/null | grep -q 'run\.sh'; then
    return 1
  fi
  echo "CODEMIE_TOUR: the lock's owner (PID ${owner_pid:-unknown}) is gone; taking over a stale lock." >&2
  rm -rf "$LOCK"
  mkdir "$LOCK" 2>/dev/null || return 1
  echo "$$ run.sh" > "$OWNER_FILE" 2>/dev/null || true
  return 0
}

if ! acquire_lock; then
  echo "Another tour is running." >&2
  exit 3
fi

# From here on this process owns the lock, and once launched, the app process and its watchdog
# it started. All are released on any exit, including a signal, so a tour never leaves any of
# them behind.
pid=""
watchdog=""
cleanup() {
  # A trap handler must not abort partway through on its own failure (a race where the app or
  # the watchdog already exited between the check and here), or the lock would never come off.
  set +e
  if [[ -n "$watchdog" ]]; then
    kill "$watchdog"
    wait "$watchdog" 2>/dev/null
  fi
  if [[ -n "$pid" ]]; then
    kill "$pid"
    sleep 1
    kill -9 "$pid"
    wait "$pid" 2>/dev/null
  fi
  rm -rf "$LOCK"
}
trap cleanup EXIT

SHA="$(git rev-parse --short HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  SHA="${SHA}+dirty"
fi

STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ "$DRY_RUN" -eq 1 ]]; then
  # Nothing is created on disk for a dry run, so this folder name is illustrative only: a real
  # run's actual folder gets a random suffix from mktemp (below), never this exact path.
  RUN="$TMPDIR/connect-tour-$STAMP"
  HOME_DIR="$RUN/home"
  TEST_DIR="$RUN/workspace"
  echo "Build: cd src-tauri && CARGO_TARGET_DIR=target/tour cargo build --features tour"
  echo "Run folder: $RUN"
  echo "HOME=$HOME_DIR"
  echo "CFFIXED_USER_HOME=$HOME_DIR"
  echo "HTTPS_PROXY=http://127.0.0.1:9"
  echo "HTTP_PROXY=http://127.0.0.1:9"
  echo "ALL_PROXY=http://127.0.0.1:9"
  echo "NO_PROXY="
  echo "GIT_ALLOW_PROTOCOL=file"
  echo "PATH=/usr/bin:/bin:/usr/sbin:/sbin"
  echo "CODEMIE_WORKSPACE_TEST_DIR=$TEST_DIR"
  echo "CODEMIE_TOUR=$ONLY"
  echo "CODEMIE_TOUR_SHA=$SHA"
  exit 0
fi

export PATH="$HOME/.cargo/bin:$PATH"

# A fresh, uniquely-created root (never a reused or guessed path): the safety rule this tour runs
# under is that it refuses to start unless its root came from mktemp.
RUN="$(mktemp -d "$TMPDIR/connect-tour-$STAMP-XXXXXX")"
HOME_DIR="$RUN/home"
TEST_DIR="$RUN/workspace"

if [[ -n "${CODEMIE_TOUR_FAKE_BIN:-}" ]]; then
  BIN="$CODEMIE_TOUR_FAKE_BIN"
else
  echo "CODEMIE_TOUR: building (target/tour, --features tour)..."
  (cd "$REPO_ROOT/src-tauri" && CARGO_TARGET_DIR=target/tour cargo build --features tour)

  echo "CODEMIE_TOUR: seeding $TEST_DIR ..."
  node "$REPO_ROOT/scripts/tour/seed.mjs" "$TEST_DIR"

  BIN="$REPO_ROOT/src-tauri/target/tour/debug/app"
fi

# `env -i`: the app sees only what is listed here, never this shell's own environment (so nothing
# of the user's real HOME, PATH or proxy settings reaches it).
env -i \
  HOME="$HOME_DIR" \
  CFFIXED_USER_HOME="$HOME_DIR" \
  HTTPS_PROXY="http://127.0.0.1:9" \
  HTTP_PROXY="http://127.0.0.1:9" \
  ALL_PROXY="http://127.0.0.1:9" \
  NO_PROXY="" \
  GIT_ALLOW_PROTOCOL="file" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  CODEMIE_WORKSPACE_TEST_DIR="$TEST_DIR" \
  CODEMIE_TOUR="$ONLY" \
  CODEMIE_TOUR_SHA="$SHA" \
  "$BIN" &
pid=$!

# 660 s watchdog on the app's own PID only. The app's own Rust watchdog (design's exit code 2)
# reports and exits by 600 s on its own; this is the last resort if that somehow never ran. Its
# whole output is redirected to /dev/null (never this script's own stdout/stderr), so a caller
# piping `make tour` never waits on this subshell to close that pipe; it is also stopped the
# moment the app is reaped below, so it can never act on a PID macOS has since handed to an
# unrelated process. `WATCHDOG_FLAG` records whether it actually had to act, so the exit code can
# still say 2 ("nothing reported within 600 s") even though the signal itself yields a different
# raw exit status.
WATCHDOG_FLAG="$RUN/.watchdog-fired"
(
  set +e
  sleep 660 &
  s=$!
  trap 'kill "$s" 2>/dev/null; exit 0' TERM
  wait "$s"
  if ps -p "$pid" >/dev/null 2>&1; then
    : > "$WATCHDOG_FLAG"
    kill "$pid"
    sleep 5
    if ps -p "$pid" >/dev/null 2>&1; then
      kill -9 "$pid"
    fi
  fi
) >/dev/null 2>&1 &
watchdog=$!

set +e
wait "$pid"
code=$?
set -e
pid=""                        # reaped: never signal this number again (cleanup included)
kill "$watchdog" 2>/dev/null || true
wait "$watchdog" 2>/dev/null || true
watchdog=""

if [[ -f "$WATCHDOG_FLAG" ]]; then
  code=2
fi

RESULTS="$TEST_DIR/tour/results.json"
OUT_DIR="$REPO_ROOT/output/tour/${STAMP}-${SHA}"

# The report runs whenever results.json exists, even after a failed tour; it never runs off a
# refusal that never got far enough to write one (design § 9 step 5). A report failure never
# hides the app's own verdict: the Run folder and Verdict lines always print, and a report
# failure on an otherwise passing tour still exits non-zero with a clear reason.
if [[ -f "$RESULTS" ]]; then
  if report_path="$(node "$REPO_ROOT/scripts/tour/report.mjs" "$TEST_DIR" "$OUT_DIR")"; then
    echo "Report: $report_path"
  else
    echo "CODEMIE_TOUR: report.mjs failed; the tour's own verdict above is unaffected." >&2
    if [[ "$code" -eq 0 ]]; then
      code=1
    fi
  fi
else
  echo "CODEMIE_TOUR: no report ($RESULTS was never written)." >&2
fi

echo "Run folder: $RUN"
echo "Verdict: $([[ "$code" -eq 0 ]] && echo PASS || echo "FAIL (exit $code)")"

exit "$code"
