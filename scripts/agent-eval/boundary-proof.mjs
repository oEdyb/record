import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function pixelDifference(left, right) {
	if (!left.length || left.length !== right.length)
		throw new Error("Pixel buffers must have equal nonzero lengths.");
	let difference = 0;
	for (let i = 0; i < left.length; i++) difference += Math.abs(left[i] - right[i]);
	return difference / (left.length * 255);
}

export function gradeBoundarySequence(sequence, pixels, references) {
	const gaps = [];
	const failures = [];
	if (!sequence.revision || !sequence.sha256 || !sequence.project_id || !sequence.time_base)
		gaps.push("missing_identity");
	if (!(sequence.fps > 0 && sequence.fps <= 240) || sequence.frames.length < 3)
		gaps.push("missing_cadence");
	if (!["seek", "playback"].includes(sequence.mode)) gaps.push("missing_mode");
	if (sequence.source !== "live") gaps.push("not_live");
	sequence.frames.forEach((frame, index) => {
		if (!Number.isFinite(frame.requested_time) || !Number.isFinite(frame.observed_time))
			gaps.push(`missing_time:${index}`);
		if (frame.freshness !== "settled") gaps.push(`unproven_freshness:${index}`);
		if (Math.abs(frame.requested_time - frame.observed_time) > 0.5 / sequence.fps)
			gaps.push(`wrong_time:${index}`);
		if (
			index > 0 &&
			Math.abs(frame.observed_time - sequence.frames[index - 1].observed_time - 1 / sequence.fps) >
				0.25 / sequence.fps
		)
			gaps.push(`nonconsecutive:${index}`);
		if (!pixels[index] || !references[index]) gaps.push(`missing_pixels:${index}`);
		else if (pixelDifference(pixels[index], references[index]) > (sequence.max_difference ?? 0.1))
			failures.push({
				frame: index,
				difference: pixelDifference(pixels[index], references[index]),
			});
	});
	return {
		status: failures.length ? "failed" : gaps.length ? "unavailable" : "passed",
		failures,
		gaps: [...new Set(gaps)],
		scope:
			"Pixel comparison to supplied corrected reference frames at this cadence only; not visual review or proof outside this interval.",
	};
}

function decode(file, ffmpeg) {
	const result = spawnSync(
		ffmpeg,
		[
			"-v",
			"error",
			"-nostdin",
			"-i",
			file,
			"-frames:v",
			"1",
			"-vf",
			"scale=160:90",
			"-pix_fmt",
			"rgb24",
			"-f",
			"rawvideo",
			"pipe:1",
		],
		{ timeout: 15000, maxBuffer: 1024 * 1024 },
	);
	if (result.status !== 0 || result.stdout?.length !== 160 * 90 * 3)
		throw new Error(`Cannot decode ${file}: ${result.stderr}`);
	return result.stdout;
}
const escapeHtml = (value) =>
	String(value).replace(
		/[&<>"']/g,
		(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
	);

export function createBoundaryProof(manifest, outDirectory, ffmpeg = "ffmpeg") {
	if (
		!Array.isArray(manifest.sequences) ||
		!manifest.sequences.length ||
		manifest.sequences.length > 8
	)
		throw new Error("Expected one to eight labeled sequences.");
	fs.mkdirSync(outDirectory, { recursive: true });
	const sections = [];
	const results = manifest.sequences.map((sequence) => {
		if (!Array.isArray(sequence.frames) || sequence.frames.length > 240)
			throw new Error("Expected at most 240 frames per sequence.");
		const pixels = sequence.frames.map((frame) => decode(frame.path, ffmpeg));
		const references = sequence.frames.map((frame) => decode(frame.reference_path, ffmpeg));
		const result = gradeBoundarySequence(sequence, pixels, references);
		const images = sequence.frames
			.map((frame) => {
				const mime = /\.png$/i.test(frame.path) ? "image/png" : "image/jpeg";
				return `<figure><img src="data:${mime};base64,${fs.readFileSync(frame.path).toString("base64")}"><figcaption>requested ${escapeHtml(frame.requested_time)}; observed ${escapeHtml(frame.observed_time)}; ${escapeHtml(frame.freshness)}</figcaption></figure>`;
			})
			.join("");
		sections.push(
			`<section><h2>${escapeHtml(sequence.label)}: ${result.status}</h2><p>${escapeHtml(sequence.source)} / ${escapeHtml(sequence.mode)} / ${escapeHtml(sequence.time_base)} / ${escapeHtml(sequence.fps)} fps / revision ${escapeHtml(sequence.revision)} / SHA-256 ${escapeHtml(sequence.sha256)}</p><div>${images}</div></section>`,
		);
		return { ...sequence, ...result };
	});
	const modes = new Set(
		results.filter((result) => result.status === "passed").map((result) => result.mode),
	);
	const result = {
		status: results.some((result) => result.status === "failed")
			? "failed"
			: modes.has("seek") &&
					modes.has("playback") &&
					results.every((result) => result.status === "passed")
				? "passed"
				: "unavailable",
		results,
		visual_review: "pending",
		sheet: path.resolve(outDirectory, "contact-sheets.html"),
	};
	fs.writeFileSync(
		result.sheet,
		`<!doctype html><meta charset="utf-8"><title>Boundary proof</title><style>body{font:15px system-ui;background:#161616;color:#eee}div{display:flex;flex-wrap:wrap}figure{margin:8px;width:320px}img{width:320px}p{overflow-wrap:anywhere}</style><h1>Before/after boundary evidence</h1><p>Creating this sheet is not visual review. Sparse samples cannot exclude a one-frame flash.</p>${sections.join("")}`,
	);
	fs.writeFileSync(
		path.join(outDirectory, "boundary-result.json"),
		`${JSON.stringify(result, null, 2)}\n`,
	);
	return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output)
		throw new Error(
			"Usage: node scripts/agent-eval/boundary-proof.mjs manifest.json output-directory",
		);
	const result = createBoundaryProof(JSON.parse(fs.readFileSync(input, "utf8")), output);
	console.log(JSON.stringify(result));
	process.exitCode = result.status === "passed" ? 0 : 1;
}
