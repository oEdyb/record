import path from "node:path";

export function createCliSttSourceResolver(
	recordingsDir: string,
	resolveApprovedPath: (sourcePath: string) => string | null,
): (sourcePath: string) => Promise<{ sourcePath: string; forceNative: boolean } | null> {
	const resolvedRecordingsDir = path.resolve(recordingsDir);
	return async (sourcePath) => {
		const approvedPath = resolveApprovedPath(sourcePath);
		if (!approvedPath) return null;
		const resolvedPath = path.resolve(approvedPath);
		return {
			sourcePath: resolvedPath,
			forceNative:
				resolvedPath === resolvedRecordingsDir ||
				resolvedPath.startsWith(`${resolvedRecordingsDir}${path.sep}`),
		};
	};
}
