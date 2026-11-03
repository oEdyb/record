import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DecisionModel } from "./types";

const DENY = "Bash,Edit,Write,Read,WebFetch,WebSearch,Glob,Grep,Task";
const CALL_TIMEOUT_MS = 25 * 60_000;
const SEARCH_PATH = [
	"/opt/homebrew/bin",
	"/usr/local/bin",
	path.join(process.env.HOME ?? "", ".local/bin"),
];

/**
 * The Claude Code CLI on this computer, if any. Finding it sends nothing; only calling `ask` does,
 * and only after the person has turned the Claude check on (see claudeCheck.ts).
 */
export function findClaudeCli(searchPath: readonly string[] = SEARCH_PATH): string | null {
	for (const dir of searchPath) {
		const candidate = path.join(dir, "claude");
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export function replyCachePath(cacheDir: string, prompt: string, model: string, label: string) {
	const key = createHash("sha256").update(`${model}\n${prompt}`).digest("hex").slice(0, 20);
	return path.join(cacheDir, `${label}-${key}.txt`);
}

/**
 * Asks Claude through the local CLI. Only transcript text is sent. Replies are cached by prompt,
 * so the same recording never pays twice.
 */
export function claudeCliModel(options: {
	binary: string;
	cacheDir: string;
	model?: string;
	/** Never call Claude; a reply missing from the cache fails the call. For tests and offline runs. */
	cacheOnly?: boolean;
	spawnProcess?: typeof spawn;
}): DecisionModel {
	const model = options.model ?? "sonnet";
	return {
		async ask(prompt, label) {
			const hit = replyCachePath(options.cacheDir, prompt, model, label);
			const cached = await readFile(hit, "utf8").catch(() => null);
			if (cached !== null) return cached;
			if (options.cacheOnly) throw new Error(`No cached ${label} reply.`);
			const reply = await new Promise<string>((resolve, reject) => {
				const child = (options.spawnProcess ?? spawn)(
					options.binary,
					["-p", "--model", model, "--disallowedTools", DENY],
					{ cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] },
				);
				let out = "";
				let err = "";
				child.stdout.on("data", (chunk: Buffer) => {
					out += chunk.toString("utf8");
				});
				child.stderr.on("data", (chunk: Buffer) => {
					err += chunk.toString("utf8");
				});
				const timer = setTimeout(() => child.kill("SIGKILL"), CALL_TIMEOUT_MS);
				child.on("error", (error) => {
					clearTimeout(timer);
					reject(error);
				});
				child.on("exit", (code) => {
					clearTimeout(timer);
					if (code === 0) resolve(out);
					else reject(new Error(err.trim() || `Claude exited with code ${code ?? "unknown"}.`));
				});
				child.stdin.end(prompt);
			});
			await mkdir(options.cacheDir, { recursive: true });
			await writeFile(hit, reply);
			return reply;
		},
	};
}
