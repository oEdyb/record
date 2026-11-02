import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

assert Path(os.environ["AGENT_LAB_RUNTIME"]).name == "klippt"
current = Path(Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1])
assert current.parent.name == "agents-lab.slice"
group = Path("/sys/fs/cgroup") / str(
    current.parent / "agent-lab-klippt.service"
).lstrip("/")
pids = [
    int(p)
    for p in (group / "cgroup.procs").read_text().split()
    if Path("/proc", p, "comm").read_text().strip() == "pipewire"
]
assert len(pids) == 1
root = Path(os.environ["AGENT_LAB_STATE"]) / "paused-audio"
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
fd = None
timers = []
forced_resume = False
stop_at = None
stopped_at = None
with (root / "frozen-stop.stderr.log").open("w") as err:
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

    def stop():
        global stop_at
        stop_at = time.monotonic()
        send("cancel-audio-preparation\nstop")

    def emergency_resume():
        global forced_resume
        forced_resume = True
        signal.pidfd_send_signal(fd, signal.SIGCONT)

    try:
        with (root / "frozen-stop.events.jsonl").open("w") as log:
            for line in p.stdout:
                log.write(line)
                log.flush()
                print(line.rstrip(), flush=True)
                event = json.loads(line)
                if event["event"] == "recording-started":
                    t = threading.Timer(2, send, args=["pause"])
                    timers.append(t)
                    t.start()
                elif event["event"] == "recording-paused":
                    fd = os.pidfd_open(pids[0])
                    signal.pidfd_send_signal(fd, signal.SIGSTOP)
                    request["audio"]["microphone"]["deviceName"] = "LabMicrophoneB"
                    send(json.dumps({"command": "reconfigure", "request": request}))
                    t = threading.Timer(0.05, stop)
                    timers.append(t)
                    t.start()
                    t = threading.Timer(3, emergency_resume)
                    timers.append(t)
                    t.start()
                elif event["event"] == "recording-stopped":
                    assert len(event["clips"]) == 1
                    stopped_at = time.monotonic()
        code = p.wait(timeout=5)
        exited = time.monotonic()
        assert code == 0
        assert stopped_at is not None
        assert not forced_resume
        proof = {
            "recordingId": rid,
            "helperPid": p.pid,
            "privateDaemonPid": pids[0],
            "stopAckMs": (stopped_at - stop_at) * 1000,
            "helperExitMs": (exited - stop_at) * 1000,
            "daemonFrozenThroughExit": True,
            "forcedResume": False,
            "clipCount": 1,
        }
        assert proof["helperExitMs"] < 1000
        (root / "frozen-stop-proof.json").write_text(json.dumps(proof, indent=2))
        print(proof, flush=True)
    finally:
        for timer in timers:
            timer.cancel()
            timer.join()
        if fd is not None:
            signal.pidfd_send_signal(fd, signal.SIGCONT)
            os.close(fd)
        if p.poll() is None:
            p.terminate()
            p.wait(timeout=5)
