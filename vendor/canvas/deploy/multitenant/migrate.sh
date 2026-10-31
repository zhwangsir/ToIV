#!/usr/bin/env bash
# M7 multi-tenant migration for canvas-api-pg (reversible, with backup).
#
#   migrate.sh status|up|down --env /path/canvas-api.env --admin-uid <ToIV uid> [--schema canvas]
#              [--legacy-ws <workspace id>] [--backup-dir DIR] [--drop-tables]
#
# * DATABASE_URL is read from the canvas-api EnvironmentFile and never printed.
# * up/down first write a pg_dump (custom format, mode 0600) of the whole schema to
#   --backup-dir (default: <env dir>/backups). Restore: pg_restore --clean --if-exists -n <schema>.
# * Run `up` BEFORE starting canvas-api with CANVAS_USER_IDENTITY_KEY_FILE (otherwise the
#   admin's first request auto-creates an empty workspace; up then rebinds it only if empty).
set -euo pipefail
umask 077
here="$(cd "$(dirname "$0")" && pwd)"
cmd="${1:-}"; shift || true
env_file=""; admin_uid=""; schema="canvas"; legacy_ws=""; backup_dir=""; drop_tables=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) env_file="$2"; shift 2;;
    --admin-uid) admin_uid="$2"; shift 2;;
    --schema) schema="$2"; shift 2;;
    --legacy-ws) legacy_ws="$2"; shift 2;;
    --backup-dir) backup_dir="$2"; shift 2;;
    --drop-tables) drop_tables=1; shift;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
case "$cmd" in status|up|down) ;; *) sed -n 2,12p "$0"; exit 2;; esac
[ -r "$env_file" ] || { echo "--env file required" >&2; exit 2; }
[[ "$schema" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "bad schema" >&2; exit 2; }
dsn="$(sed -n 's/^DATABASE_URL=//p' "$env_file" | tail -1)"
dsn="${dsn%\"}"; dsn="${dsn#\"}"; dsn="${dsn%\'}"; dsn="${dsn#\'}"
[ -n "$dsn" ] || { echo "DATABASE_URL missing in env file" >&2; exit 2; }
# Strip any search_path/options from the DSN; we set the schema explicitly.
# Handles both URL DSNs (postgres://...?search_path=x) and key=value DSNs (search_path=x).
dsn="$(printf '%s' "$dsn" | sed -E "s/([?&])(search_path|options)=[^&]*&?/\\1/g; s/[?&]\$//; s/(^|[[:space:]])options='[^']*'//g; s/(^|[[:space:]])(search_path|options)=[^[:space:]]*//g")"
export PGOPTIONS="-c search_path=${schema}"
psqlc() { psql "$dsn" -X -q -v ON_ERROR_STOP=1 "$@"; }

status() {
  psqlc -At -c "SELECT 'workspaces=' || count(*) FROM workspaces"
  if [ "$(psqlc -At -c "SELECT to_regclass('workspace_identities') IS NOT NULL")" = "t" ]; then
    psqlc -At -c "SELECT 'identities=' || count(*) FROM workspace_identities" \
          -c "SELECT 'legacy_binding=' || COALESCE((SELECT left(subject,8) || '->' || left(workspace_id,8) || ' (' || source || ')' FROM workspace_identities WHERE source = 'm7-legacy-admin' LIMIT 1), 'none')"
  else
    echo "identities=absent"
  fi
}
backup() {
  local dir="${backup_dir:-$(dirname "$env_file")/backups}"
  mkdir -p "$dir"; chmod 700 "$dir"
  local out="$dir/canvas-${schema}-$(date +%Y%m%d-%H%M%S)-pre-${cmd}.dump"
  pg_dump "$dsn" -Fc -n "$schema" -f "$out"
  chmod 600 "$out"
  echo "backup: $out ($(du -h "$out" | cut -f1))"
}

case "$cmd" in
  status) status;;
  up)
    [[ "$admin_uid" =~ ^[A-Za-z0-9_-]{1,36}$ ]] || { echo "--admin-uid required" >&2; exit 2; }
    echo "before:"; status; backup
    psqlc -v admin_uid="$admin_uid" -v legacy_ws="$legacy_ws" -f "$here/001_workspace_identities.up.sql"
    echo "after:"; status;;
  down)
    echo "before:"; status; backup
    if [ "$drop_tables" = 1 ]; then psqlc -v drop_tables=1 -f "$here/001_workspace_identities.down.sql"; else psqlc -f "$here/001_workspace_identities.down.sql"; fi
    echo "after:"; status;;
esac
