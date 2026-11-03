#!/bin/bash
# Usage: run-container.sh IMAGE SESSION_SCRIPT OUT_DIR [extra docker args]
# Memory and CPU are capped so a test desktop can never starve the host.
image=$1 session=$2 out=$3; shift 3
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
printf "root:x:0:0::/root:/bin/bash\ntester:x:1000:1000::/home/tester:/bin/bash\n" > "$out/.passwd"
printf "root:x:0:\ntester:x:1000:\n" > "$out/.group"
exec docker run --rm --name "klippt-desktop-$(basename "$session" .sh)" --label klippt-desktops \
  --memory=8g --memory-swap=8g --cpus=6 --pids-limit=4000 --shm-size=1g \
  --security-opt seccomp=unconfined --device /dev/dri/renderD129 --group-add "$(stat -c %g /dev/dri/renderD129)" \
  --tmpfs /run/user/1000:mode=0700,uid=1000,gid=1000 --tmpfs /home/tester:mode=0755,uid=1000,gid=1000 --tmpfs /tmp:mode=1777 \
  -u 1000:1000 -v "${KLIPPT_APP:-$HOME/Applications/Klippt}:/opt/Klippt:ro" -v "$here:/scripts:ro" -v "$out:/out" -v "$out/.passwd:/etc/passwd:ro" -v "$out/.group:/etc/group:ro" \
  --stop-timeout 5 "$@" "$image" dbus-run-session -- bash "/scripts/$session"
