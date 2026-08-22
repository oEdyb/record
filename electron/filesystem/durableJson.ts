import fs from "node:fs/promises";
import path from "node:path";

async function resolveFinalSymlink(filePath: string): Promise<string> {
	let resolved = filePath;
	const visited = new Set<string>();
	for (;;) {
		if (visited.has(resolved)) throw new Error(`Circular output symlink: ${filePath}`);
		visited.add(resolved);
		try {
			const stats = await fs.lstat(resolved);
			if (!stats.isSymbolicLink()) return resolved;
			const target = await fs.readlink(resolved);
			resolved = path.resolve(path.dirname(resolved), target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return resolved;
			throw error;
		}
	}
}

/**
 * Replaces one JSON file only after its contents and directory entry are durable.
 * A failed write leaves the previous destination intact and removes its temp file.
 */
export async function writeJsonDurably(
	filePath: string,
	value: unknown,
	options: { followFinalSymlink?: boolean } = {},
): Promise<void> {
	const serialized = JSON.stringify(value, null, 2);
	if (serialized === undefined) {
		throw new TypeError("JSON value cannot be serialized.");
	}
	// Internal state must replace a planted symlink. User-selected CLI output
	// follows the final symlink to keep normal file-write behavior.
	const targetPath = options.followFinalSymlink ? await resolveFinalSymlink(filePath) : filePath;
	const directory = path.dirname(targetPath);
	const temporaryPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(16)
		.slice(2)}`;
	const json = `${serialized}\n`;
	await fs.mkdir(directory, { recursive: true });

	let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(json, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await fs.rename(temporaryPath, targetPath);

		// Persist the rename as well as the file contents. Windows cannot open a
		// directory handle, but its rename still gives us one-file replacement.
		if (process.platform !== "win32") {
			const directoryHandle = await fs.open(directory, "r");
			try {
				await directoryHandle.sync();
			} finally {
				await directoryHandle.close();
			}
		}
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.unlink(temporaryPath).catch(() => undefined);
		throw error;
	}
}
