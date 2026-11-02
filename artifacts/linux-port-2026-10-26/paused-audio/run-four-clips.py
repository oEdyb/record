import hashlib
import json
import os
import subprocess
import threading
import time
from pathlib import Path

assert Path(os.environ["AGENT_LAB_RUNTIME"]).name == "klippt"
root = Path(os.environ["AGENT_LAB_STATE"]) / "paused-audio"
root.mkdir(exist_ok=True)
sources = json.loads(
    subprocess.check_output(["pactl", "-f", "json", "list", "sources"])
)
selected = [source for source in sources if source["name"] == "lab_mic_source_a"]
assert len(selected) == 1
module = str(selected[0]["owner_module"])
rid = int(time.time() * 1000)
request = {
    "schemaVersion": 1,
    "platform": "linux",
    "recordingId": rid,
    "video": {"fps": 30, "bitrate": 8000000},
    "audio": {
        "system": {"enabled": False},
        "microphone": {"enabled": True, "deviceName": "LabMicrophoneA", "gain": 1},
    },
    "cursor": {"mode": "system"},
    "webcam": {"enabled": False},
    "outputs": {"screenPath": str(root / f"recording-{rid}-clip-0001.mp4")},
}
helper = "/home/olle/dev/screenrec-linux/electron/native/pipewire-capture/build/openscreen-pipewire-helper"
stage = "record0"
clips = []
timers = []
rejected = []
stop_at = None
first_hashes = {}
with (root / "after.stderr.log").open("w") as err:
    p = subprocess.Popen(
        [helper, json.dumps(request)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=err,
        text=True,
    )

    def send(command):
        if p.poll() is None:
            p.stdin.write(command + "\n")
            p.stdin.flush()

    def pause_later():
        timer = threading.Timer(2, send, args=["pause"])
        timers.append(timer)
        timer.start()

    try:
        with (root / "after.events.jsonl").open("w") as log:
            for line in p.stdout:
                event = json.loads(line)
                log.write(line)
                log.flush()
                print(line.rstrip(), flush=True)
                kind = event["event"]
                if kind == "clip-finalized":
                    clips.append(event["clip"])
                elif kind == "recording-started":
                    pause_later()
                elif kind == "recording-paused":
                    if stage == "record0":
                        first_hashes = {
                            key: hashlib.sha256(Path(value).read_bytes()).hexdigest()
                            for key, value in clips[0].items()
                            if key.endswith("Path")
                        }
                        stage = "wait-loss"
                        subprocess.run(["pactl", "unload-module", module], check=True)
                    elif stage == "record1":
                        stage = "configure-b"
                        request["audio"]["microphone"]["deviceName"] = "LabMicrophoneB"
                        send(json.dumps({"command": "reconfigure", "request": request}))
                    elif stage == "record2":
                        stage = "configure-off"
                        request["audio"]["microphone"]["enabled"] = False
                        send(json.dumps({"command": "reconfigure", "request": request}))
                    elif stage == "record3":
                        stage = "stopping"
                        request["audio"]["microphone"]["enabled"] = True
                        stop_at = time.monotonic()
                        send(
                            json.dumps({"command": "reconfigure", "request": request})
                            + "\ncancel-audio-preparation\nstop"
                        )
                elif (
                    kind == "warning"
                    and event["code"] == "audio-input-disconnected"
                    and stage == "wait-loss"
                ):
                    stage = "missing0"
                    send("resume")
                elif kind == "error":
                    if event["code"] == "clip-resume-rejected" and stage in [
                        "missing0",
                        "missing1",
                    ]:
                        assert event["clipIndex"] == 1
                        rejected.append(event)
                        if stage == "missing0":
                            stage = "missing1"
                            send("resume")
                        else:
                            subprocess.run(
                                [
                                    "pactl",
                                    "load-module",
                                    "module-remap-source",
                                    "master=lab_mic_a.monitor",
                                    "source_name=lab_mic_source_a",
                                    "source_properties=device.description=LabMicrophoneA",
                                ],
                                check=True,
                                stdout=subprocess.DEVNULL,
                            )
                            time.sleep(0.1)
                            stage = "record1"
                            send("resume")
                    elif (
                        event["code"] == "reconfigure-rejected" and stage == "stopping"
                    ):
                        pass
                    else:
                        raise RuntimeError(str(event))
                elif kind == "recording-reconfigured":
                    if stage == "configure-b":
                        stage = "record2"
                        send("resume")
                    elif stage == "configure-off":
                        stage = "record3"
                        send("resume")
                    else:
                        raise RuntimeError("Unexpected configuration commit: " + stage)
                elif kind == "recording-resumed":
                    assert event["clipIndex"] == int(stage[-1])
                    pause_later()
                elif kind == "recording-stopped":
                    assert len(event["clips"]) == 4
                    assert len(rejected) == 2
                    assert all(
                        hashlib.sha256(Path(clips[0][key]).read_bytes()).hexdigest()
                        == value
                        for key, value in first_hashes.items()
                    )
                    proof = {
                        "recordingId": rid,
                        "helperPid": p.pid,
                        "clips": event["clips"],
                        "rejections": rejected,
                        "firstHashes": first_hashes,
                        "stopElapsedMs": (time.monotonic() - stop_at) * 1000,
                        "singlePortal": True,
                        "firstClipUnchanged": True,
                    }
                    (root / "after-proof.json").write_text(json.dumps(proof, indent=2))
                    print("AFTER PROOF", proof, flush=True)
        assert p.wait(timeout=5) == 0
    finally:
        for timer in timers:
            timer.cancel()
        if p.poll() is None:
            p.terminate()
            p.wait(timeout=5)
