import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function recordingSourceLoss({ app, snapshot, run, verifyClip }) {
	assert(process.env.AGENT_LAB_RUNTIME, "Private desktop required");
	await delay(3000);
	const graph = JSON.parse(execFileSync("pw-dump", [], { encoding: "utf8" }));
	const clients = graph.filter(
		(item) =>
			item.type === "PipeWire:Interface:Client" &&
			item.info?.props?.["application.name"]?.includes("openscreen"),
	);
	const nodes = graph.filter((item) => item.type === "PipeWire:Interface:Node");
	await writeFile(path.join(run, "source-loss-graph.json"), JSON.stringify(graph, null, 2));
	const captures = nodes.filter(
		(node) =>
			node.info?.props?.["media.class"] === "Stream/Input/Video" ||
			(String(node.info?.props?.["node.name"] ?? "").includes("openscreen") &&
				!String(node.info?.props?.["media.class"] ?? "").includes("Audio")),
	);
	const link = graph.find(
		(item) =>
			item.type === "PipeWire:Interface:Link" &&
			captures.some(
				(node) =>
					node.id === Number(item.info?.["input-node-id"] ?? item.info?.props?.["link.input.node"]),
			),
	);
	assert(
		link,
		`No private screen capture link; clients ${clients.length}, app ${app.process().pid}`,
	);
	const sourceId = Number(link.info?.["output-node-id"] ?? link.info?.props?.["link.output.node"]);
	assert(Number.isInteger(sourceId));
	execFileSync("pw-cli", ["destroy", String(sourceId)]);

	for (let i = 0; i < 200 && (await snapshot())?.phase !== "review"; i++) await delay(200);
	const saved = await snapshot();
	assert.equal(saved?.phase, "review", "Source loss did not save the take");
	assert.equal(saved.clips.length, 1);
	verifyClip(saved.clips[0]);
	const windows = JSON.parse(
		execFileSync("python3", [path.join(process.env.HOME, ".local/share/agent-lab/windows.py")], {
			encoding: "utf8",
		}),
	);
	assert(
		windows.some((w) => w.caption === "Recording interrupted"),
		"Missing native source-loss alert",
	);
	const warnings = await readFile(
		path.join(run, "profile/diagnostics/helper-warnings.jsonl"),
		"utf8",
	);
	assert(
		warnings
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse)
			.some((w) => w.code === "source-inactive"),
	);
	const boundaries = await readFile(
		path.join(run, "profile/diagnostics/record-pause-continue-timing.jsonl"),
		"utf8",
	).catch((error) => {
		if (error.code === "ENOENT") return "";
		throw error;
	});
	assert(
		!boundaries
			.split("\n")
			.filter(Boolean)
			.map(JSON.parse)
			.some((r) => ["pause", "continue"].includes(r.action)),
	);
	await writeFile(
		path.join(run, "source-loss-proof.json"),
		JSON.stringify({ saved, windows, pauseEvents: 0 }, null, 2),
	);
	console.log("ACK_PRIVATE_ALERT");
	await delay(500);
	console.log(
		"PASS real PipeWire screen producer destroyed, native alert visible, footage saved and decoded, zero pauses",
		run,
	);
}
