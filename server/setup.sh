#!/usr/bin/env bash
# Run on the VPS as root:  bash /opt/sumods/server/setup.sh
set -euo pipefail
cd /opt/sumods
git pull --ff-only || true
apt-get update
apt-get -y install python3-venv python3-pip debian-keyring debian-archive-keyring apt-transport-https curl gpg ufw
id sumods >/dev/null 2>&1 || useradd --system --home /opt/sumods --shell /usr/sbin/nologin sumods
python3 -m venv venv
venv/bin/pip install -q -r scraper/requirements.txt

if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get -y install caddy
fi
cp server/Caddyfile /etc/caddy/Caddyfile
cp server/sumods-seats.service /etc/systemd/system/sumods-seats.service
chown -R sumods:sumods /opt/sumods
systemctl daemon-reload
systemctl enable --now sumods-seats
systemctl restart caddy

ufw allow OpenSSH >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
sleep 2
curl -s localhost:8787/health; echo
echo "done — try: curl 'https://seats.sumods.com/?term=202601&crns=10271'"
