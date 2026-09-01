#!/usr/bin/env bash
#
# Deploy Cashmere OS to the server.
#
# Run it from a laptop; it does the rest over SSH. It builds on the server
# rather than pushing an image, because a 96 GB disk with 93 GB free has room
# to build and a registry is one more thing to run, pay for and lose access to.
#
#   scripts/deploy.sh                 deploy whatever is committed on this branch
#   scripts/deploy.sh --status        what is running, without changing anything
#   scripts/deploy.sh --logs          follow the application log
#   scripts/deploy.sh --rollback      go back to the previous image
#
# What it will not do: run with uncommitted changes, or start without a .env
# on the server. Both are ways of shipping something nobody can reproduce.

set -euo pipefail

HOST="${CASHMERE_HOST:-root@187.124.182.93}"
KEY="${CASHMERE_KEY:-$HOME/.ssh/cashmere_os_deploy}"
DIR="/opt/cashmere-os"
REPO="${CASHMERE_REPO:-https://github.com/cashmereboutiqueey-sketch/NEW-SYSTEM.git}"
BRANCH="${CASHMERE_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"

ssh_run() { ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$HOST" "$@"; }
say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

case "${1:-deploy}" in
  --status)
    say "what is running"
    ssh_run "cd $DIR 2>/dev/null && docker compose -f docker-compose.prod.yml ps || echo 'not deployed yet'"
    ssh_run "df -h / | awk 'NR==2{print \"disk: \"\$3\" of \"\$2\" used\"}'"
    exit 0
    ;;
  --logs)
    ssh_run "cd $DIR && docker compose -f docker-compose.prod.yml logs -f --tail=100 app"
    exit 0
    ;;
  --rollback)
    say "rolling back to the previous image"
    # Tagged on every deploy before the new one replaces it, so there is
    # always exactly one step back — which is the step anybody ever wants.
    ssh_run "cd $DIR && docker image inspect cashmere-os:previous >/dev/null 2>&1 || { echo 'no previous image to go back to'; exit 1; }
      docker tag cashmere-os:previous cashmere-os:latest
      docker compose -f docker-compose.prod.yml up -d --no-build app
      sleep 5
      docker compose -f docker-compose.prod.yml ps app"
    exit 0
    ;;
esac

# ───────────────────────────── before anything ──────────────────────────────

if [ -n "$(git status --porcelain)" ]; then
  echo "There are uncommitted changes. Deploying them would ship something" >&2
  echo "that exists on no branch and cannot be reproduced or rolled back to." >&2
  git status --short >&2
  exit 1
fi

LOCAL_SHA="$(git rev-parse HEAD)"
if ! git merge-base --is-ancestor "$LOCAL_SHA" "origin/$BRANCH" 2>/dev/null; then
  echo "This commit is not on origin/$BRANCH. Push first — the server pulls" >&2
  echo "from the remote, so anything unpushed simply would not arrive." >&2
  exit 1
fi

say "deploying $BRANCH @ ${LOCAL_SHA:0:8} to $HOST"

# ──────────────────────────────── first run ─────────────────────────────────

ssh_run "test -d $DIR/.git" 2>/dev/null || {
  say "first deployment — setting the server up"
  ssh_run "mkdir -p $DIR && git clone --branch '$BRANCH' '$REPO' $DIR"
}

ssh_run "test -f $DIR/.env" 2>/dev/null || {
  echo
  echo "There is no $DIR/.env on the server." >&2
  echo "Create it from .env.production.example and fill in the two secrets:" >&2
  echo "  ssh $HOST" >&2
  echo "  cd $DIR && cp .env.production.example .env && nano .env" >&2
  echo >&2
  echo "Generate them on the server, not here — a secret that has been on a" >&2
  echo "laptop and in a terminal history is a secret with two more places to" >&2
  echo "leak from:" >&2
  echo "  openssl rand -base64 32   # POSTGRES_PASSWORD" >&2
  echo "  openssl rand -base64 48   # AUTH_SECRET" >&2
  exit 1
}

# ────────────────────────────────── deploy ──────────────────────────────────

say "fetching the code"
ssh_run "cd $DIR && git fetch --quiet origin '$BRANCH' && git checkout --quiet '$BRANCH' && git reset --hard --quiet 'origin/$BRANCH' && git log -1 --format='  now at %h  %s'"

say "keeping the current image as the way back"
ssh_run "docker image inspect cashmere-os:latest >/dev/null 2>&1 && docker tag cashmere-os:latest cashmere-os:previous && echo '  tagged cashmere-os:previous' || echo '  nothing to keep — first build'"

say "building"
# Both images, always. The migrate service runs from its own image built at the
# `build` stage, and compose reuses an existing image rather than rebuilding it
# — so building only the app left migrations running from whatever image
# happened to be on the disk. That is silent and it is the dangerous kind: a
# new migration would not be in the stale image, `migrate deploy` would report
# nothing to do, and the fresh app would then start against a schema missing
# the column it was built for.
ssh_run "cd $DIR && docker compose -f docker-compose.prod.yml build app migrate 2>&1 | tail -5"

say "starting"
# Migrations run in the app's entrypoint, before it serves anything.
ssh_run "cd $DIR && docker compose -f docker-compose.prod.yml up -d 2>&1 | tail -6"

say "waiting for it to answer"
ssh_run "for i in \$(seq 1 30); do
  if docker exec cashmere-os-app wget -qO- http://127.0.0.1:3000/login >/dev/null 2>&1; then
    echo '  the application is answering'; exit 0
  fi
  sleep 4
done
echo '  it did not answer in two minutes — the log follows'; docker logs --tail 40 cashmere-os-app; exit 1"

say "backups"
# Installed on every deploy rather than once by hand, so a rebuilt server comes
# back with its backups running instead of quietly without them.
ssh_run "install -m 644 $DIR/deploy/cashmere-backup.service /etc/systemd/system/
  install -m 644 $DIR/deploy/cashmere-backup.timer /etc/systemd/system/
  chmod +x $DIR/scripts/backup.sh
  systemctl daemon-reload
  systemctl enable --now cashmere-backup.timer >/dev/null 2>&1
  systemctl list-timers cashmere-backup.timer --no-pager | sed -n '2p' | awk '{print \"  next backup: \"\$1\" \"\$2\" \"\$3}'"

say "as seen from outside"
SITE="$(ssh_run "grep '^SITE_ADDRESS=' $DIR/.env | cut -d= -f2")"
curl -s -o /dev/null -w "  https://$SITE  HTTP %{http_code}\n" "https://$SITE/login" || true

say "done"
ssh_run "cd $DIR && docker compose -f docker-compose.prod.yml ps --format '  {{.Name}}  {{.Status}}'"
