import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeRecordingPrefs, type RecordingPrefs } from "./recordingPrefsStore";

export interface RecordingSource {
	id: string;
	name: string;
	display_id?: string;
}

export interface ProjectRecordingSetup {
	prefs: RecordingPrefs;
	source: RecordingSource | null;
}

export function recordingSource(value: unknown): RecordingSource | null {
	if (!value || typeof value !== "object" || !("id" in value) || !("name" in value)) {
		return null;
	}
	if (typeof value.id !== "string" || typeof value.name !== "string") return null;
	return {
		id: value.id,
		name: value.name,
		...("display_id" in value && typeof value.display_id === "string"
			? { display_id: value.display_id }
			: {}),
	};
}

export function matchRecordingSource<T extends RecordingSource>(
	saved: RecordingSource | null,
	sources: T[],
): T | null {
	if (!saved) return null;
	if (saved.id.startsWith("screen:") && saved.display_id) {
		return (
			sources.find(
				(source) => source.id.startsWith("screen:") && source.display_id === saved.display_id,
			) ?? null
		);
	}
	return sources.find((source) => source.id === saved.id) ?? null;
}

export class ProjectRecordingSetupStore {
	private writes: Promise<void> = Promise.resolve();

	constructor(private readonly directory: string) {}

	private filePath(projectId: string): string {
		return path.join(
			this.directory,
			`${createHash("sha256").update(projectId).digest("hex")}.json`,
		);
	}

	async get(projectId: string): Promise<ProjectRecordingSetup | null> {
		await this.writes;
		try {
			const raw: unknown = JSON.parse(await fs.readFile(this.filePath(projectId), "utf8"));
			if (!raw || typeof raw !== "object" || !("prefs" in raw) || !("source" in raw)) {
				throw new Error("Invalid project recording setup");
			}
			return { prefs: normalizeRecordingPrefs(raw.prefs), source: recordingSource(raw.source) };
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
			throw error;
		}
	}

	set(projectId: string, setup: ProjectRecordingSetup): Promise<void> {
		const contents = JSON.stringify({
			prefs: normalizeRecordingPrefs(setup.prefs),
			source: recordingSource(setup.source),
		});
		const write = this.writes.then(async () => {
			await fs.mkdir(this.directory, { recursive: true });
			const destination = this.filePath(projectId);
			const temporary = `${destination}.${randomUUID()}.tmp`;
			try {
				await fs.writeFile(temporary, contents, "utf8");
				await fs.rename(temporary, destination);
			} finally {
				await fs.rm(temporary, { force: true });
			}
		});
		this.writes = write.catch(() => undefined);
		return write;
	}
}
