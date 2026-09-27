#!/usr/bin/env bash
# Family Planner for Proxmox VE: creates a Debian LXC with Docker and the planner in it.
# Run on the Proxmox host (the node's Shell in the web UI):
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/Mcross87/family-planner/main/proxmox/install.sh)"
#
# Offline / from a downloaded release (copy both files to the host first):
#   bash install.sh --release family-planner-v1.0.0.tar.gz
#
# Options (or set them as environment variables, e.g. CTID=120 bash install.sh):
#   --ctid N          container ID (default: the next free one)
#   --hostname NAME   default family-planner
#   --storage NAME    where the disk goes (default: local-lvm, else the first storage that holds containers)
#   --disk GB         default 8        --cores N   default 2        --ram MB   default 1024
#   --bridge NAME     default vmbr0
#   --ip CIDR         e.g. 192.168.1.50/24 (default: DHCP)    --gw IP   gateway for a static IP
#   --homelab         also run the network scan + hourly speed test (Homelab tab)
#   --release FILE    install from a downloaded release instead of GitHub
#   -y                don't ask, use the settings above
set -euo pipefail

REPO="${FP_REPO:-Mcross87/family-planner}"
CTID="${CTID:-}"
HOSTNAME_="${CT_HOSTNAME:-family-planner}"
STORAGE="${STORAGE:-}"
DISK="${DISK:-8}"
CORES="${CORES:-2}"
RAM="${RAM:-1024}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"
GW="${GW:-}"
HOMELAB="${HOMELAB:-0}"
RELEASE="${RELEASE:-}"
YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ctid) CTID="$2"; shift 2 ;;
    --hostname) HOSTNAME_="$2"; shift 2 ;;
    --storage) STORAGE="$2"; shift 2 ;;
    --disk) DISK="$2"; shift 2 ;;
    --cores) CORES="$2"; shift 2 ;;
    --ram) RAM="$2"; shift 2 ;;
    --bridge) BRIDGE="$2"; shift 2 ;;
    --ip) IP="$2"; shift 2 ;;
    --gw) GW="$2"; shift 2 ;;
    --homelab) HOMELAB=1; shift ;;
    --release) RELEASE="$2"; shift 2 ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }
ask() {  # ask "Question" default -> answer
  local reply
  if [[ $YES -eq 1 || ! -t 0 && ! -e /dev/tty ]]; then echo "$2"; return; fi
  read -r -p "$1 [$2]: " reply </dev/tty || true
  echo "${reply:-$2}"
}

[[ $EUID -eq 0 ]] || die "run this as root on the Proxmox host"
command -v pct >/dev/null && command -v pveam >/dev/null || die "this doesn't look like a Proxmox VE host (no pct/pveam)"
if [[ -n "$RELEASE" ]]; then
  RELEASE="$(readlink -f "$RELEASE")"
  [[ -f "$RELEASE" ]] || die "can't find the release file $RELEASE"
fi

echo
printf '\033[1m  Family Planner · Proxmox installer\033[0m\n'
echo "  A calendar, chores, school lunches and shifts for the whole family, on your own server."
echo

# ---------------------------------------------------------------- settings
[[ -n "$CTID" ]] || CTID="$(pvesh get /cluster/nextid)"
if [[ -z "$STORAGE" ]]; then
  if pvesm status -content rootdir 2>/dev/null | awk 'NR>1 {print $1}' | grep -qx local-lvm; then
    STORAGE=local-lvm
  else
    STORAGE="$(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active" {print $1; exit}')"
  fi
fi
[[ -n "$STORAGE" ]] || die "no storage for containers found (Datacenter → Storage → a storage with 'Container' content)"

if [[ $YES -eq 0 ]]; then
  CTID="$(ask "Container ID" "$CTID")"
  HOSTNAME_="$(ask "Hostname" "$HOSTNAME_")"
  STORAGE="$(ask "Storage for the disk" "$STORAGE")"
  DISK="$(ask "Disk size (GB)" "$DISK")"
  CORES="$(ask "CPU cores" "$CORES")"
  RAM="$(ask "Memory (MB)" "$RAM")"
  BRIDGE="$(ask "Network bridge" "$BRIDGE")"
  IP="$(ask "IP address (dhcp, or e.g. 192.168.1.50/24)" "$IP")"
  if [[ "$IP" != "dhcp" ]]; then GW="$(ask "Gateway" "${GW:-$(ip route | awk '/default/ {print $3; exit}')}")"; fi
  H="$(ask "Also add the Homelab tools (network scan + hourly speed test)? y/n" "$([[ $HOMELAB -eq 1 ]] && echo y || echo n)")"
  [[ "$H" =~ ^[Yy] ]] && HOMELAB=1 || HOMELAB=0
fi

pct status "$CTID" >/dev/null 2>&1 && die "container $CTID already exists; pick another ID (--ctid)"
[[ "$IP" == "dhcp" || "$IP" == */* ]] || die "give the IP with its size, e.g. 192.168.1.50/24"
NET="name=eth0,bridge=${BRIDGE},ip=${IP}"
[[ "$IP" != "dhcp" && -n "$GW" ]] && NET="${NET},gw=${GW}"

# ---------------------------------------------------------------- template (Debian 12, or 13 if that's all there is)
TEMPLATE="$(pveam list local 2>/dev/null | awk '{print $1}' | grep -E 'debian-1[23]-standard' | sort -V | tail -1 || true)"
if [[ -z "$TEMPLATE" ]]; then
  say "Downloading the Debian container template"
  pveam update >/dev/null || true
  NAME="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-12-standard' | sort -V | tail -1)"
  [[ -n "$NAME" ]] || NAME="$(pveam available --section system | awk '{print $2}' | grep -E '^debian-13-standard' | sort -V | tail -1)"
  [[ -n "$NAME" ]] || die "couldn't find a Debian template (is the host online? or download one: pveam download local debian-12-standard...)"
  pveam download local "$NAME" >/dev/null
  TEMPLATE="local:vztmpl/$NAME"
fi
say "Template: $TEMPLATE"

# ---------------------------------------------------------------- create and start
say "Creating container $CTID ($HOSTNAME_, ${CORES} cores, ${RAM} MB, ${DISK} GB on $STORAGE)"
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HOSTNAME_" --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "${STORAGE}:${DISK}" --net0 "$NET" \
  --unprivileged 1 --features nesting=1,keyctl=1 --onboot 1 \
  --timezone host --tags family-planner \
  --description "Family Planner · http://<ip>:8080 · installed $(date +%F)" >/dev/null
pct start "$CTID"

say "Waiting for the network"
for _ in $(seq 1 60); do
  CT_IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$CT_IP" ]] && pct exec "$CTID" -- getent hosts deb.debian.org >/dev/null 2>&1 && break
  sleep 2
done
[[ -n "${CT_IP:-}" ]] || die "container $CTID didn't get an IP address (check the bridge/DHCP), then run: pct enter $CTID"

# ---------------------------------------------------------------- install inside
say "Installing Docker and the planner inside the container (a few minutes)"
pct exec "$CTID" -- bash -c "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates >/dev/null"
ARGS=()
[[ $HOMELAB -eq 1 ]] && ARGS+=(--homelab)
if [[ -n "$RELEASE" ]]; then
  pct push "$CTID" "$RELEASE" /root/family-planner.tar.gz
  tar -xzOf "$RELEASE" --wildcards '*scripts/install.sh' > /tmp/fp-install-$$.sh
  pct push "$CTID" /tmp/fp-install-$$.sh /root/install.sh
  rm -f /tmp/fp-install-$$.sh
  ARGS+=(--release /root/family-planner.tar.gz)
else
  pct exec "$CTID" -- bash -c "curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh -o /root/install.sh"
fi
pct exec "$CTID" -- env FP_REPO="$REPO" bash /root/install.sh "${ARGS[@]}"
pct set "$CTID" --description "Family Planner · http://${CT_IP}:8080 · installed $(date +%F)" >/dev/null

echo
printf '\033[1;32m  Done! Family Planner is running in container %s.\033[0m\n' "$CTID"
echo
echo "  1. On a computer or phone on your home network, open:  http://${CT_IP}:8080/setup"
echo "  2. Add your family, pick your town and a family PIN."
echo "  3. For phones away from home, see 'Reach it from your phones' in the README."
echo
echo "  Console: pct enter $CTID   ·   Update: run this installer's inside step again: pct exec $CTID -- bash /root/install.sh"
[[ "$IP" == "dhcp" ]] && echo "  Tip: reserve ${CT_IP} for this container in your router's DHCP settings so the address never changes."
exit 0
