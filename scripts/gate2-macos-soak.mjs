#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ELECTRON = path.join(
	ROOT,
	"node_modules",
	"electron",
	"dist",
	"Electron.app",
	"Contents",
	"MacOS",
	"Electron",
);
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const DEFAULT_DURATION_SEC = 30 * 60;
const SOURCE_DURATION_TOLERANCE_SEC = 2;
const EXPORT_DURATION_TOLERANCE_SEC = 0.25;
const MAX_EXPORT_AV_DRIFT_SEC = 0.15;
const RUN_ROOT_PREFIX = "record-gate2-soak-";
const RUN_ROOT_MARKER = ".record-gate2-soak-root.json";

async function createOwnedRunRoot() {
	const runRoot = await fsp.mkdtemp(path.join(os.tmpdir(), RUN_ROOT_PREFIX));
	const realRoot = await fsp.realpath(runRoot);
	await fsp.writeFile(
		path.join(realRoot, RUN_ROOT_MARKER),
		`${JSON.stringify({ kind: "record-gate2-soak", version: 1, runRoot: realRoot })}\n`,
		"utf8",
	);
	return realRoot;
}

async function validateOwnedRunRoot(candidate) {
	const resolved = path.resolve(candidate);
	const [realRoot, realTemp] = await Promise.all([
		fsp.realpath(resolved),
		fsp.realpath(os.tmpdir()),
	]);
	if (path.dirname(realRoot) !== realTemp || !path.basename(realRoot).startsWith(RUN_ROOT_PREFIX)) {
		throw new Error(`Refusing non-harness run root: ${candidate}`);
	}
	const marker = JSON.parse(await fsp.readFile(path.join(realRoot, RUN_ROOT_MARKER), "utf8"));
	if (
		marker?.kind !== "record-gate2-soak" ||
		marker?.version !== 1 ||
		marker?.runRoot !== realRoot
	) {
		throw new Error(`Invalid Gate 2 harness marker: ${candidate}`);
	}
	return realRoot;
}

function sourcePathFromProject(project) {
	if (typeof project.media?.screenVideoPath === "string") {
		return project.media.screenVideoPath;
	}
	if (!Array.isArray(project.assets)) return null;
	const primaryId = project.project?.primaryAssetId;
	const asset = project.assets.find((candidate) => candidate.id === primaryId) ?? project.assets[0];
	return typeof asset?.originalPath === "string" ? asset.originalPath : null;
}

function parseArgs(argv) {
	const options = {
		durationSec: DEFAULT_DURATION_SEC,
		quality: "good",
		keep: false,
		interruptExport: false,
		reportPath: null,
		resumeRoot: null,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--keep") {
			options.keep = true;
			continue;
		}
		if (arg === "--interrupt-export") {
			options.interruptExport = true;
			continue;
		}
		const value = argv[index + 1];
		if (!value) throw new Error(`${arg} requires a value`);
		if (arg === "--duration") {
			options.durationSec = Number(value);
			index += 1;
		} else if (arg === "--quality") {
			options.quality = value;
			index += 1;
		} else if (arg === "--report") {
			options.reportPath = path.resolve(value);
			index += 1;
		} else if (arg === "--resume") {
			options.resumeRoot = path.resolve(value);
			index += 1;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}
	if (!Number.isFinite(options.durationSec) || options.durationSec < 5) {
		throw new Error("--duration must be at least 5 seconds");
	}
	if (!["medium", "good", "source"].includes(options.quality)) {
		throw new Error("--quality must be medium, good, or source");
	}
	return options;
}

function requireExecutable(filePath, label) {
	if (!fs.existsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
}

function fixtureUrl(title) {
	const html = `<!doctype html>
<meta charset="utf-8">
<title>${title}</title>
<style>
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: #080b12; }
  body { display: grid; place-items: center; color: #f7f8fb; font: 600 28px system-ui; }
  .grid { position: fixed; inset: -20%; opacity: .28; background:
    linear-gradient(90deg, transparent 49%, #55d6a6 50%, transparent 51%),
    linear-gradient(transparent 49%, #55d6a6 50%, transparent 51%);
    background-size: 64px 64px; animation: drift 9s linear infinite; }
  .orb { width: 160px; height: 160px; border-radius: 50%; position: fixed;
    background: radial-gradient(circle at 35% 30%, #fff, #67e8b6 20%, #2563eb 70%);
    box-shadow: 0 24px 90px #2563eb88; animation: orbit 7s ease-in-out infinite alternate; }
  .card { z-index: 2; width: min(720px, 80vw); padding: 48px; border: 1px solid #ffffff22;
    border-radius: 28px; background: #111827dd; box-shadow: 0 30px 100px #0008; }
  .bar { height: 10px; margin-top: 32px; border-radius: 99px; background: #ffffff16; overflow: hidden; }
  .fill { width: 35%; height: 100%; background: #55d6a6; animation: sweep 3s ease-in-out infinite alternate; }
  #clock { color: #8ee8c6; font-variant-numeric: tabular-nums; }
  @keyframes drift { to { transform: translate(64px, 64px); } }
  @keyframes orbit { from { transform: translate(-34vw, -24vh) scale(.75); } to { transform: translate(34vw, 24vh) scale(1.15); } }
  @keyframes sweep { to { transform: translateX(185%); } }
</style>
<div class="grid"></div><div class="orb"></div>
<main class="card"><div>record Gate 2 capture soak</div><div id="clock">00:00:00.000</div><div class="bar"><div class="fill"></div></div></main>
<script>
  const started = performance.now();
  const clock = document.querySelector('#clock');
  function frame(now) {
    const elapsed = now - started;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor(elapsed / 60000) % 60;
    const seconds = Math.floor(elapsed / 1000) % 60;
    const millis = Math.floor(elapsed) % 1000;
    clock.textContent = [hours, minutes, seconds].map(v => String(v).padStart(2, '0')).join(':') + '.' + String(millis).padStart(3, '0');
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
</script>`;
	return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function runCommand(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn(command, args, {
			cwd: options.cwd ?? ROOT,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let pendingStdout = "";
		const appendStdout = (text, flush = false) => {
			pendingStdout += text;
			const lines = pendingStdout.split(/\r?\n/);
			pendingStdout = flush ? "" : (lines.pop() ?? "");
			if (flush && pendingStdout) lines.push(pendingStdout);
			for (const line of lines) {
				let isProgress = false;
				if (options.ignoreProgressEvents) {
					try {
						isProgress = JSON.parse(line).event === "progress";
					} catch {
						// Keep non-protocol diagnostics for failure reports.
					}
				}
				if (!isProgress) stdout += `${line}\n`;
			}
		};
		child.stdout.on("data", (chunk) => {
			const text = chunk.toString();
			appendStdout(text);
			if (options.streamOutput) process.stdout.write(text);
		});
		child.stderr.on("data", (chunk) => {
			const text = chunk.toString();
			stderr += text;
			if (options.streamOutput) process.stderr.write(text);
		});
		child.once("error", reject);
		const timeout = options.timeoutMs
			? setTimeout(() => {
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
				}, options.timeoutMs)
			: null;
		child.once("close", (code, signal) => {
			if (timeout) clearTimeout(timeout);
			appendStdout("", true);
			resolve({ code, signal, stdout, stderr, wallMs: Date.now() - startedAt });
		});
	});
}

function interruptCommandAtProgress(command, args, options = {}) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const child = spawn(command, args, {
			cwd: options.cwd ?? ROOT,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
		});
		let stdout = "";
		let stderr = "";
		let pending = "";
		let interruptedAtPercent = null;
		let settled = false;
		const killGroup = () => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch (error) {
				if (error?.code !== "ESRCH") reject(error);
			}
		};
		const inspectLines = (text) => {
			pending += text;
			const lines = pending.split(/\r?\n/);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				stdout += `${line}\n`;
				if (interruptedAtPercent !== null) continue;
				try {
					const event = JSON.parse(line);
					if (
						event.event === "progress" &&
						Number(event.percentage) >= (options.minimumProgressPercent ?? 5)
					) {
						interruptedAtPercent = Number(event.percentage);
						killGroup();
					}
				} catch {
					// Keep diagnostics. Only NDJSON progress events trigger interruption.
				}
			}
		};
		child.stdout.on("data", (chunk) => inspectLines(chunk.toString()));
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
		const timeout = setTimeout(() => {
			if (settled) return;
			killGroup();
		}, options.timeoutMs ?? 120_000);
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (pending) stdout += pending;
			resolve({
				code,
				signal,
				stdout,
				stderr,
				wallMs: Date.now() - startedAt,
				interruptedAtPercent,
			});
		});
	});
}

function parseDoneEvent(stdout) {
	for (const line of stdout.trim().split(/\r?\n/).reverse()) {
		try {
			const event = JSON.parse(line);
			if (event.event === "done") return event;
		} catch {
			// Electron diagnostics are not part of the NDJSON protocol.
		}
	}
	throw new Error("CLI did not emit a done event");
}

async function probeMedia(filePath, countFrames = false, durationHintSec = 0) {
	const args = [
		"-v",
		"error",
		...(countFrames ? ["-count_frames"] : []),
		"-show_entries",
		"format=duration,size,start_time,format_name:stream=index,codec_name,codec_type,width,height,pix_fmt,field_order,r_frame_rate,avg_frame_rate,duration,nb_read_frames,sample_rate,channels:stream_tags=language,title",
		"-of",
		"json",
		filePath,
	];
	const result = await runCommand(FFPROBE, args, {
		timeoutMs: Math.max(120_000, durationHintSec * 250),
	});
	if (result.code !== 0) throw new Error(`ffprobe failed for ${filePath}: ${result.stderr}`);
	return JSON.parse(result.stdout);
}

async function decodeCheckpoints(filePath, durationSec) {
	const checkpoints = [0.2, durationSec / 2, Math.max(0.2, durationSec - 0.2)];
	for (const seconds of checkpoints) {
		const result = await runCommand(
			FFMPEG,
			[
				"-v",
				"error",
				"-ss",
				seconds.toFixed(3),
				"-i",
				filePath,
				"-map",
				"0:v:0",
				"-frames:v",
				"1",
				"-f",
				"null",
				"-",
			],
			{ timeoutMs: 120_000 },
		);
		if (result.code !== 0) {
			throw new Error(`Could not decode video at ${seconds.toFixed(3)}s: ${result.stderr}`);
		}
	}
	return checkpoints;
}

function numeric(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function validateSource(probe, requestedDurationSec) {
	const durationSec = numeric(probe.format?.duration);
	if (Math.abs(durationSec - requestedDurationSec) > SOURCE_DURATION_TOLERANCE_SEC) {
		throw new Error(
			`Source duration ${durationSec}s differs from ${requestedDurationSec}s request`,
		);
	}
	const video = probe.streams.find((stream) => stream.codec_type === "video");
	if (!video || video.codec_name !== "h264" || video.width < 2 || video.height < 2) {
		throw new Error("Source does not contain a usable H.264 video stream");
	}
	const frameRate = numeric(video.nb_read_frames) / durationSec;
	if (frameRate < 24) {
		throw new Error(`Animated source averaged only ${frameRate.toFixed(2)} decoded frames/s`);
	}
	const audio = probe.streams.filter((stream) => stream.codec_type === "audio");
	if (
		audio.length < 2 ||
		audio.some(
			(stream) =>
				stream.codec_name !== "aac" || stream.sample_rate !== "48000" || stream.channels !== 2,
		)
	) {
		throw new Error("Source does not contain separate 48 kHz stereo AAC mix and system tracks");
	}
	return { durationSec, frameRate, video, audio };
}

function findAtomPrefix(filePath, atom) {
	const handle = fs.openSync(filePath, "r");
	try {
		const buffer = Buffer.alloc(4 * 1024 * 1024);
		const bytes = fs.readSync(handle, buffer, 0, buffer.length, 0);
		return buffer.subarray(0, bytes).indexOf(Buffer.from(atom, "ascii"));
	} finally {
		fs.closeSync(handle);
	}
}

function validateExport(probe, sourceDurationSec, outputPath) {
	const durationSec = numeric(probe.format?.duration);
	if (Math.abs(durationSec - sourceDurationSec) > EXPORT_DURATION_TOLERANCE_SEC) {
		throw new Error(`Export duration ${durationSec}s differs from source ${sourceDurationSec}s`);
	}
	const video = probe.streams.find((stream) => stream.codec_type === "video");
	const audio = probe.streams.find((stream) => stream.codec_type === "audio");
	if (!video || video.codec_name !== "h264" || video.width < 2 || video.height < 2) {
		throw new Error("Export does not contain a usable H.264 video stream");
	}
	if (video.field_order && !["progressive", "unknown"].includes(video.field_order)) {
		throw new Error(`Export video is not progressive: ${video.field_order}`);
	}
	if (
		!audio ||
		audio.codec_name !== "aac" ||
		audio.sample_rate !== "48000" ||
		audio.channels !== 2
	) {
		throw new Error("Export does not contain one 48 kHz stereo AAC track");
	}
	const avDriftSec = Math.abs(numeric(video.duration) - numeric(audio.duration));
	if (avDriftSec > MAX_EXPORT_AV_DRIFT_SEC) {
		throw new Error(`Export A/V duration drift is ${avDriftSec.toFixed(3)}s`);
	}
	const moovOffset = findAtomPrefix(outputPath, "moov");
	const mdatOffset = findAtomPrefix(outputPath, "mdat");
	if (moovOffset < 0 || mdatOffset < 0 || moovOffset > mdatOffset) {
		throw new Error(`Export is not Fast Start (moov=${moovOffset}, mdat=${mdatOffset})`);
	}
	return { durationSec, avDriftSec, moovOffset, mdatOffset, video, audio };
}

async function stopFixture(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise((resolve) => child.once("close", resolve)),
		new Promise((resolve) => setTimeout(resolve, 5_000)),
	]);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function main() {
	if (process.platform !== "darwin") throw new Error("Gate 2 macOS soak requires macOS");
	const options = parseArgs(process.argv.slice(2));
	for (const [filePath, label] of [
		[ELECTRON, "Electron"],
		[CHROME, "Google Chrome"],
		[FFPROBE, "ffprobe"],
		[FFMPEG, "ffmpeg"],
		[path.join(ROOT, "dist-electron", "bootstrap.js"), "production Electron build"],
	]) {
		requireExecutable(filePath, label);
	}

	const runRoot = options.resumeRoot
		? await validateOwnedRunRoot(options.resumeRoot)
		: await createOwnedRunRoot();
	const userData = path.join(runRoot, "user-data");
	const fixtureProfile = path.join(runRoot, "fixture-profile");
	const currentProjectPath = path.join(runRoot, "gate2-soak.klippt");
	const legacyProjectPath = path.join(runRoot, "gate2-soak.openscreen");
	const projectPath =
		options.resumeRoot && !fs.existsSync(currentProjectPath) && fs.existsSync(legacyProjectPath)
			? legacyProjectPath
			: currentProjectPath;
	const outputPath = path.join(runRoot, "gate2-soak-export.mp4");
	const fixtureTitle = `record Gate 2 Fixture ${process.pid}`;
	const reportPath =
		options.reportPath ??
		path.join(
			ROOT,
			"test-results",
			`gate2-macos-soak-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
		);
	await fsp.mkdir(path.dirname(reportPath), { recursive: true });

	const report = {
		version: 1,
		startedAt: new Date().toISOString(),
		status: "running",
		host: { platform: process.platform, arch: process.arch, release: os.release() },
		options,
		artifacts: { runRoot, projectPath, outputPath },
	};
	let fixture;
	try {
		let sourcePath;
		let recordWallMs = null;
		if (options.resumeRoot) {
			console.log(`[gate2] resuming validation and export from ${runRoot}`);
			const project = JSON.parse(await fsp.readFile(projectPath, "utf8"));
			sourcePath = sourcePathFromProject(project);
			if (typeof sourcePath !== "string" || sourcePath.length === 0) {
				throw new Error(`Project has no screen video path: ${projectPath}`);
			}
		} else {
			console.log(`[gate2] opening isolated animated fixture: ${fixtureTitle}`);
			fixture = spawn(
				CHROME,
				[
					`--user-data-dir=${fixtureProfile}`,
					"--no-first-run",
					"--disable-sync",
					"--disable-extensions",
					"--disable-background-networking",
					"--window-size=1280,720",
					`--app=${fixtureUrl(fixtureTitle)}`,
				],
				{ stdio: "ignore" },
			);
			await new Promise((resolve) => setTimeout(resolve, 3_000));

			console.log(`[gate2] recording ${options.durationSec}s through the production CLI path`);
			const record = await runCommand(
				ELECTRON,
				[
					ROOT,
					`--user-data-dir=${userData}`,
					"record",
					"--window",
					fixtureTitle,
					"--system-audio",
					"--duration",
					String(options.durationSec),
					"--project",
					projectPath,
					"--json",
				],
				{
					timeoutMs: options.durationSec * 1_000 + 120_000,
					ignoreProgressEvents: true,
					env: {
						ELECTRON_USER_DATA_DIR: userData,
						LANG: "en_US.UTF-8",
						LC_ALL: "en_US.UTF-8",
						LANGUAGE: "en_US",
					},
				},
			);
			await fsp.writeFile(path.join(runRoot, "record.stdout.log"), record.stdout);
			await fsp.writeFile(path.join(runRoot, "record.stderr.log"), record.stderr);
			const recordDone = parseDoneEvent(record.stdout);
			if (record.code !== 0 || !recordDone.success) {
				throw new Error(recordDone.error ?? `Record failed with code ${record.code}`);
			}
			sourcePath = recordDone.screenVideoPath;
			recordWallMs = record.wallMs;
		}
		const recoveryJournals = (await fsp.readdir(path.join(userData, "recordings"))).filter((name) =>
			name.endsWith(".recovery.json"),
		);
		if (recoveryJournals.length > 0) {
			throw new Error(
				`Successful CLI recording left an active recovery journal: ${recoveryJournals.join(", ")}`,
			);
		}
		const sourceProbe = await probeMedia(sourcePath, true, options.durationSec);
		const source = validateSource(sourceProbe, options.durationSec);
		const sourceCheckpoints = await decodeCheckpoints(sourcePath, source.durationSec);
		report.record = {
			wallMs: recordWallMs,
			path: sourcePath,
			sizeBytes: numeric(sourceProbe.format?.size),
			durationSec: source.durationSec,
			decodedFramesPerSec: source.frameRate,
			width: source.video.width,
			height: source.video.height,
			audioTracks: source.audio.map((stream) => ({
				index: stream.index,
				language: stream.tags?.language,
				sampleRate: numeric(stream.sample_rate),
				channels: stream.channels,
			})),
			decodeCheckpointsSec: sourceCheckpoints,
		};

		console.log(
			`[gate2] exporting ${source.durationSec.toFixed(3)}s through the production CLI path`,
		);
		const exportArgs = [
			ROOT,
			`--user-data-dir=${userData}`,
			"export",
			projectPath,
			"--out",
			outputPath,
			"--quality",
			options.quality,
			"--json",
		];
		const exportEnvironment = {
			ELECTRON_USER_DATA_DIR: userData,
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			LANGUAGE: "en_US",
		};
		if (options.interruptExport) {
			console.log("[gate2] forcing one export interruption before the clean retry");
			const interrupted = await interruptCommandAtProgress(ELECTRON, exportArgs, {
				timeoutMs: Math.max(120_000, options.durationSec * 1_000),
				env: exportEnvironment,
			});
			if (interrupted.interruptedAtPercent === null || interrupted.signal !== "SIGKILL") {
				throw new Error(
					`Export was not interrupted as requested (code=${interrupted.code}, signal=${interrupted.signal})`,
				);
			}
			const partial = await fsp.stat(outputPath).catch(() => null);
			if (!partial || partial.size === 0) {
				throw new Error("Interrupted export did not leave a partial output to replace");
			}
			report.interruptedExport = {
				atPercent: interrupted.interruptedAtPercent,
				wallMs: interrupted.wallMs,
				partialSizeBytes: partial.size,
				signal: interrupted.signal,
			};
		}
		const exportRun = await runCommand(ELECTRON, exportArgs, {
			timeoutMs: Math.max(10 * 60_000, options.durationSec * 2_000),
			ignoreProgressEvents: true,
			env: exportEnvironment,
		});
		await fsp.writeFile(path.join(runRoot, "export.stdout.log"), exportRun.stdout);
		await fsp.writeFile(path.join(runRoot, "export.stderr.log"), exportRun.stderr);
		const exportDone = parseDoneEvent(exportRun.stdout);
		if (exportRun.code !== 0 || !exportDone.success) {
			throw new Error(exportDone.error ?? `Export failed with code ${exportRun.code}`);
		}
		const exportProbe = await probeMedia(outputPath, true, source.durationSec);
		const exported = validateExport(exportProbe, source.durationSec, outputPath);
		const exportCheckpoints = await decodeCheckpoints(outputPath, exported.durationSec);
		report.export = {
			wallMs: exportRun.wallMs,
			realTimeFactor: exportRun.wallMs / (source.durationSec * 1_000),
			path: outputPath,
			sizeBytes: numeric(exportProbe.format?.size),
			durationSec: exported.durationSec,
			avDriftSec: exported.avDriftSec,
			width: exported.video.width,
			height: exported.video.height,
			frameRate: exported.video.avg_frame_rate,
			fieldOrder: exported.video.field_order,
			audioSampleRate: numeric(exported.audio.sample_rate),
			audioChannels: exported.audio.channels,
			fastStart: true,
			moovOffset: exported.moovOffset,
			mdatOffset: exported.mdatOffset,
			decodeCheckpointsSec: exportCheckpoints,
		};
		report.status = "passed";
		report.finishedAt = new Date().toISOString();
		await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.log(`[gate2] PASS — report: ${reportPath}`);
		if (options.keep) console.log(`[gate2] media kept at: ${runRoot}`);
	} catch (error) {
		report.status = "failed";
		report.finishedAt = new Date().toISOString();
		report.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
		await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
		console.error(`[gate2] FAIL — artifacts kept at ${runRoot}`);
		console.error(`[gate2] report: ${reportPath}`);
		throw error;
	} finally {
		if (fixture) await stopFixture(fixture);
		if (report.status === "passed" && !options.keep) {
			await fsp.rm(await validateOwnedRunRoot(runRoot), { recursive: true, force: true });
		}
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
	process.exitCode = 1;
});
