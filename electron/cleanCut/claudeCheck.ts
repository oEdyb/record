import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { claudeCliModel, findClaudeCli } from "./claudeCliModel";
import type { DecisionModel } from "./types";

/**
 * The one switch that lets Clean cut send a recording's transcript to Claude. It is off until the
 * person turns it on; a missing, unreadable or malformed file is off, so an existing install that
 * never saw the setting stays local.
 */
export class ClaudeCheckSetting {
	constructor(private readonly file: string) {}

	async get(): Promise<boolean> {
		try {
			const saved = JSON.parse(await readFile(this.file, "utf8")) as { claudeCheck?: unknown };
			return saved.claudeCheck === true;
		} catch {
			return false;
		}
	}

	async set(enabled: boolean): Promise<void> {
		await mkdir(path.dirname(this.file), { recursive: true });
		const pending = `${this.file}.tmp`;
		await writeFile(pending, JSON.stringify({ claudeCheck: enabled === true }), "utf8");
		await rename(pending, this.file);
	}
}

export interface CleanCutModelDeps {
	claudeCheck: () => Promise<boolean>;
	model: () => DecisionModel | null;
}

/**
 * What the Clean cut service asks before it touches any CLI. The search for a `claude` binary only
 * runs after the setting says yes.
 */
export function cleanCutModelDeps(options: {
	setting: ClaudeCheckSetting;
	cacheDir: string;
	cacheOnly?: boolean;
	searchPath?: readonly string[];
}): CleanCutModelDeps {
	return {
		claudeCheck: () => options.setting.get(),
		model: () => {
			const binary = findClaudeCli(options.searchPath);
			if (!binary) return null;
			return claudeCliModel({
				binary,
				cacheDir: options.cacheDir,
				cacheOnly: options.cacheOnly,
			});
		},
	};
}
