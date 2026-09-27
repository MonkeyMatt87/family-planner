#!/usr/bin/env bash
# Builds dist/family-planner-<version>.tar.gz (and family-planner.tar.gz, the name the installers fetch
# from "latest") plus SHA256SUMS. Usage: bash scripts/make-release.sh [version]   (default: app/__init__.py)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="${1:-v$(sed -n 's/^__version__ = "\(.*\)"/\1/p' app/__init__.py)}"
FILES=(app netmon caddy/Caddyfile caddy/Dockerfile pi proxmox scripts Dockerfile docker-compose.yml requirements.txt
       .env.example .dockerignore .gitignore README.md LICENSE CHANGELOG.md)
mkdir -p dist
rm -f dist/family-planner*.tar.gz dist/SHA256SUMS
tar --exclude='__pycache__' --exclude='*.pyc' --owner=0 --group=0 --mode='u+rwX,go+rX,go-w' \
    -czf "dist/family-planner-${VERSION}.tar.gz" "${FILES[@]}"
cp "dist/family-planner-${VERSION}.tar.gz" dist/family-planner.tar.gz
cp proxmox/install.sh dist/install-proxmox.sh
cp scripts/install.sh dist/install.sh
(cd dist && sha256sum family-planner-"${VERSION}".tar.gz family-planner.tar.gz install-proxmox.sh install.sh > SHA256SUMS)
echo "Built dist/family-planner-${VERSION}.tar.gz"
cat dist/SHA256SUMS
