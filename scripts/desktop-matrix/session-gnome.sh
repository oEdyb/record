#!/bin/bash
# Private headless GNOME Shell with the real xdg-desktop-portal-gnome backend.
. /scripts/common.sh
export XDG_CURRENT_DESKTOP=GNOME XDG_SESSION_DESKTOP=gnome GDK_BACKEND=wayland MUTTER_DEBUG_DUMMY_MODE_SPECS=1920x1080
start_audio
gnome-shell --headless --virtual-monitor 1920x1080 --wayland --unsafe-mode --no-x11 > "$OUT/gnome-shell.log" 2>&1 \
  || gnome-shell --headless --virtual-monitor 1920x1080 --wayland --unsafe-mode > "$OUT/gnome-shell.log" 2>&1 &
for i in $(seq 100); do [ -e "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep .2; done
export WAYLAND_DISPLAY=wayland-0
gnome-shell --version > "$OUT/compositor-version.txt"
dbus-update-activation-environment WAYLAND_DISPLAY XDG_CURRENT_DESKTOP GDK_BACKEND
for p in /usr/lib/xdg-desktop-portal-gnome /usr/libexec/xdg-desktop-portal-gnome; do [ -x $p ] && { $p > "$OUT/xdp-gnome.log" 2>&1 & }; done
for p in /usr/lib/xdg-desktop-portal-gtk /usr/libexec/xdg-desktop-portal-gtk; do [ -x $p ] && { $p > "$OUT/xdp-gtk.log" 2>&1 & }; done
sleep 2
start_portal
foot -e sh -c 'while :; do date +%s.%N; sleep .05; done' > /dev/null 2>&1 &
sleep 2
if [ -n "${JOURNEY_PROBE:-}" ]; then exec bash /scripts/$JOURNEY_PROBE; fi
cat > /tmp/type-path.sh <<'TYPE'
#!/bin/sh
exec python3 /scripts/gnome-keys.py Control+a sleep:0.3 "text:$1" sleep:0.5 Return
TYPE
chmod +x /tmp/type-path.sh
run_journey "${JOURNEY_NAME:-gnome}" --type-path /tmp/type-path.sh --screenshot 'sh /scripts/gnome-shot.sh {}' \
  --approve-picker /scripts/gnome-approve.sh --picker-timeout 40
