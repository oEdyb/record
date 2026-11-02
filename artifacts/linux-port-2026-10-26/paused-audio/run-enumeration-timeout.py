import json
import os
import signal
import subprocess
import time
from pathlib import Path

assert Path(os.environ["AGENT_LAB_RUNTIME"]).name == "klippt"
unit = "agent-lab-klippt.service"
current = Path(Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1])
assert current.parent.name == "agents-lab.slice"
cgroup = str(current.parent / unit)
pids = [
    int(p)
    for p in (Path("/sys/fs/cgroup") / cgroup.lstrip("/") / "cgroup.procs")
    .read_text()
    .split()
    if Path("/proc", p, "comm").read_text().strip() == "pipewire"
]
assert len(pids) == 1
before = subprocess.run(
    ["/tmp/klippt-audio-enum-probe"],
    capture_output=True,
    text=True,
    timeout=3,
    check=False,
)
assert before.returncode == 0, before.stderr
fd = os.pidfd_open(pids[0])
signal.pidfd_send_signal(fd, signal.SIGSTOP)
try:
    start = time.monotonic()
    result = subprocess.run(
        ["/tmp/klippt-audio-enum-probe"],
        capture_output=True,
        text=True,
        timeout=3,
        check=False,
    )
    elapsed = time.monotonic() - start
    assert result.returncode == 1, result.stderr
    assert "within one second" in result.stderr
    assert 0.8 < elapsed < 2
finally:
    signal.pidfd_send_signal(fd, signal.SIGCONT)
    os.close(fd)
after = subprocess.run(
    ["/tmp/klippt-audio-enum-probe"],
    capture_output=True,
    text=True,
    timeout=3,
    check=False,
)
assert after.returncode == 0, after.stderr
proof = {
    "privateDaemonPid": pids[0],
    "generation": os.environ["AGENT_LAB_GENERATION"],
    "elapsedSec": elapsed,
    "result": result.stderr,
    "normalBefore": before.returncode,
    "normalAfter": after.returncode,
    "daemonResumed": True,
}
p = Path(os.environ["AGENT_LAB_STATE"]) / "paused-audio" / "enumeration-timeout.json"
p.write_text(json.dumps(proof, indent=2))
print(proof)
