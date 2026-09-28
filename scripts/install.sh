#!/usr/bin/env bash
# Family Planner installer for a Debian or Ubuntu machine (a Proxmox LXC, a VM, a mini PC, a Pi 4/5).
# Installs Docker if needed, puts the planner in /opt/family-planner and starts it.
#
#   From GitHub:      curl -fsSL https://raw.githubusercontent.com/MonkeyMatt87/family-planner/main/scripts/install.sh | bash
#   From a download:  bash install.sh --release family-planner-v1.0.0.tar.gz
#   Options:          --dir /opt/family-planner   --version v1.0.0   --homelab (network scan + speed tests)
#
# Running it again updates the planner and keeps your data (data/) and settings (.env).
set -euo pipefail

REPO="${FP_REPO:-MonkeyMatt87/family-planner}"
DIR="/opt/family-planner"
VERSION="latest"
RELEASE=""
HOMELAB=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) RELEASE="$2"; shift 2 ;;
    --dir) DIR="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --homelab) HOMELAB=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash install.sh ...)"
command -v apt-get >/dev/null || die "this installer needs Debian or Ubuntu (apt)"

if ! command -v curl >/dev/null || ! command -v tar >/dev/null; then
  say "Installing curl"
  apt-get update -qq && apt-get install -y -qq curl ca-certificates tar >/dev/null
fi

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Installing Docker (from get.docker.com)"
  curl -fsSL https://get.docker.com | sh >/dev/null
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
if [[ -n "$RELEASE" ]]; then
  [[ -f "$RELEASE" ]] || die "can't find $RELEASE"
  say "Using $RELEASE"
  cp "$RELEASE" "$WORK/release.tar.gz"
else
  if [[ "$VERSION" == "latest" ]]; then
    URL="https://github.com/$REPO/releases/latest/download/family-planner.tar.gz"
  else
    URL="https://github.com/$REPO/releases/download/$VERSION/family-planner.tar.gz"
  fi
  say "Downloading $URL"
  curl -fsSL "$URL" -o "$WORK/release.tar.gz" || die "download failed (is the repository published? or use --release <file>)"
fi

say "Unpacking into $DIR"
mkdir -p "$DIR" "$WORK/src"
tar -xzf "$WORK/release.tar.gz" -C "$WORK/src"
SRC="$WORK/src"
[[ -f "$SRC/docker-compose.yml" ]] || SRC="$(dirname "$(find "$WORK/src" -maxdepth 2 -name docker-compose.yml | head -1)")"
[[ -f "$SRC/docker-compose.yml" ]] || die "that file doesn't look like a Family Planner release"
# Replace the program files; never touch data/, .env or the certificates.
find "$DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name .env ! -name caddy -exec rm -rf {} +
if [[ -d "$DIR/caddy" ]]; then
  find "$DIR/caddy" -mindepth 1 -maxdepth 1 ! -name data ! -name config -exec rm -rf {} +
fi
cp -a "$SRC/." "$DIR/"
mkdir -p "$DIR/data"

if [[ ! -f "$DIR/.env" ]]; then
  say "Writing $DIR/.env"
  TZ_NAME="$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value 2>/dev/null || echo UTC)"
  sed -e "s#^TZ=.*#TZ=${TZ_NAME}#" "$DIR/.env.example" > "$DIR/.env"
  IFACE="$(ip -o -4 route show to default 2>/dev/null | awk '{print $5; exit}')"
  if [[ -n "$IFACE" ]]; then sed -i "s#^NETMON_IFACE=.*#NETMON_IFACE=${IFACE}#" "$DIR/.env"; fi
fi
if [[ $HOMELAB -eq 1 ]] && ! grep -q '^COMPOSE_PROFILES=.*homelab' "$DIR/.env"; then
  sed -i -E 's#^COMPOSE_PROFILES=(.*)$#COMPOSE_PROFILES=\1,homelab#; s#^COMPOSE_PROFILES=,#COMPOSE_PROFILES=#' "$DIR/.env"
fi

say "Building and starting (the first time takes a few minutes)"
cd "$DIR"
docker compose up -d --build --remove-orphans

for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$(grep -oP '^PLANNER_PORT=\K\d+' .env || echo 8080)/health" >/dev/null 2>&1 && break
  sleep 2
done

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT="$(grep -oP '^PLANNER_PORT=\K\d+' .env || echo 8080)"
echo
printf '\033[1;32mFamily Planner is running.\033[0m\n'
echo "  Open http://${IP:-<this machine>}:${PORT}/setup from a computer or phone on your home network."
echo "  Files: $DIR  ·  Data: $DIR/data  ·  Update: run this installer again"
