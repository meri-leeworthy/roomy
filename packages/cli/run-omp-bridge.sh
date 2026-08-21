#!/bin/bash
# Roomy -> omp bridge runner (Chanterelle agent).
# Authenticates as the CLI account, listens for mentions of it in Meri's
# Forest, and answers via the omp coding agent (deepseek-v4-flash:0731 via
# Ollama Cloud).
set -euo pipefail
export PATH=/home/exedev/node/bin:/home/exedev/.local/bin:$PATH
cd /home/exedev/roomy/packages/cli
export $(grep -vE '^\s*#|^\s*$' .env | xargs)
export APPSERVER_URL=https://api.roomy.space
export APPSERVER_DID=did:web:api.roomy.space
export OLLAMA_CLOUD_API_KEY=$(grep OLLAMA_CLOUD_API_KEY /home/exedev/.omp/agent/ollama-cloud.env | cut -d= -f2-)
# Unified workflow context appended to omp's system prompt on every run.
export OMP_SYSTEM_PROMPT_FILE="${OMP_SYSTEM_PROMPT_FILE:-/home/exedev/.omp/workflow-context.md}"
exec npx tsx src/cli.ts listen \
  --space did:plc:drzgt2m6lmcel62gfbzjeap3 \
  --model ollama-cloud/deepseek-v4-flash:0731 \
  --cwd /home/exedev/roomy
