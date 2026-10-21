import { spawn } from "node:child_process";

const DECODE_TIMEOUT_MS = 15 * 60_000;

/**
 * Decodes the first audio stream of a media file to mono Float32 PCM at 16 kHz, with the bundled
 * FFmpeg. The file is only read.
 */
export function decodeMonoPcm16k(
	ffmpegPath: string,
	inputPath: string,
	spawnProcess: typeof spawn = spawn,
): Promise<Float32Array> {
	return new Promise((resolve, reject) => {
		const child = spawnProcess(
			ffmpegPath,
			[
				"-hide_banner",
				"-nostdin",
				"-loglevel",
				"error",
				"-i",
				inputPath,
				"-map",
				"0:a:0",
				"-vn",
				"-ac",
				"1",
				"-ar",
				"16000",
				"-f",
				"f32le",
				"-",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		const chunks: Buffer[] = [];
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Audio decoding timed out."));
		}, DECODE_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(stderr.trim() || `FFmpeg exited with code ${code ?? "unknown"}.`));
				return;
			}
			const bytes = Buffer.concat(chunks);
			const pcm = new Float32Array(Math.floor(bytes.length / 4));
			new Uint8Array(pcm.buffer).set(bytes.subarray(0, pcm.length * 4));
			resolve(pcm);
		});
	});
}
