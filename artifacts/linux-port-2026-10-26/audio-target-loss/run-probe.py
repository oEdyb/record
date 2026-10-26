"""Run only inside agent-lab, after creating the documented private tone sources."""
import argparse
import json
import os
from pathlib import Path
import selectors
import shlex
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument("probe")
parser.add_argument("label", choices=["before", "after", "default"])
parser.add_argument("target")
args = parser.parse_args()
runtime = os.environ.get("AGENT_LAB_RUNTIME", "")
if runtime != os.environ.get("XDG_RUNTIME_DIR") or not runtime.startswith(f"/run/user/{os.getuid()}/agent-lab/"):
    raise RuntimeError("Private lab required")
output = Path(os.environ["AGENT_LAB_STATE"]) / "audio-routing"
output.mkdir(exist_ok=True)
modules = json.loads(subprocess.check_output(["pactl", "-f", "json", "list", "modules"], text=True))
selected = [m["index"] for m in modules if "source_name=lab_mic_source_a" in shlex.split(m["argument"])]
if len(selected) != 1:
    raise RuntimeError("Expected exactly one owned microphone A remap module")
with (output / f"{args.label}.raw").open("wb") as pcm:
    process = subprocess.Popen([args.probe, args.target, "9"], stdout=pcm, stderr=subprocess.PIPE)
    if process.stderr is None:
        raise RuntimeError("Probe stderr unavailable")
    selector = selectors.DefaultSelector()
    selector.register(process.stderr, selectors.EVENT_READ)
    events = b""
    try:
        deadline = time.monotonic() + 5
        while b"FIRST " not in events:
            if time.monotonic() >= deadline:
                raise RuntimeError("Selected source did not deliver PCM")
            if selector.select(0.1):
                block = os.read(process.stderr.fileno(), 4096)
                if not block:
                    raise RuntimeError("Probe exited before PCM")
                events += block
        time.sleep(3)
        subprocess.run(["pactl", "unload-module", str(selected[0])], check=True)
        events += b"REMOVED owned microphone A; default B remains available\n"
        events += process.communicate(timeout=15)[1]
        if process.returncode:
            raise RuntimeError(f"Probe exited with {process.returncode}")
    finally:
        selector.close()
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        (output / f"{args.label}.events.log").write_bytes(events)
print(events.decode())
