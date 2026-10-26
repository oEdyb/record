import json
import os
import subprocess
import time
from pathlib import Path

assert os.getuid() == 0 and Path("/.dockerenv").is_file(), "Private container required"
assert not Path("/dev/snd").exists(), "Container must not expose physical audio devices"
runtime = Path("/run/user/0/agent-lab/klippt-oldwp")
runtime.mkdir(parents=True, exist_ok=True)
runtime.chmod(0o700)
os.environ.update(
    XDG_RUNTIME_DIR=str(runtime),
    AGENT_LAB_RUNTIME=str(runtime),
    PIPEWIRE_RUNTIME_DIR=str(runtime),
    PULSE_SERVER=f"unix:{runtime}/pulse/native",
)
root = Path("/output/old-audio-stack") / os.environ["EVIDENCE_LABEL"]
root.mkdir(parents=True, exist_ok=False)
children = []


def spawn(name, args):
    with (root / f"{name}.log").open("w") as log:
        p = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT)
    children.append(p)
    return p


def run(*args):
    return subprocess.check_output(args, text=True, timeout=8).strip()


def wait_file(path):
    end = time.monotonic() + 5
    while not path.exists():
        assert all(p.poll() is None for p in children)
        assert time.monotonic() < end, path
        time.sleep(0.05)


try:
    config = (
        Path("/usr/share/pipewire/pipewire.conf")
        .read_text()
        .replace("#audiotestsrc   =", "audiotestsrc   =")
    )
    config = config.replace(
        "context.objects = [",
        "context.objects = [\n"
        + "\n".join(
            "{ factory = adapter args = { factory.name = audiotestsrc node.name = lab_mic_source_"
            + suffix
            + " node.description = LabMicrophone"
            + suffix.upper()
            + " media.class = Audio/Source audio.rate = 48000 audio.channels = 2 audio.position = [ FL FR ] } }"
            for suffix in ["a", "b"]
        ),
    )
    config_path = root / "pipewire.conf"
    config_path.write_text(config)
    spawn("pipewire", ["pipewire", "-c", str(config_path)])
    wait_file(runtime / "pipewire-0")
    spawn("wireplumber", ["wireplumber"])
    spawn("pulse", ["pipewire-pulse"])
    wait_file(runtime / "pulse/native")
    time.sleep(0.5)
    run("pactl", "set-default-source", "lab_mic_source_b")
    time.sleep(0.3)
    with (
        (root / "selected-a.raw").open("wb") as pcm,
        (root / "selected-a.events.log").open("w") as log,
    ):
        probe = subprocess.Popen(
            [
                os.environ["OSC_AUDIO_PROBE"],
                os.environ.get("OSC_AUDIO_TARGET", "lab_mic_source_a"),
                "3",
            ],
            stdout=pcm,
            stderr=log,
        )
        children.append(probe)
        time.sleep(1)
        (root / "graph.json").write_text(run("pw-dump"))
        remove_target = os.environ.get("OSC_REMOVE_TARGET")
        if remove_target:
            assert remove_target == "lab_mic_source_a"
            target = next(
                node
                for node in json.loads((root / "graph.json").read_text())
                if node.get("info", {}).get("props", {}).get("node.name")
                == remove_target
            )
            run("pw-cli", "destroy", str(target["id"]))
        assert probe.wait(timeout=5) == 0
    print((root / "selected-a.events.log").read_text(), flush=True)
    (root / "versions.txt").write_text(
        run("dpkg-query", "-W", "pipewire", "pipewire-pulse", "wireplumber") + "\n"
    )
    graph = json.loads((root / "graph.json").read_text())
    probe_node = next(
        node
        for node in graph
        if node.get("info", {}).get("props", {}).get("node.name")
        == Path(os.environ["OSC_AUDIO_PROBE"]).name
    )
    source_names = {
        node["id"]: node.get("info", {}).get("props", {}).get("node.name")
        for node in graph
        if node["type"].endswith("Node")
    }
    peers = [
        source_names[node["info"]["props"]["link.output.node"]]
        for node in graph
        if node["type"].endswith("Link")
        and node.get("info", {}).get("props", {}).get("link.input.node")
        == probe_node["id"]
    ]
    assert peers and set(peers) == {os.environ["OSC_EXPECTED_SOURCE"]}, peers
    pcm_bytes = (root / "selected-a.raw").stat().st_size
    expected_pcm = os.environ["OSC_EXPECTED_PCM"]
    if expected_pcm == "present":
        assert pcm_bytes > 0
    elif expected_pcm == "absent":
        assert pcm_bytes == 0
        assert "error" in (root / "selected-a.events.log").read_text()
    else:
        raise ValueError("OSC_EXPECTED_PCM must be present or absent")
    proof = {
        "graphInputSources": peers,
        "pcmBytes": pcm_bytes,
        "probeProperties": probe_node["info"]["props"],
        "versions": (root / "versions.txt").read_text(),
        "removedTargetAfterOneSecond": remove_target,
    }
    (root / "proof.json").write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps(proof), flush=True)
finally:
    for p in reversed(children):
        if p.poll() is None:
            p.terminate()
    for p in reversed(children):
        if p.poll() is None:
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait(timeout=3)
