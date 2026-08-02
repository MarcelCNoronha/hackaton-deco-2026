#!/bin/sh
set -e

# Only the "app" service runs migrations (RUN_MIGRATIONS unset/true by default);
# the worker sets RUN_MIGRATIONS=false so two containers never migrate concurrently.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "Running database migrations..."
  node dist/db/migrate.js
fi

exec "$@"
