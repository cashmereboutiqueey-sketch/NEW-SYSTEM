#!/usr/bin/env bash
#
# Take a backup, and prove it can be restored.
#
# A backup nobody has restored is a hope, not a backup. This script does both
# halves: it dumps the database, then restores that dump into a scratch
# database and checks the books still balance inside it. If the restore fails
# the dump is deleted, because a file that cannot be restored is worse than no
# file — it is a file somebody will rely on.
#
# Usage:
#   scripts/backup.sh                 take and verify a backup
#   scripts/backup.sh restore FILE    restore a backup over the live database
#
set -euo pipefail

CONTAINER="${CASHMERE_DB_CONTAINER:-cashmere-os-db}"
DB="${CASHMERE_DB_NAME:-cashmere_os}"
USER="${CASHMERE_DB_USER:-cashmere_os}"
DIR="${CASHMERE_BACKUP_DIR:-backups}"
KEEP_DAYS="${CASHMERE_BACKUP_KEEP_DAYS:-30}"

VERIFY_DB="${DB}_restore_check"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"; }
die() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }

psql_in() { docker exec -i "$CONTAINER" psql -U "$USER" -v ON_ERROR_STOP=1 "$@"; }

# ---------------------------------------------------------------- restore
if [ "${1:-}" = "restore" ]; then
  FILE="${2:-}"
  [ -n "$FILE" ] || die "give the backup file to restore"
  [ -f "$FILE" ] || die "$FILE does not exist"

  log "restoring $FILE over $DB — this replaces everything currently in it"
  gunzip -c "$FILE" | psql_in -d postgres -c "
    SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();
  " >/dev/null 2>&1 || true

  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$DB\";" >/dev/null
  psql_in -d postgres -c "CREATE DATABASE \"$DB\" OWNER \"$USER\";" >/dev/null
  gunzip -c "$FILE" | psql_in -d "$DB" >/dev/null
  log "restored"
  exit 0
fi

# ----------------------------------------------------------------- backup
mkdir -p "$DIR"
STAMP="$(date '+%Y%m%d-%H%M%S')"
FILE="$DIR/$DB-$STAMP.sql.gz"

log "dumping $DB"
docker exec "$CONTAINER" pg_dump -U "$USER" --clean --if-exists "$DB" | gzip > "$FILE"

SIZE=$(wc -c < "$FILE")
[ "$SIZE" -gt 1024 ] || die "the dump is only $SIZE bytes; something went wrong"
log "wrote $FILE ($(( SIZE / 1024 ))KB)"

# ------------------------------------------------- prove it can come back
log "restoring it into $VERIFY_DB to prove it works"

psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" >/dev/null
psql_in -d postgres -c "CREATE DATABASE \"$VERIFY_DB\" OWNER \"$USER\";" >/dev/null

if ! gunzip -c "$FILE" | psql_in -d "$VERIFY_DB" >/dev/null 2>&1; then
  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" >/dev/null || true
  rm -f "$FILE"
  die "the dump would not restore; it has been deleted rather than left to be trusted"
fi

# The restored copy must not merely load — it must still be a coherent set of
# books. A dump that restores into an unbalanced ledger is a corrupted backup
# that looks fine.
CHECK=$(psql_in -tA -d "$VERIFY_DB" -c "
  SELECT
    (SELECT COUNT(*) FROM journal_entries) || '|' ||
    (SELECT COUNT(*) FROM journal_lines) || '|' ||
    (SELECT COUNT(*) FROM inventory_lots) || '|' ||
    (SELECT COALESCE(SUM(l.debit),0)::text FROM journal_lines l JOIN journal_entries e ON e.id=l.\"journalEntryId\" WHERE e.status='POSTED') || '|' ||
    (SELECT COALESCE(SUM(l.credit),0)::text FROM journal_lines l JOIN journal_entries e ON e.id=l.\"journalEntryId\" WHERE e.status='POSTED') || '|' ||
    (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='public')
")

IFS='|' read -r ENTRIES LINES LOTS DEBITS CREDITS TRIGGERS <<< "$CHECK"

log "restored copy holds $ENTRIES journals, $LINES lines, $LOTS lots"

[ "$DEBITS" = "$CREDITS" ] || {
  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" >/dev/null || true
  die "the restored ledger does not balance: $DEBITS vs $CREDITS"
}
log "restored ledger balances at $DEBITS"

# The triggers are the accounting rules. A dump that loses them restores data
# that can then be edited freely.
[ "$TRIGGERS" -gt 0 ] || {
  psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" >/dev/null || true
  die "the restored database has no triggers; the accounting rules did not survive"
}
log "$TRIGGERS triggers survived the round trip"

psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$VERIFY_DB\";" >/dev/null
log "verification copy removed"

# ------------------------------------------------- the photographs as well
#
# Product photos are files on disk, not rows. A database backup alone restores
# a catalogue where every garment is a grey square, which is not a restored
# catalogue.
UPLOADS="${UPLOAD_DIR:-data/uploads}"
if [ -d "$UPLOADS" ]; then
  PHOTOS="$DIR/uploads-$STAMP.tar.gz"
  tar -czf "$PHOTOS" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
  COUNT=$(find "$UPLOADS" -type f | wc -l | tr -d ' ')
  log "wrote $PHOTOS ($COUNT photos)"
else
  log "no upload directory at $UPLOADS; nothing to photograph"
fi

# ------------------------------------------------------------- retention
find "$DIR" -name "$DB-*.sql.gz" -type f -mtime "+$KEEP_DAYS" -print -delete | while read -r old; do
  log "removed $old (older than $KEEP_DAYS days)"
done
find "$DIR" -name "uploads-*.tar.gz" -type f -mtime "+$KEEP_DAYS" -print -delete | while read -r old; do
  log "removed $old (older than $KEEP_DAYS days)"
done

log "backup verified: $FILE"
