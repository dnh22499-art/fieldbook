#!/bin/sh
# Runs Fieldbook directly on this computer (Linux / macOS / NAS shell) — needs Node.js 22.13+.
# Open http://localhost:8080 afterwards.
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
exec node --disable-warning=ExperimentalWarning server/index.js
