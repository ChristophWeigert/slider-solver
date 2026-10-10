#!/usr/bin/env bash
# Add-on entrypoint. Options live in /data/options.json and are read by the server
# itself, so the same image still works for a plain `docker run` with env vars.
set -euo pipefail

# Options -> environment. node parses them so the image needs no jq, and the
# values are JSON-quoted, which is what makes this eval safe.
if [ -f /data/options.json ]; then
  eval "$(node -e 'const o=require("/data/options.json");const m={SOLVER_TOKEN:o.solver_token,SOLVE_TIMEOUT_MS:o.solve_timeout_ms,SOLVE_ATTEMPTS:o.solve_attempts,DRAG_BIAS_PX:o.drag_bias_px};for(const k in m){if(m[k]!==""&&m[k]!=null)console.log(k+"="+JSON.stringify(String(m[k])))}')"
fi

export DEBUG_DIR="${DEBUG_DIR:-/data/debug}"
mkdir -p "$DEBUG_DIR" 2>/dev/null || true

echo "[run] xpeng slider solver starting on port ${PORT:-8080}"
if [ -n "${SOLVER_TOKEN:-}" ]; then
  echo "[run] bearer auth: on (from environment)"
elif [ -f /data/options.json ]; then
  echo "[run] configuration from /data/options.json"
else
  echo "[run] WARNING: no SOLVER_TOKEN and no options file - the API is open"
fi

exec node /app/server.mjs
