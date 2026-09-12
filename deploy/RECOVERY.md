# Backups, alerts and recovery

For whoever runs the server. The nightly backup (`scripts/backup.sh`, run by
`cashmere-backup.timer`) dumps the database, restores the dump into a scratch
database to prove it loads and still balances, and archives the product photos.
Everything below is about the two things it cannot do on its own: survive the
loss of the server, and tell somebody when it fails.

## One-time setup

### 1. The backup key — on your laptop, never on the server

```sh
age-keygen -o cashmere-backup.key     # prints: Public key: age1...
```

- The **public** key (`age1...`) goes on the server as `CASHMERE_BACKUP_RECIPIENT`.
  It can only seal.
- The **private** key file opens the backups. Keep it in the owner's password
  manager and a second copy offline (a USB key in a drawer). If it is lost, no
  offsite copy can be opened. If it is only on the server, it is lost with the
  server — which is the one case the offsite copy exists for.

### 2. Storage the server does not control

Any provider rclone speaks to. Backblaze B2 as an example:

1. Create a private bucket, e.g. `cashmere-backups`, with **Object Lock** on
   (or at least versioning) and a lifecycle rule that keeps copies for 90 days.
2. Create an application key limited to that bucket, **without `deleteFiles`**.
   Somebody who takes over the server can then add files but not remove the
   history — ransomware cannot delete what the key cannot delete.
3. On the server: `rclone config` → new remote `b2` with that key.
4. Check: `rclone lsd b2:cashmere-backups`.

### 3. Something that notices

- **Backups:** a check at <https://healthchecks.io> (free tier is enough),
  period 1 day, grace 6 hours, alerts to email/WhatsApp/Telegram. Its ping URL
  is `CASHMERE_BACKUP_PING_URL`. It alerts on a failed run, and on a night with
  no run at all — a dead server, a stopped timer — which nothing on the server
  can report about itself.
- **The application:** an uptime monitor (UptimeRobot, healthchecks.io, Better
  Stack…) on `https://<SITE_ADDRESS>/api/health` every 5 minutes. It answers
  `200` only when the application can reach the database, and `503` otherwise.
  Checked from outside, it also catches the server or its network going down.

### 4. On the server

```sh
mkdir -p /etc/cashmere
cp /opt/cashmere-os/deploy/backup.env.example /etc/cashmere/backup.env
chmod 600 /etc/cashmere/backup.env
nano /etc/cashmere/backup.env        # recipient, offsite remote, ping URL
systemctl start cashmere-backup.service && journalctl -u cashmere-backup -n 30
```

The next deploy installs `age` and `rclone` if missing, and warns on every
deploy for as long as backups do not leave the server or nothing is watching.

Each night's offsite folder, `<CASHMERE_OFFSITE>/<stamp>/`, holds:

| file | what |
|---|---|
| `cashmere_os-<stamp>.sql.gz.age` | the database, verified before sealing |
| `uploads-<stamp>.tar.gz.age` | the product photographs |
| `env-<stamp>.age` | the server's `.env` — the secrets a replacement server needs |
| `version-<stamp>.txt` | the commit that was running |

## Restoring on the same server

```sh
cd /opt/cashmere-os
scripts/backup.sh restore backups/cashmere_os-20260911-030000.sql.gz
```

It loads the file into `cashmere_os_restore_stage` and checks it first; a file
that does not load or does not balance stops there, and the live database is
never touched. Only then does it ask you to type the database name, stop the
app, and swap the databases by renaming them. The old database is **kept** as
`cashmere_os_before_restore_<stamp>`; drop it once you are satisfied. The
migrate step then brings the schema up to date and re-creates the app's login
grants (a dump carries neither), and the app starts again.

For an offsite copy, first fetch it (`rclone copy b2:cashmere-backups/os/<stamp> .`)
and pass the `.age` file with `CASHMERE_BACKUP_IDENTITY=/path/to/cashmere-backup.key`.
Copy the key onto the server for the restore only, and delete it afterwards.

Photos: `scripts/backup.sh restore-photos uploads-<stamp>.tar.gz[.age]` — adds
and overwrites, never deletes.

## Recovering onto a new server

Time it the first time, and write the time down here.

1. New Ubuntu server with Docker. Point the DNS name at it.
2. Fetch the latest offsite folder and the private key onto your laptop, and
   unseal the settings: `age -d -i cashmere-backup.key env-<stamp>.age > env`.
3. From your laptop, with `CASHMERE_HOST=root@<new-ip>`, check out the commit
   in `version-<stamp>.txt` and run `scripts/deploy.sh`. It stops asking for a
   `.env`: copy the unsealed `env` to `/opt/cashmere-os/.env`, then run
   `scripts/deploy.sh` again. It builds, migrates an empty database and starts.
4. Copy the `.age` dump, the photos and the key to the server, then:
   ```sh
   export CASHMERE_BACKUP_IDENTITY=/root/cashmere-backup.key
   scripts/backup.sh restore cashmere_os-<stamp>.sql.gz.age
   UPLOAD_DIR=/var/lib/docker/volumes/cashmere-os_uploads/_data \
     scripts/backup.sh restore-photos uploads-<stamp>.tar.gz.age
   shred -u /root/cashmere-backup.key
   ```
5. Set up `/etc/cashmere/backup.env` and `rclone config` again (step 4 of the
   setup), log in, and check the trial balance and a few recent sales.

TLS needs nothing: Caddy fetches a new certificate once DNS points at the
server. Shopify keeps working because the `.env` brought the same
`INTEGRATION_SECRET_KEY`; with a different key, reconnect the shop.

**Rehearse it** on a throwaway server once, and again after any change to
this procedure. A recovery nobody has timed is an estimate.

## Server access (audit H06)

Not changed by any script here — do these by hand. Found in the audit: root and
password logins both allowed, and port 22 open to the whole internet.

First make sure there is a way back in that does not use SSH — the hosting
provider's browser console — and keep a second SSH session open while
changing anything, so a mistake cannot lock you out. Then:

- SSH keys only: in `/etc/ssh/sshd_config` (and any file under
  `sshd_config.d/`, which overrides it) set `PasswordAuthentication no` and
  `PermitRootLogin prohibit-password`; `sshd -t && systemctl reload ssh`.
  `sshd -T | grep -Ei 'passwordauth|permitroot'` shows what is in effect.
  `prohibit-password` keeps the deploy key working; moving deploys to a
  non-root user with sudo is the fuller fix.
- Port 22 only from where you work, if your addresses are stable:
  `ufw allow from <your-ip> to any port 22 proto tcp`, then remove the general
  22 rule. If they are not, add `fail2ban` instead. 80 and 443 stay open.
- Automatic security updates: `apt install unattended-upgrades`.
- One key per person, and remove a person's key from
  `~/.ssh/authorized_keys` when they leave.
