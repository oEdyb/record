import { spawn } from "node:child_process";

const EXTRACT_TIMEOUT_MS = 60_000;

/**
 * Decodes one isolated microphone original to 16 kHz mono PCM, the input Parakeet
 * expects. The original is never modified; the WAV is a throwaway copy.
 */
export function extractMicrophoneWav(
	ffmpegPath: string,
	inputPath: string,
	outputPath: string,
	spawnProcess: typeof spawn = spawn,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawnProcess(
			ffmpegPath,
			[
				"-hide_banner",
				"-nostdin",
				"-loglevel",
				"error",
				"-y",
				"-i",
				inputPath,
				"-map",
				"0:a:0",
				"-ac",
				"1",
				"-ar",
				"16000",
				"-c:a",
				"pcm_s16le",
				"-f",
				"wav",
				outputPath,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("Microphone audio extraction timed out."));
		}, EXTRACT_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error(stderr.trim() || `FFmpeg exited with code ${code ?? "unknown"}.`));
		});
	});
}
