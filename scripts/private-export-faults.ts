import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { AtomicExportPublisher } from "../electron/export/atomicExport";

const root = process.argv[2];
assert(root?.startsWith("/home/olle/.cache/klippt-work/"));
const stats = await fs.statfs(path.join(root, "full"));
assert.equal(stats.type, 0x01021994, "Use the private capped tmpfs namespace");
const results: Array<{ name: string; code?: string; phase?: string; message: string }> = [];
const publisher = (name: string) =>
	new AtomicExportPublisher({
		journalPath: path.join(root, `${name}.journal.json`),
		safetyBytes: 64n * 1024n * 1024n,
		capacityCheckIntervalMs: 600000,
	});
async function ffmpeg(file: string, signal: AbortSignal, realtime = false) {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"ffmpeg",
			[
				"-nostdin",
				"-v",
				"error",
				...(realtime ? ["-re"] : []),
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=640x360:rate=60",
				"-t",
				"60",
				"-c:v",
				"rawvideo",
				"-pix_fmt",
				"bgr24",
				"-threads",
				"2",
				"-f",
				"avi",
				file,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let error = "";
		child.stderr.on("data", (data) => (error += data));
		const abort = () => child.kill("SIGTERM");
		signal.addEventListener("abort", abort, { once: true });
		child.once("error", reject);
		child.once("exit", (code) => {
			signal.removeEventListener("abort", abort);
			code === 0 ? resolve() : reject(new Error(error || `FFmpeg exited ${code}`));
		});
	});
}
async function failure(
	name: string,
	finalPath: string,
	render: (p: string, s: AbortSignal) => Promise<void>,
	signal?: AbortSignal,
) {
	let error: unknown;
	try {
		await publisher(name).publish({
			finalPath,
			expectedBytes: 1,
			render,
			verify: async () => {
				throw new Error("Failed render must not be verified");
			},
			signal,
		});
	} catch (e) {
		error = e;
	}
	assert(error, `${name} unexpectedly succeeded`);
	const detail = error as Error & { code?: string; phase?: string };
	const files = await fs.readdir(path.dirname(finalPath));
	assert(!files.some((n) => n.includes(".klippt-export-")), `${name} left staging media`);
	results.push({ name, code: detail.code, phase: detail.phase, message: detail.message });
	console.log(name, detail.code, detail.phase, detail.message);
}
await failure("read-only", path.join(root, "readonly", "video.mp4"), async (p) => {
	await fs.writeFile(p, "must fail");
});
await fs.writeFile(path.join(root, "full", "old.mp4"), "old export");
await fs.writeFile(path.join(root, "full", "fill"), Buffer.alloc(80 * 1024 * 1024 - 4096));
await failure("full-preflight", path.join(root, "full", "video.mp4"), async () => {
	throw new Error("Render must not start");
});
await fs.unlink(path.join(root, "full", "fill"));
await failure("full-during-render", path.join(root, "full", "old.mp4"), (file, signal) =>
	ffmpeg(file, signal),
);
assert.equal(await fs.readFile(path.join(root, "full", "old.mp4"), "utf8"), "old export");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 600);
await failure(
	"cancel",
	path.join(root, "cancelled.mp4"),
	(file, signal) => ffmpeg(file, signal, true),
	controller.signal,
);
clearTimeout(timer);
assert.equal(results.find((r) => r.name === "full-during-render")?.code, "INSUFFICIENT_SPACE");
assert.equal(
	results.find((r) => r.name === "read-only")?.message,
	"This destination is read-only. Choose a writable folder.",
);
assert.equal(results.find((r) => r.name === "cancel")?.code, "CANCELLED");
await fs.writeFile(path.join(root, "results.json"), JSON.stringify(results, null, 2));
