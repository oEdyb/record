#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const archTag = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";

function parseArgs() {
	const values = process.argv.slice(2);
	const input = values.find((value) => !value.startsWith("--"));
	const outputIndex = values.indexOf("--output-dir");
	const amountIndex = values.indexOf("--attenuation-limit-db");
	if (!input || outputIndex < 0 || !values[outputIndex + 1]) {
		throw new Error(
			"Usage: npm run clean-voice:lab -- INPUT --output-dir DIR [--attenuation-limit-db 6] [--skip-determinism-check]",
		);
	}
	const attenuationLimitDb = amountIndex >= 0 ? Number(values[amountIndex + 1]) : 6;
	if (!Number.isFinite(attenuationLimitDb) || attenuationLimitDb <= 0 || attenuationLimitDb > 30) {
		throw new Error("--attenuation-limit-db must be greater than 0 and no more than 30");
	}
	return {
		input: path.resolve(input),
		outputDir: path.resolve(values[outputIndex + 1]),
		attenuationLimitDb,
		checkDeterminism: !values.includes("--skip-determinism-check"),
	};
}

function executable(candidates) {
	return candidates.find((candidate) => {
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.statSync(candidate).isFile();
		} catch {
			return false;
		}
	});
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr = (stderr + chunk.toString()).slice(-16_384);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${path.basename(command)} exited ${code}: ${stderr || stdout}`));
		});
	});
}

function sha256(filePath) {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = fs.createReadStream(filePath);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("error", reject);
		stream.once("end", () => resolve(hash.digest("hex")));
	});
}

async function writeJsonAtomically(filePath, value) {
	const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
	const file = await fs.promises.open(temporary, "wx", 0o600);
	try {
		await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
		await file.sync();
	} finally {
		await file.close();
	}
	try {
		await fs.promises.rename(temporary, filePath);
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}

async function syncDirectory(directoryPath) {
	const directory = await fs.promises.open(directoryPath, "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function main() {
	const args = parseArgs();
	if (process.platform !== "darwin") {
		throw new Error("The first Clean Voice lab backend is available on macOS only");
	}
	if (fs.existsSync(args.outputDir)) {
		throw new Error("--output-dir must be a new path so one lab run publishes as one transaction");
	}
	const helper = executable(
		[
			process.env.KLIPPT_CLEAN_VOICE_HELPER_PATH ?? "",
			path.join(root, "electron", "native", "clean-voice", "build", "klippt-clean-voice"),
		].filter(Boolean),
	);
	if (!helper) throw new Error("Build the helper first: npm run build:native:clean-voice:mac");

	const parent = path.dirname(args.outputDir);
	await fs.promises.mkdir(parent, { recursive: true });
	const stagingDir = path.join(
		parent,
		`.${path.basename(args.outputDir)}.${process.pid}.${randomUUID()}.tmp`,
	);
	await fs.promises.mkdir(stagingDir, { mode: 0o700 });
	let published = false;
	try {
		const rawPath = path.join(stagingDir, "raw-microphone.wav");
		const cleanPath = path.join(stagingDir, "clean-microphone.wav");
		const verificationPath = path.join(stagingDir, ".clean-microphone-verification.wav");
		const manifestPath = path.join(stagingDir, "clean-voice-manifest.json");
		const isWav = path.extname(args.input).toLowerCase() === ".wav";

		if (isWav) {
			await fs.promises.copyFile(args.input, rawPath, fs.constants.COPYFILE_EXCL);
		} else {
			const ffmpeg = executable(
				[
					process.env.KLIPPT_FFMPEG_PATH ?? "",
					path.join(root, "electron", "native", "bin", archTag, "ffmpeg"),
					"/opt/homebrew/bin/ffmpeg",
					"/usr/local/bin/ffmpeg",
				].filter(Boolean),
			);
			if (!ffmpeg) throw new Error("FFmpeg is required to extract the isolated microphone track");
			await run(ffmpeg, [
				"-hide_banner",
				"-loglevel",
				"error",
				"-nostdin",
				"-i",
				args.input,
				"-map",
				"0:m:language:qac",
				"-vn",
				"-ac",
				"1",
				"-ar",
				"48000",
				"-c:a",
				"pcm_f32le",
				"-y",
				rawPath,
			]);
		}

		const helperArgs = (output) => [
			"--input",
			rawPath,
			"--output",
			output,
			"--attenuation-limit-db",
			String(args.attenuationLimitDb),
		];
		const first = JSON.parse((await run(helper, helperArgs(cleanPath))).stdout);
		if (args.checkDeterminism) {
			await run(helper, helperArgs(verificationPath));
			const [firstHash, secondHash] = await Promise.all([
				sha256(cleanPath),
				sha256(verificationPath),
			]);
			if (firstHash !== secondHash)
				throw new Error("Clean Voice produced different output on rerun");
			await fs.promises.rm(verificationPath, { force: true });
		}

		const [sourceHash, rawHash, outputHash, helperHash] = await Promise.all([
			sha256(args.input),
			sha256(rawPath),
			sha256(cleanPath),
			sha256(helper),
		]);
		const finalRawPath = path.join(args.outputDir, "raw-microphone.wav");
		const finalCleanPath = path.join(args.outputDir, "clean-microphone.wav");
		const finalManifestPath = path.join(args.outputDir, "clean-voice-manifest.json");
		const manifest = {
			version: 1,
			createdAt: new Date().toISOString(),
			source: { path: args.input, sha256: sourceHash },
			input: { path: finalRawPath, sha256: rawHash, sampleCount: first.inputSamples },
			output: { path: finalCleanPath, sha256: outputHash, sampleCount: first.outputSamples },
			engine: {
				id: first.engineId,
				commit: first.engineCommit,
				modelSha256: first.modelSha256,
				helperSha256: helperHash,
			},
			preset: {
				id: args.attenuationLimitDb === 6 ? "natural-v1" : "lab-custom-v1",
				attenuationLimitDb: args.attenuationLimitDb,
				postFilter: false,
			},
			quality: {
				delaySamplesRemoved: first.delaySamples,
				inputPeak: first.inputPeak,
				outputPeak: first.outputPeak,
				realTimeFactor: first.realTimeFactor,
				deterministic: args.checkDeterminism,
			},
		};
		await writeJsonAtomically(manifestPath, manifest);
		await syncDirectory(stagingDir);
		await fs.promises.rename(stagingDir, args.outputDir);
		await syncDirectory(parent);
		published = true;

		console.log(`Raw:      ${finalRawPath}`);
		console.log(`Clean:    ${finalCleanPath}`);
		console.log(`Manifest: ${finalManifestPath}`);
		console.log(`RTF:      ${first.realTimeFactor.toFixed(3)}`);
	} finally {
		if (!published) await fs.promises.rm(stagingDir, { recursive: true, force: true });
	}
}

await main();
