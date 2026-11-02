"""Run only inside agent-lab; leave approval tokens in its private profile."""
import json
import os
import selectors
import subprocess
import sys
import time
from pathlib import Path

runtime = Path(os.environ["AGENT_LAB_RUNTIME"])
assert runtime.name == "klippt" and str(runtime).startswith("/run/user/")
root = Path(os.environ["AGENT_LAB_STATE"]) / "remembered-source"
root.mkdir(mode=0o700, exist_ok=True)
phase = sys.argv[1]
assert phase in {"choose", "reuse", "choose-again", "cancel", "reuse-after-cancel"}
request = {
    "schemaVersion": 1, "platform": "linux", "deferStart": True,
    "source": {"type": "display", "sourceId": "portal:choose" if phase in {"choose", "choose-again", "cancel"} else "portal:selected"},
    "video": {"fps": 30, "bitrate": 8000000},
    "audio": {"system": {"enabled": False}, "microphone": {"enabled": False, "gain": 1}},
    "webcam": {"enabled": False}, "cursor": {"mode": "system"},
    "outputs": {"screenPath": str(root / f"{phase}.mp4")},
    "portalStatePath": str(root / "grant.json"),
}
helper = "/home/olle/dev/screenrec-linux/electron/native/pipewire-capture/target/release/openscreen-pipewire-helper"
started = time.monotonic()
summary = {"phase": phase, "selectedSeconds": None, "started": False, "clips": []}
with (root / f"{phase}.stderr.log").open("w") as errors:
    process = subprocess.Popen([helper, json.dumps(request)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors, text=True)
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    stop_at = None
    try:
        with (root / f"{phase}.events.jsonl").open("w") as log:
            while time.monotonic() - started < 75:
                if stop_at is not None and time.monotonic() >= stop_at:
                    process.stdin.write("stop\n")
                    process.stdin.flush()
                    stop_at = None
                if not selector.select(0.1):
                    if process.poll() is not None:
                        break
                    continue
                line = process.stdout.readline()
                if not line:
                    break
                log.write(line)
                log.flush()
                event = json.loads(line)
                kind = event["event"]
                if kind not in {"cursor-sample", "debug", "capture-timing"}:
                    print(json.dumps(event), flush=True)
                if kind == "source-selected":
                    summary["selectedSeconds"] = round(time.monotonic() - started, 3)
                    process.stdin.write("record\n")
                    process.stdin.flush()
                elif kind == "recording-started":
                    summary["started"] = True
                    stop_at = time.monotonic() + 2
                elif kind == "clip-finalized":
                    summary["clips"].append(event["clip"])
            else:
                raise TimeoutError("Owned portal probe exceeded 75 seconds")
        summary["exitCode"] = process.wait(timeout=5)
        cache = root / "grant.json"
        summary["grantSaved"] = cache.exists()
        if cache.exists():
            summary["grantPermissions"] = oct(cache.stat().st_mode & 0o777)
        (root / f"{phase}.summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(json.dumps(summary), flush=True)
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
