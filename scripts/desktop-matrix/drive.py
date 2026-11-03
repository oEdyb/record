#!/usr/bin/env python3
"""Run Klippt's record, review, export and relaunch journey inside one private desktop session.

Run this only inside a throwaway session (a container or agent-lab). It drives Klippt through its
own agent socket, so it needs no pointer, and it writes numeric evidence to <out>/result.json.
Desktop-specific behaviour lives in small commands passed by the session script.
"""
import argparse
import json
import os
import re
import shlex
import signal
import socket
import subprocess
import time
from pathlib import Path


def sh(command, **kwargs):
    return subprocess.run(command, shell=True, text=True, capture_output=True, **kwargs)


class Agent:
    def __init__(self, path):
        self.path = path

    def call(self, method, **params):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(30)
            client.connect(self.path)
            client.sendall((json.dumps({"id": 1, "method": method, "params": params}) + "\n").encode())
            data = b""
            while b"\n" not in data:
                chunk = client.recv(1 << 20)
                if not chunk:
                    break
                data += chunk
        reply = json.loads(data.split(b"\n")[0])
        if reply.get("error"):
            raise RuntimeError(f"{method}: {reply['error']}")
        return reply["result"]

    def window(self, kind):
        for window in self.call("windows"):
            if window["kind"] == kind:
                return window
        return None

    def controls(self, kind):
        window = self.window(kind)
        return self.call("ui.controls", window=window["index"]) if window else None

    def click(self, kind, label):
        return self.call("ui.click", window=self.window(kind)["index"], label=label)


def wait_for(check, seconds, step=0.25):
    deadline = time.monotonic() + seconds
    last = None
    while time.monotonic() < deadline:
        try:
            last = check()
            if last:
                return last
        except (OSError, RuntimeError, ValueError, TypeError):
            pass
        time.sleep(step)
    return last


def probe(path):
    result = sh(
        "ffprobe -v error -count_frames -show_entries "
        "stream=codec_type,codec_name,width,height,nb_read_frames:format=duration "
        f"-of json {shlex.quote(str(path))}"
    )
    data = json.loads(result.stdout or "{}")
    decode = sh(f"ffmpeg -v error -xerror -i {shlex.quote(str(path))} -f null -")
    return {
        "bytes": Path(path).stat().st_size,
        "duration": float(data.get("format", {}).get("duration", 0) or 0),
        "streams": data.get("streams", []),
        "decodes": decode.returncode == 0,
        "decodeError": decode.stderr[:300],
    }


def frames_evidence(path, out, label):
    """Contact sheet of the first and last frames, plus a centre-of-screen stability scan."""
    count = int(sh(
        "ffprobe -v error -count_frames -select_streams v -show_entries stream=nb_read_frames "
        f"-of csv=p=0 {shlex.quote(str(path))}"
    ).stdout.strip() or 0)
    sheet = out / f"{label}-frames.png"
    sh(
        f"ffmpeg -v error -y -i {shlex.quote(str(path))} -vf "
        f"\"select='lt(n,4)+gt(n,{max(count - 5, 0)})+eq(n,{count // 2})',scale=640:-1,tile=3x3\" "
        f"-frames:v 1 -fps_mode vfr {shlex.quote(str(sheet))}"
    )
    return {"frames": count, "sheet": sheet.name}


class Journey:
    def __init__(self, args):
        self.args = args
        self.out = Path(args.out)
        self.out.mkdir(parents=True, exist_ok=True)
        self.socket = args.socket
        self.agent = Agent(self.socket)
        self.recordings = Path(args.profile) / "recordings"
        self.result = {"desktop": args.name, "takes": [], "steps": [], "export": None}
        self.portal_log = self.out / "portal-monitor.log"
        self.app = None

    def step(self, name, **data):
        entry = {"step": name, "t": round(time.time(), 1), **data}
        self.result["steps"].append(entry)
        print(json.dumps(entry), flush=True)
        self.save()

    def save(self):
        (self.out / "result.json").write_text(json.dumps(self.result, indent=2) + "\n")

    def portal_counts(self):
        text = self.portal_log.read_text(errors="replace") if self.portal_log.exists() else ""
        calls = re.findall(
            r"interface=org\.freedesktop\.impl\.portal\.ScreenCast; member=(SelectSources|Start)\b(.*?)(?=\nmethod call|\nsignal|\Z)",
            text,
            re.S,
        )
        return {
            "start": sum(1 for name, _ in calls if name == "Start"),
            "selectWithRestore": sum(
                1 for name, body in calls if name == "SelectSources" and "restore_data" in body
            ),
        }

    def picker_count(self):
        path = self.out / "picker.log"
        return len(path.read_text().splitlines()) if path.exists() else None

    def launch(self, label):
        env = dict(os.environ, KLIPPT_AGENT_SOCKET=self.socket)
        log = open(self.out / f"app-{label}.log", "w")
        self.app = subprocess.Popen(shlex.split(self.args.app), env=env, stdout=log, stderr=log)
        started = time.monotonic()
        ok = wait_for(lambda: self.agent.call("ping"), 45)
        hud = wait_for(lambda: self.agent.window("hud-overlay"), 30)
        visible = wait_for(lambda: (self.agent.window("hud-overlay") or {}).get("visible"), 20)
        self.step(
            "launch", label=label, ping=bool(ok), hud=bool(hud), hudVisible=bool(visible),
            seconds=round(time.monotonic() - started, 2),
        )
        return bool(visible)

    def quit(self):
        if self.app and self.app.poll() is None:
            self.app.send_signal(signal.SIGTERM)
            try:
                self.app.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.app.kill()
                self.step("quit-timeout")
        time.sleep(1)

    def take(self, label, reveal=False):
        before = self.portal_counts()
        picker_before = self.picker_count()
        known = set(self.recordings.glob("*-clip-0001.mp4")) if self.recordings.exists() else set()
        started = time.monotonic()
        self.agent.click("hud-overlay", "Record")
        if self.args.approve_picker:
            # Runs in the background so a picker that never appears costs nothing.
            subprocess.Popen(
                [self.args.approve_picker, str(self.out), label], stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

        def recording():
            text = (self.agent.controls("hud-overlay") or {}).get("text", "")
            return re.search(r"\b\d\d:\d\d\b", text) and set(self.recordings.glob("*-clip-0001.mp4")) - known

        new = wait_for(recording, self.args.picker_timeout)
        start_seconds = round(time.monotonic() - started, 2)
        after = self.portal_counts()
        take = {
            "label": label,
            "captureStarted": bool(new),
            "startSeconds": start_seconds,
            "portalStartCalls": after["start"] - before["start"],
            "restoreTokenSent": after["selectWithRestore"] > before["selectWithRestore"],
        }
        if picker_before is not None:
            take["pickerShown"] = self.picker_count() - picker_before
        if not new:
            take["hud"] = self.agent.controls("hud-overlay")
            take["error"] = "capture did not start"
            self.result["takes"].append(take)
            self.step("take-failed", **take)
            return False
        hud = self.agent.window("hud-overlay")
        take["hudVisibleDuringCapture"] = hud["visible"]
        time.sleep(self.args.seconds)
        if self.args.screenshot:
            sh(self.args.screenshot.replace("{}", str(self.out / f"{label}-desktop.png")))
        if reveal and not take["hudVisibleDuringCapture"]:
            # The way a person reaches Stop with no tray: launch Klippt again from the launcher.
            revealed_at = time.monotonic()
            env = dict(os.environ, KLIPPT_AGENT_SOCKET=self.socket)
            subprocess.run(shlex.split(self.args.app), env=env, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=30, check=False)
            shown = wait_for(lambda: self.agent.window("hud-overlay")["visible"], 15)
            take["secondLaunchRevealedHud"] = bool(shown)
            take["revealSeconds"] = round(time.monotonic() - revealed_at, 2)
        self.agent.click("hud-overlay", "Stop recording")
        review = wait_for(
            lambda: (self.agent.window("editor") or {}).get("visible")
            and not any(
                control.get("disabled") and control["label"].startswith("Save video")
                for control in self.agent.controls("editor")["controls"]
            ),
            60,
        )
        take["reviewOpened"] = bool(review)
        clip = sorted(new)[0]
        take["clip"] = probe(clip)
        take.update(frames_evidence(clip, self.out, label))
        if review:
            state = self.agent.call("state")
            duration = state["playback"]["durationSec"]
            self.agent.call("seek", sec=duration / 2)
            time.sleep(0.5)
            state = self.agent.call("state")
            take["reviewSeek"] = {"sec": state["playback"]["rawSec"], "duration": duration}
            shot = self.agent.call("screenshot", window=self.agent.window("editor")["index"])
            take["reviewShot"] = shot if isinstance(shot, str) else shot.get("path")
            if take["reviewShot"]:
                sh(f"cp {shlex.quote(take['reviewShot'])} {shlex.quote(str(self.out / (label + '-review.png')))}")
        self.result["takes"].append(take)
        self.step("take", **{k: v for k, v in take.items() if k != "clip"}, clipSeconds=take["clip"]["duration"], decodes=take["clip"]["decodes"])
        return bool(review)

    def export(self, label):
        target = self.out / f"{label}.mp4"
        self.agent.click("editor", "Save video (Ctrl+S)")
        wait_for(lambda: any(c["label"] == "One video" for c in self.agent.controls("editor")["controls"]), 10)
        self.agent.click("editor", "One video")
        time.sleep(0.5)
        self.agent.click("editor", "Save video…")
        time.sleep(self.args.dialog_wait)
        if self.args.screenshot:
            sh(self.args.screenshot.replace("{}", str(self.out / f"{label}-dialog.png")))
        typed = sh(f"{self.args.type_path} {shlex.quote(str(target))}")
        saved = wait_for(lambda: "Video saved" in self.agent.controls("editor")["text"], 180, step=1)
        result = {"saved": bool(saved), "typedRc": typed.returncode, "typedErr": typed.stderr[:300]}
        if target.exists():
            result["file"] = probe(target)
        else:
            result["text"] = self.agent.controls("editor")["text"][-300:]
        self.result["export"] = result
        self.step("export", saved=result["saved"], decodes=result.get("file", {}).get("decodes"))
        if saved:
            self.agent.click("editor", "Close")
        return bool(saved)

    def new_recording(self):
        self.agent.click("editor", "New recording")
        return wait_for(lambda: (self.agent.window("hud-overlay") or {}).get("visible"), 20)

    def run(self):
        monitor = subprocess.Popen(
            ["dbus-monitor", "--session", "interface='org.freedesktop.impl.portal.ScreenCast'"],
            stdout=open(self.portal_log, "w"), stderr=subprocess.DEVNULL,
        )
        try:
            if not self.launch("first"):
                return
            if not self.take("take1-first"):
                return
            self.export("export")
            if self.new_recording():
                self.take("take2-same-session", reveal=True)
            self.quit()
            if self.launch("relaunch"):
                self.take("take3-after-relaunch")
        finally:
            self.quit()
            monitor.terminate()
            self.save()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--profile", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--type-path", required=True, help="Command that answers the save dialog; the path is appended")
    parser.add_argument("--approve-picker", help="Command run after Record for desktops with a GUI picker")
    parser.add_argument("--screenshot", help="Desktop screenshot command; {} is the output path")
    parser.add_argument("--seconds", type=float, default=5)
    parser.add_argument("--picker-timeout", type=float, default=30)
    parser.add_argument("--dialog-wait", type=float, default=3)
    Journey(parser.parse_args()).run()


if __name__ == "__main__":
    main()
