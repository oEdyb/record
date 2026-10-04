import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function copyOriginalFile(source: string, destination: string): Promise<void> {
	if (!path.isAbsolute(source) || !path.isAbsolute(destination))
		throw new Error("Source export requires absolute file paths.");
	if (process.platform !== "darwin") {
		await fs.copyFile(source, destination, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
		return;
	}
	const existing = await fs.lstat(destination).catch((error: unknown) => {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	});
	if (existing) throw new Error(`Source export destination already exists: ${destination}`);
	// libuv's FICLONE flag does not invoke clonefile on macOS. cp falls back on other volumes.
	await execute("/bin/cp", ["-c", "-n", source, destination]);
}
