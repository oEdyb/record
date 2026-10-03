import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { writeJsonDurably } from "../filesystem/durableJson";

const MAX_RECORD_BYTES = 1024 * 1024;
const recordSchema = z.strictObject({
	version: z.literal(1),
	paths: z.array(z.string().min(1).max(4096)).max(4096),
});

/** Private main-process grants. Project JSON is never a grant source.
 * The caller supplies a canonical path when resolving; every explicit grant
 * canonicalizes again so a later symlink swap cannot inherit the old grant.
 */
export class MediaAccessRegistry {
	private readonly paths: Set<string>;
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private readonly filePath: string) {
		try {
			if (statSync(filePath).size > MAX_RECORD_BYTES)
				throw new Error("Media grants exceed their size limit");
			const record = recordSchema.parse(JSON.parse(readFileSync(filePath, "utf8")));
			if (record.paths.some((value) => !path.isAbsolute(value)))
				throw new Error("Invalid media grant path");
			this.paths = new Set(record.paths);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			this.paths = new Set();
		}
	}
	hasCanonicalPath(canonicalPath: string): boolean {
		return this.paths.has(canonicalPath);
	}

	/** Only call after an actual native picker or canonical project-directory check. */
	grantSelectedFile(filePath: string, trustedDirectories?: readonly string[]): Promise<string> {
		const work = this.tail
			.catch(() => undefined)
			.then(async () => {
				const canonical = await fs.realpath(filePath);
				if (trustedDirectories) {
					const roots = await Promise.all(trustedDirectories.map((root) => fs.realpath(root)));
					if (
						!roots.some((root) => {
							const relative = path.relative(root, canonical);
							return (
								relative !== ".." &&
								!relative.startsWith(`..${path.sep}`) &&
								!path.isAbsolute(relative)
							);
						})
					)
						throw new Error("Project media escapes its approved directory");
				}

				if (!(await fs.stat(canonical)).isFile())
					throw new Error("Media grant requires a regular file");
				if (this.paths.has(canonical)) return canonical;
				const record = recordSchema.parse({ version: 1, paths: [...this.paths, canonical] });
				if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_RECORD_BYTES)
					throw new Error("Media grants exceed their size limit");
				await writeJsonDurably(this.filePath, record);
				this.paths.add(canonical);
				return canonical;
			});
		this.tail = work;
		return work;
	}
}
