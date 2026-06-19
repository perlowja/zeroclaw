#!/usr/bin/env bash
# agent-preflight.sh — pre-PR validation gate for automated (and human) contributors.
#
# Runs the SAME checks CI enforces, locally, BEFORE a pull request is opened, so
# agentic coding pipelines never push branches that fail fmt / clippy / build /
# test / title gates. Idempotent: safe to run repeatedly (it auto-applies
# rustfmt, everything else is read-only).
#
#   scripts/agent-preflight.sh ["<proposed PR title>"]
#
# Exit 0 = safe to open a PR. Non-zero = fix the reported failures first.
# Honors CARGO_BUILD_JOBS / RUSTFLAGS from the environment.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2
fail=0
run() { printf '\n\033[1m==> %s\033[0m\n' "$*"; "$@" || { echo "::error::FAILED: $*"; fail=1; }; }

# 1. Format — auto-apply then verify (idempotent). Format gates all of CI.
printf '\n\033[1m==> cargo fmt --all (auto-apply)\033[0m\n'; cargo fmt --all || fail=1
run cargo fmt --all -- --check

# 2. Repo quality gate (clippy -D warnings + provider-dispatch SSOT gate).
run ./scripts/ci/rust_quality_gate.sh --strict

# 2b. CI's Lint/Check jobs run with --all-features; the repo gate above only uses
#     --all-targets, so feature-gated breakage slips past it. Match CI explicitly.
run cargo clippy --all-targets --all-features --locked -- -D warnings
run cargo check --all-targets --all-features --locked

# 3. Compile every target with default features too.
run cargo check --all-targets --locked

# 4. Tests (all features, matching CI).
run cargo test --all-features --locked

# 5. PR title — Conventional Commits with scope (the `main` CI check).
if [ "${1-}" != "" ]; then
  run ./scripts/check-pr-title.sh "$1"
else
  printf '\n\033[33m(note) pass your proposed PR title as $1 to validate it: scripts/agent-preflight.sh "fix(scope): ..."\033[0m\n'
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "================================================================"
  echo " PREFLIGHT FAILED — do NOT open a PR until the above are fixed."
  echo " (Automated pipelines: treat a non-zero exit as a hard gate.)"
  echo "================================================================"
  exit 1
fi
echo "PREFLIGHT PASSED — branch is CI-clean and safe to open a PR."
