#!/usr/bin/env bash
set -euo pipefail

if grep -R "from 'node-fetch'" -n .; then
  echo "❌ node-fetch is not allowed (Node 20 has global fetch)" >&2
  exit 1
fi

echo "✅ No node-fetch imports found."

