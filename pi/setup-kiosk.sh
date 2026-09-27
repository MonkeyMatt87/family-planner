#!/usr/bin/env bash
# Turns a Raspberry Pi (Raspberry Pi OS with desktop) into the family wall screen.
#
#   curl -O http://<planner-ip>:8080/... or copy this file over, then:
#   bash setup-kiosk.sh http://192.168.1.50:8080/display [off-time] [on-time]
#
#   e.g. bash setup-kiosk.sh http://192.168.1.50:8080/display 22:30 06:00
#
# Run as the normal desktop user (not root). Reboot when it finishes.
set -euo pipefail

URL="${1:-}"
OFF="${2:-22:30}"
ON="${3:-06:00}"

if [[ -z "$URL" ]]; then
  echo "Usage: bash $0 <display-url> [screen-off HH:MM] [screen-on HH:MM]"
  echo "  e.g. bash $0 http://192.168.1.50:8080/display 22:30 06:00"
  exit 1
fi
if [[ $EUID -eq 0 ]]; then
  echo "Run this as your normal Pi user, not with sudo (it will ask for sudo when needed)."
  exit 1
fi

echo "==> Installing Chromium and screen tools"
sudo apt-get update -qq
if apt-cache show chromium >/dev/null 2>&1; then CHROME_PKG=chromium; else CHROME_PKG=chromium-browser; fi
sudo apt-get install -y -qq "$CHROME_PKG" wlr-randr x11-xserver-utils unclutter >/dev/null || \
  sudo apt-get install -y -qq "$CHROME_PKG" >/dev/null
# Weather and lunch icons are emoji; without this font they show as empty boxes.
sudo apt-get install -y -qq fonts-noto-color-emoji >/dev/null || echo "   (couldn't install the emoji font - icons may show as boxes)"
CHROME_BIN="$(command -v chromium || command -v chromium-browser)"

echo "==> Turning off screen blanking"
sudo raspi-config nonint do_blanking 1 || true

echo "==> Launching the planner full screen at login"
mkdir -p ~/.config/autostart
cat > ~/.local-family-kiosk.sh <<EOF
#!/usr/bin/env bash
# Wait for the network so the first load doesn't show an error page.
for i in \$(seq 1 60); do
  curl -fs -o /dev/null "${URL%/display}/health" && break
  sleep 2
done
# Clear any "Chromium didn't shut down correctly" bubble after a power cut.
sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' \
  ~/.config/chromium/Default/Preferences 2>/dev/null || true
command -v unclutter >/dev/null && unclutter -idle 1 &
exec "$CHROME_BIN" --kiosk --noerrdialogs --disable-infobars --no-first-run \\
  --disable-session-crashed-bubble --disable-features=Translate --overscroll-history-navigation=0 \\
  --check-for-update-interval=31536000 --password-store=basic "${URL}?kiosk=1"
EOF
chmod +x ~/.local-family-kiosk.sh

cat > ~/.config/autostart/family-planner.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Family Planner
Exec=$HOME/.local-family-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

echo "==> Screen on/off schedule ($OFF off, $ON on)"
sudo tee /usr/local/bin/family-screen >/dev/null <<'EOF'
#!/usr/bin/env bash
# family-screen on|off  - works on Wayland (labwc/wayfire) and X11
STATE="$1"
USER_ID="$(id -u "${SUDO_USER:-$USER}")"
export XDG_RUNTIME_DIR="/run/user/$USER_ID" WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}" DISPLAY="${DISPLAY:-:0}"
if command -v wlr-randr >/dev/null && wlr-randr >/dev/null 2>&1; then
  for out in $(wlr-randr | awk '/^[A-Z]/{print $1}'); do
    wlr-randr --output "$out" "--$STATE"
  done
elif command -v xset >/dev/null && xset q >/dev/null 2>&1; then
  if [[ "$STATE" == off ]]; then xset dpms force off; else xset dpms force on; xset s reset; fi
else
  vcgencmd display_power "$([[ "$STATE" == off ]] && echo 0 || echo 1)"
fi
EOF
sudo chmod +x /usr/local/bin/family-screen

OFF_H=${OFF%:*}; OFF_M=${OFF#*:}; ON_H=${ON%:*}; ON_M=${ON#*:}
( crontab -l 2>/dev/null | grep -v family-screen || true
  echo "$((10#$OFF_M)) $((10#$OFF_H)) * * * /usr/local/bin/family-screen off"
  echo "$((10#$ON_M)) $((10#$ON_H)) * * * /usr/local/bin/family-screen on"
) | crontab -

echo "==> Making sure the Pi logs into the desktop automatically"
sudo raspi-config nonint do_boot_behaviour B4 || true

echo
echo "Done. Reboot with:  sudo reboot"
echo "Test the screen schedule any time with:  family-screen off   /   family-screen on"
