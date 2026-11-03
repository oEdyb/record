# Shared start of a private desktop session inside a container. Sourced by session-*.sh.
set -u
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export HOME=/home/tester XDG_CONFIG_HOME=/home/tester/.config XDG_DATA_HOME=/home/tester/.local/share XDG_CACHE_HOME=/home/tester/.cache
export XDG_SESSION_TYPE=wayland LANG=C.UTF-8 NO_AT_BRIDGE=1
export OUT=/out KLIPPT_PROFILE=$XDG_CONFIG_HOME/Klippt
mkdir -p "$XDG_CONFIG_HOME/xdg-desktop-portal" "$XDG_DATA_HOME" "$XDG_CACHE_HOME" "$OUT"
start_audio() {
  pipewire > "$OUT/pipewire.log" 2>&1 &
  sleep 1
  wireplumber > "$OUT/wireplumber.log" 2>&1 &
  pipewire-pulse > "$OUT/pipewire-pulse.log" 2>&1 &
  sleep 1
}
start_portal() {
  /usr/lib/xdg-desktop-portal > "$OUT/xdp.log" 2>&1 || /usr/libexec/xdg-desktop-portal > "$OUT/xdp.log" 2>&1 &
  sleep 2
}
run_journey() {
  mkdir -p "$KLIPPT_PROFILE"
  APP="/opt/Klippt/klippt --ozone-platform=wayland --enable-logging=stderr"
  python3 /scripts/drive.py --name "$1" --out "$OUT" --profile "$(profile_dir)" \
    --socket "$XDG_RUNTIME_DIR/klippt-agent.sock" --app "$APP" "${@:2}"
}
profile_dir() { echo "$XDG_CONFIG_HOME/Klippt"; }
