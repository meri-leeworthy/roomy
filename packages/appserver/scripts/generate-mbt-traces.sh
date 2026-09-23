#!/usr/bin/env bash
#
# Generate ITF traces for the auth model (`specs/auth.qnt`) into `specs/traces/`.
#
# `src/auth/mbt/mbt.test.ts` replays every `*.itf.json` in that directory
# against `src/auth/access.ts` and fails on any divergence between the spec's
# oracle and the implementation. The traces themselves are gitignored
# (`specs/traces` in packages/appserver/.gitignore) — they are generated
# artefacts, reproducible from the model plus the seed below.
#
# Quint is not a repo dependency: it is fetched through npx at the pinned
# version. That keeps a model checker out of the lockfile while still making
# the exact version that produced the traces explicit and reproducible.
#
# Usage:
#   pnpm --filter @roomy/appserver mbt:traces
#   MAX_STEPS=40 N_TRACES=8 ./scripts/generate-mbt-traces.sh   # quicker run
#
set -euo pipefail

# Pinned: the version the committed parity results were produced with.
# Bump deliberately — a Quint upgrade can change the simulator's choices.
QUINT_VERSION="${QUINT_VERSION:-0.32.0}"

# Seed + shape are pinned so a regeneration reproduces the same traces.
# `--max-samples` must be >= `--n-traces` for the simulator to emit them all.
SEED="${SEED:-0x195}"
MAX_STEPS="${MAX_STEPS:-80}"
N_TRACES="${N_TRACES:-48}"

cd "$(dirname "$0")/.."

mkdir -p specs/traces
rm -f specs/traces/*.itf.json

echo "[mbt] typechecking specs/auth.qnt with quint ${QUINT_VERSION}"
npx --yes "@informalsystems/quint@${QUINT_VERSION}" \
  typecheck specs/auth.qnt

echo "[mbt] generating ${N_TRACES} traces (max-steps=${MAX_STEPS}, seed=${SEED})"
npx --yes "@informalsystems/quint@${QUINT_VERSION}" run \
  --main=auth \
  --mbt \
  --max-steps="${MAX_STEPS}" \
  --max-samples="${N_TRACES}" \
  --n-traces="${N_TRACES}" \
  --seed="${SEED}" \
  --out-itf='specs/traces/auth_{seq}.itf.json' \
  specs/auth.qnt

generated=$(find specs/traces -name '*.itf.json' | wc -l | tr -d ' ')
echo "[mbt] wrote ${generated} trace(s) to specs/traces/"
