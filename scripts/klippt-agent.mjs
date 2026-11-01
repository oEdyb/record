#!/usr/bin/env node
// klippt-agent: drive the running Klippt from a terminal or an agent.
// Talks to the socket electron/agent/agentServer.ts opens; prints the JSON reply.
//
//   klippt-agent help                     this text
//   klippt-agent <method> [key=value ...] any method, e.g. cuts unsure=true
//
// Values parse as JSON when they can (numbers, true/false, ["a","b"]), else as text.

import net from "node:net";
import path from "node:path";
import process from "node:process";

const HELP = `klippt-agent: control the running Klippt

App and windows (any window; never moves your mouse or types on your keyboard):
  ping                               Is Klippt running? Version and pid
  windows                            Open windows: index, kind, title, focus
  studio                             Open the Studio, as the pill's Studio button does
  studio-state                       Studio phase, setup, clips and what is allowed now
  studio-do COMMAND                  Press a Studio button: record, pause, resume, stop,
                                     remove-last, undo-remove, toggle-mic, toggle-camera,
                                     toggle-system-audio, record-more, finish, pill,
                                     or JSON like {"kind":"set-quality","value":"standard"}
  screenshot [window=review|INDEX]   PNG of a window's own pixels; prints its path
  controls [window=...]              Visible buttons and fields with their labels, plus page text
  click LABEL [nth=N]                Click a control by its label (exact first, then contains)
  type LABEL TEXT                    Type into a text field
  key KEY [mods=Control,Shift]       Press a key inside the window, e.g. key Space, key z mods=Control

Review window, clean cut:
  state                              Project, playhead, clean cut status and counts
  enable | disable                   Turn Clean cut on or off (on starts the analysis)
  strength gentle|clean              Cut strength
  cuts [unsure=true] [kind=filler,stutter,restart,retake,pause] [order=review]
                                     Every cut: id, words, reason, context, times, restored
  cut ID                             One cut
  restore ID [ID...]                 Bring the cut words back
  recut ID [ID...]                   Cut them again
  audio ID [padSec=2]                Before/after WAVs around a cut, with a transcript of each
  transcript [from=0] [count=400]    Words with index, times and the cut that removes each
  cut-sentence WORD_INDEX            Cut the kept sentence around a word
  undo | redo                        Clean cut history
  select ID                          Show a cut in the app (moves the playhead before it)
  listen ID [mode=with|without]      PLAYS AUDIO on the speakers: only when Olle asks

Review window, playback:
  play | pause                       Playback (play is audible)
  seek SEC [clock=playback|raw]      Move the playhead
  save                               Open Save, as the Save button does

Socket: $KLIPPT_AGENT_SOCKET, else $XDG_RUNTIME_DIR/klippt/agent.sock.`;

const ALIASES = {
	enable: () => ["cleanCut.enable", { on: true }],
	disable: () => ["cleanCut.enable", { on: false }],
	strength: ([value]) => ["cleanCut.strength", { value }],
	cut: ([id]) => ["cut", { id }],
	restore: (ids) => ["cut.restore", { ids, restored: true }],
	recut: (ids) => ["cut.restore", { ids, restored: false }],
	audio: ([id]) => ["cut.audio", { id }],
	select: ([id]) => ["cut.select", { id }],
	listen: ([id]) => ["cut.listen", { id }],
	"cut-sentence": ([wordIndex]) => ["cut.sentence", { wordIndex: Number(wordIndex) }],
	seek: ([sec]) => ["seek", { sec: Number(sec) }],
	studio: () => ["studio.open", {}],
	"studio-state": () => ["studio.state", {}],
	"studio-do": ([command]) => ["studio.command", { command: parse(command) }],
	controls: () => ["ui.controls", {}],
	click: ([label]) => ["ui.click", { label }],
	type: ([label, ...text]) => ["ui.type", { label, text: text.join(" ") }],
	key: ([key]) => ["ui.key", { key }],
	screenshot: ([window]) => ["screenshot", window === undefined ? {} : { window: parse(window) }],
};

function parse(value) {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

const argv = process.argv.slice(2);
if (argv.length === 0 || ["help", "--help", "-h"].includes(argv[0])) {
	console.log(HELP);
	process.exit(0);
}
const [command, ...rest] = argv;
const positional = rest.filter((arg) => !/^[\w.]+=/.test(arg));
const named = Object.fromEntries(
	rest
		.filter((arg) => /^[\w.]+=/.test(arg))
		.map((arg) => {
			const at = arg.indexOf("=");
			const key = arg.slice(0, at);
			const value = arg.slice(at + 1);
			return [key, key === "mods" ? value.split(",") : parse(value)];
		}),
);
if (named.mods) {
	named.modifiers = named.mods;
	delete named.mods;
}
const [method, base] = ALIASES[command] ? ALIASES[command](positional) : [command, {}];
const params = { ...base, ...named };

const socketPath =
	process.env.KLIPPT_AGENT_SOCKET ||
	(process.env.XDG_RUNTIME_DIR
		? path.join(process.env.XDG_RUNTIME_DIR, "klippt", "agent.sock")
		: null);
if (!socketPath) {
	console.error("klippt-agent: set KLIPPT_AGENT_SOCKET to Klippt's agent socket.");
	process.exit(2);
}

const socket = net.createConnection(socketPath);
let buffer = "";
socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify({ id: 1, method, params })}\n`));
socket.on("data", (chunk) => {
	buffer += chunk;
	const newline = buffer.indexOf("\n");
	if (newline === -1) return;
	const reply = JSON.parse(buffer.slice(0, newline));
	socket.end();
	if (reply.error) {
		console.error(`klippt-agent: ${reply.error}`);
		process.exit(1);
	}
	console.log(JSON.stringify(reply.result, null, 2));
	process.exit(0);
});
socket.on("error", (error) => {
	const hint =
		error.code === "ENOENT" || error.code === "ECONNREFUSED"
			? "Klippt is not running, or it is a build without the agent socket."
			: error.message;
	console.error(`klippt-agent: ${hint}`);
	process.exit(1);
});
