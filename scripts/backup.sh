#!/usr/bin/env bash
#
# Take a backup, prove it can be restored, and send a sealed copy off the server.
#
# A backup nobody has restored is a hope, not a backup. This script dumps the
# database, then restores that dump into a scratch database and checks the
# books still balance inside it. If the restore fails the dump is deleted,
# because a file that cannot be restored is worse than no file — it is a file
# somebody will rely on.
#
# A backup that lives on the server it protects is lost with that server: a
# dead disk, a lost account, ransomware. So a verified backup is also sealed to
# a public key whose private half is kept somewhere else, and copied to storage
# this server does not administer. See deploy/RECOVERY.md.
#
# Usage:
#   scripts/backup.sh                         take, verify and ship a backup
#   scripts/backup.sh restore FILE [--yes]    replace the live database with a backup
#   scripts/backup.sh restore-photos FILE     put the product photographs back
#   scripts/backup.sh decrypt FILE.age        unseal an offsite copy
#
# Settings, from the environment (the systemd unit reads /etc/cashmere/backup.env):
#   CASHMERE_BACKUP_RECIPIENT  age public key, or a file of them, the offsite
#                              copies are sealed to. The private key is never
#                              on this server.
#   CASHMERE_OFFSITE           rclone destination, e.g. b2:cashmere-backups/os
#   CASHMERE_BACKUP_PING_URL   a dead-man's switch (healthchecks.io or alike):
#                              told when a run starts, succeeds or fails, and
#                              raises the alarm itself when no success arrives.
#   CASHMERE_BACKUP_IDENTITY   restore/decrypt only: the age private key file.
#   CASHMERE_DISK_ALERT_PERCENT  fail the run, and so alert, above this (85).
#
set -euo pipefail

CONTAINER="${CASHMERE_DB_CONTAINER:-cashmere-os-db}"
APP_CONTAINER="${CASHMERE_APP_CONTAINER:-cashmere-os-app}"
COMPOSE_FILE="${CASHMERE_COMPOSE_FILE:-docker-compose.prod.yml}"
DB="${CASHMERE_DB_NAME:-cashmere_os}"
USER="${CASHMERE_DB_USER:-cashmere_os}"
DIR="${CASHMERE_BACKUP_DIR:-backups}"
KEEP_DAYS="${CASHMERE_BACKUP_KEEP_DAYS:-30}"
UPLOADS="${UPLOAD_DIR:-data/uploads}"
DISK_ALERT="${CASHMERE_DISK_ALERT_PERCENT:-85}"

VERIFY_DB="${DB}_restore_check"
STAGE_DB="${DB}_restore_stage"
STAMP="$(date '+%Y%m%d-%H%M%S')"

REASON=""
SCRATCH=""

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1"; }
die() { REASON="$1"; printf 'FAILED: %s\n' "$1" >&2; exit 1; }

psql_in() { docker exec -i "$CONTAINER" psql -U "$USER" -v ON_ERROR_STOP=1 "$@"; }
drop_db() { psql_in -d postgres -c "DROP DATABASE IF EXISTS \"$1\";" >/dev/null 2>&1 || true; }
db_exists() { [ "$(psql_in -tA -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '$1'")" = "1" ]; }

scratch() { [ -n "$SCRATCH" ] || SCRATCH="$(mktemp -d)"; }
# The application is stopped for a restore. Whatever happens next, it goes back
# up: a failed restore that also leaves the shop unable to sell is two problems.
start_app() { docker start "$APP_CONTAINER" >/dev/null 2>&1 || true; }
trap '[ -z "$SCRATCH" ] || rm -rf "$SCRATCH"' EXIT

ping_monitor() { # $1: "" for success, "/start" or "/fail"; $2: text to attach
  [ -n "${CASHMERE_BACKUP_PING_URL:-}" ] || return 0
  curl -fsS -m 15 --retry 3 --data-raw "${2:-}" "${CASHMERE_BACKUP_PING_URL}$1" >/dev/null 2>&1 \
    || log "could not reach the backup monitor at ${CASHMERE_BACKUP_PING_URL%%\?*}"
}

# Loads a plain .sql.gz into a fresh database and checks it is a coherent set of
# books. Every step reports its own failure: this runs as the left side of an
# `||`, where bash stops honouring `set -e`, and a check that failed silently
# would leave both totals empty — which compare equal, and "balance".
load_and_check() { # $1: dump file, $2: target database
  local file="$1" target="$2" check entries lines lots debits credits triggers
  drop_db "$target"
  psql_in -d postgres -c "CREATE DATABASE \"$target\" OWNER \"$USER\";" >/dev/null \
    || { REASON="could not create $target"; return 1; }
  gunzip -c "$file" | psql_in -d "$target" >/dev/null 2>&1 \
    || { REASON="the dump would not load"; return 1; }

  # Not merely loaded — still a set of books. A dump that restores into an
  # unbalanced ledger is a corrupted backup that looks fine.
  check=$(psql_in -tA -d "$target" -c "
    SELECT
      (SELECT COUNT(*) FROM journal_entries) || '|' ||
      (SELECT COUNT(*) FROM journal_lines) || '|' ||
      (SELECT COUNT(*) FROM inventory_lots) || '|' ||
      (SELECT COALESCE(SUM(l.debit),0)::text FROM journal_lines l JOIN journal_entries e ON e.id=l.\"journalEntryId\" WHERE e.status='POSTED') || '|' ||
      (SELECT COALESCE(SUM(l.credit),0)::text FROM journal_lines l JOIN journal_entries e ON e.id=l.\"journalEntryId\" WHERE e.status='POSTED') || '|' ||
      (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema='public')
  ") || { REASON="the restored copy could not be read"; return 1; }
  IFS='|' read -r entries lines lots debits credits triggers <<< "$check"
  [ -n "$debits" ] && [ -n "$triggers" ] || { REASON="the restored copy gave no totals"; return 1; }

  log "restored copy holds $entries journals, $lines lines, $lots lots"
  [ "$debits" = "$credits" ] || { REASON="the restored ledger does not balance: $debits vs $credits"; return 1; }
  log "restored ledger balances at $debits"
  # The triggers are the accounting rules. A dump that loses them restores data
  # that can then be edited freely.
  [ "$triggers" -gt 0 ] || { REASON="the restored database has no triggers; the accounting rules did not survive"; return 1; }
  log "$triggers triggers survived the round trip"
}

unseal() { # $1: .age file, $2: where to write the plain file
  command -v age >/dev/null || die "age is not installed (apt-get install age)"
  [ -n "${CASHMERE_BACKUP_IDENTITY:-}" ] && [ -f "$CASHMERE_BACKUP_IDENTITY" ] \
    || die "set CASHMERE_BACKUP_IDENTITY to the file holding the backup private key"
  age -d -i "$CASHMERE_BACKUP_IDENTITY" -o "$2" "$1" || die "$1 would not unseal with that key"
}

# ---------------------------------------------------------------- decrypt
if [ "${1:-}" = "decrypt" ]; then
  FILE="${2:-}"
  [ -f "$FILE" ] || die "give the .age file to unseal"
  case "$FILE" in *.age) ;; *) die "$FILE is not an .age file" ;; esac
  unseal "$FILE" "${FILE%.age}"
  log "wrote ${FILE%.age}"
  exit 0
fi

# ----------------------------------------------------------------- photos
if [ "${1:-}" = "restore-photos" ]; then
  FILE="${2:-}"
  [ -f "$FILE" ] || die "give the photographs archive to restore"
  case "$FILE" in
    *.age) scratch; unseal "$FILE" "$SCRATCH/photos.tar.gz"; FILE="$SCRATCH/photos.tar.gz" ;;
  esac
  mkdir -p "$UPLOADS"
  # Adds and overwrites; never deletes. A photograph taken since the backup
  # stays, which is what anybody restoring photographs would want.
  tar -xzf "$FILE" -C "$(dirname "$UPLOADS")"
  log "photographs restored into $UPLOADS ($(find "$UPLOADS" -type f | wc -l | tr -d ' ') files there now)"
  exit 0
fi

# ---------------------------------------------------------------- restore
#
# The old version dropped the live database first and loaded the file after,
# so a wrong or damaged file left no database at all. Now the file is loaded
# and checked beside the live one; only a copy that passes replaces it, by a
# rename, and the database it replaced is kept rather than dropped.
if [ "${1:-}" = "restore" ]; then
  FILE="${2:-}"
  [ -n "$FILE" ] || die "give the backup file to restore"
  [ -f "$FILE" ] || die "$FILE does not exist"

  PLAIN="$FILE"
  case "$FILE" in
    *.age) scratch; unseal "$FILE" "$SCRATCH/restore.sql.gz"; PLAIN="$SCRATCH/restore.sql.gz" ;;
  esac

  log "loading $FILE into $STAGE_DB; the live database is untouched until it passes"
  if ! load_and_check "$PLAIN" "$STAGE_DB"; then
    drop_db "$STAGE_DB"
    die "$REASON — the live database was not touched"
  fi

  if [ "${3:-}" != "--yes" ]; then
    [ -t 0 ] || { drop_db "$STAGE_DB"; die "not at a terminal: add --yes to confirm the restore"; }
    printf '\nThis replaces %s with the backup. The current database is kept, renamed.\n' "$DB"
    read -r -p "Type $DB to go ahead: " ANSWER
    [ "$ANSWER" = "$DB" ] || { drop_db "$STAGE_DB"; die "not confirmed; nothing was changed"; }
  fi

  KEEP="${DB}_before_restore_${STAMP//-/_}"
  log "stopping the application, so nothing is written to the database being replaced"
  docker stop "$APP_CONTAINER" >/dev/null 2>&1 || true

  if db_exists "$DB"; then
    # A rename needs the database to itself; a connection closing a moment
    # late would otherwise fail it, so it is asked a few times.
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
      psql_in -d postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid();" >/dev/null
      if psql_in -d postgres -c "ALTER DATABASE \"$DB\" RENAME TO \"$KEEP\";" >/dev/null 2>&1; then break; fi
      [ "$attempt" -lt 10 ] || { start_app; die "$DB is still in use; nothing was changed, and the application is back up"; }
      sleep 1
    done
    log "the database as it was is kept as $KEEP"
  fi
  if ! psql_in -d postgres -c "ALTER DATABASE \"$STAGE_DB\" RENAME TO \"$DB\";" >/dev/null; then
    db_exists "$KEEP" && psql_in -d postgres -c "ALTER DATABASE \"$KEEP\" RENAME TO \"$DB\";" >/dev/null
    start_app
    die "could not put the restored copy in place; the previous database is back as $DB, and the application with it"
  fi
  log "restored copy is now $DB"

  if [ -f "$COMPOSE_FILE" ]; then
    # A backup from before the latest release lacks its migrations, and the
    # application's login and grants are not part of a dump. The migrate
    # service does both, exactly as it does on a deploy.
    log "bringing the schema up to date and granting the application its login"
    docker compose -f "$COMPOSE_FILE" run --rm migrate
    docker compose -f "$COMPOSE_FILE" up -d app >/dev/null
    log "application started"
  else
    log "no $COMPOSE_FILE here: run the migrations and scripts/ensure-app-role.mjs, then start the app"
  fi
  log "restored. Once satisfied, drop the old copy: DROP DATABASE \"$KEEP\";"
  exit 0
fi

# ----------------------------------------------------------------- backup
trap '
  status=$?
  [ -z "$SCRATCH" ] || rm -rf "$SCRATCH"
  [ "$status" -eq 0 ] || ping_monitor /fail "${REASON:-the backup stopped with status $status}"
' EXIT
ping_monitor /start

mkdir -p "$DIR"
FILE="$DIR/$DB-$STAMP.sql.gz"

log "dumping $DB"
# Without owners or grants: those name logins that exist on this server and not
# on a replacement one, where restoring them stops the load at the first GRANT.
# The migrate step recreates the application's login and grants after a restore.
docker exec "$CONTAINER" pg_dump -U "$USER" --clean --if-exists --no-owner --no-privileges "$DB" | gzip > "$FILE"

SIZE=$(wc -c < "$FILE")
[ "$SIZE" -gt 1024 ] || die "the dump is only $SIZE bytes; something went wrong"
log "wrote $FILE ($(( SIZE / 1024 ))KB)"

log "restoring it into $VERIFY_DB to prove it works"
if ! load_and_check "$FILE" "$VERIFY_DB"; then
  drop_db "$VERIFY_DB"
  rm -f "$FILE"
  die "$REASON; the dump has been deleted rather than left to be trusted"
fi
drop_db "$VERIFY_DB"
log "verification copy removed"

# ------------------------------------------------- the photographs as well
#
# Product photos are files on disk, not rows. A database backup alone restores
# a catalogue where every garment is a grey square, which is not a restored
# catalogue.
PHOTOS=""
if [ -d "$UPLOADS" ]; then
  PHOTOS="$DIR/uploads-$STAMP.tar.gz"
  tar -czf "$PHOTOS" -C "$(dirname "$UPLOADS")" "$(basename "$UPLOADS")"
  COUNT=$(find "$UPLOADS" -type f | wc -l | tr -d ' ')
  log "wrote $PHOTOS ($COUNT photos)"
else
  log "no upload directory at $UPLOADS; nothing to photograph"
fi

# ------------------------------------------------------------ off the server
OFFSITE_NOTE="this backup exists only on this server"
if [ -n "${CASHMERE_OFFSITE:-}" ]; then
  # Never the books in the clear on somebody else's disk.
  [ -n "${CASHMERE_BACKUP_RECIPIENT:-}" ] \
    || die "CASHMERE_OFFSITE is set but CASHMERE_BACKUP_RECIPIENT is not; refusing to send the books off the server unsealed"
  command -v age >/dev/null || die "age is not installed (apt-get install age)"
  command -v rclone >/dev/null || die "rclone is not installed (apt-get install rclone)"

  if [ -f "$CASHMERE_BACKUP_RECIPIENT" ]; then SEAL=(-R "$CASHMERE_BACKUP_RECIPIENT"); else SEAL=(-r "$CASHMERE_BACKUP_RECIPIENT"); fi
  scratch
  OUT="$SCRATCH/$STAMP"
  mkdir -p "$OUT"
  age "${SEAL[@]}" -o "$OUT/$(basename "$FILE").age" "$FILE"
  [ -z "$PHOTOS" ] || age "${SEAL[@]}" -o "$OUT/$(basename "$PHOTOS").age" "$PHOTOS"
  # A replacement server needs more than the data: the settings it ran with
  # (without INTEGRATION_SECRET_KEY the Shopify credentials in the dump cannot
  # be opened) and the release it ran, since a dump fits the schema of its day.
  [ ! -f .env ] || age "${SEAL[@]}" -o "$OUT/env-$STAMP.age" .env
  git rev-parse HEAD > "$OUT/version-$STAMP.txt" 2>/dev/null || echo "unknown" > "$OUT/version-$STAMP.txt"

  # --immutable: an upload never overwrites something already there.
  rclone copy --immutable "$OUT" "$CASHMERE_OFFSITE/$STAMP" || die "the copy to $CASHMERE_OFFSITE failed"
  rclone check --one-way "$OUT" "$CASHMERE_OFFSITE/$STAMP" >/dev/null 2>&1 \
    || die "the copy at $CASHMERE_OFFSITE/$STAMP does not match what was sent"
  OFFSITE_NOTE="sealed copy at $CASHMERE_OFFSITE/$STAMP"
  log "$OFFSITE_NOTE, checked against what was sent"
else
  log "WARNING: CASHMERE_OFFSITE is not set — $OFFSITE_NOTE. See deploy/RECOVERY.md."
fi

# ------------------------------------------------------------- retention
# Local copies only. The offsite copies are kept by the storage's own rules,
# which this server should not have the rights to change — see RECOVERY.md.
find "$DIR" -name "$DB-*.sql.gz" -type f -mtime "+$KEEP_DAYS" -print -delete | while read -r old; do
  log "removed $old (older than $KEEP_DAYS days)"
done
find "$DIR" -name "uploads-*.tar.gz" -type f -mtime "+$KEEP_DAYS" -print -delete | while read -r old; do
  log "removed $old (older than $KEEP_DAYS days)"
done

# ------------------------------------------------------------- disk
# Checked after the backup, so a full-ish disk still gets tonight's copy, and
# then fails the run so the alarm goes off while there is still room.
USED=$(df -P "$DIR" | awk 'NR==2 {gsub("%","",$5); print $5}')
[ "$USED" -lt "$DISK_ALERT" ] || die "backup taken, but the disk is ${USED}% full (alarm at ${DISK_ALERT}%)"

log "backup verified: $FILE"
ping_monitor "" "verified $FILE; $OFFSITE_NOTE; disk ${USED}% used"
