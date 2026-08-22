/**
 * One project-file contract shared by the renderer, Electron main process,
 * and CLI. The JSON schema is independent from the filename extension.
 */
export const PROJECT_FILE_EXTENSION = "klippt";
export const LEGACY_PROJECT_FILE_EXTENSIONS = ["openscreen", "axcut"] as const;
export const SUPPORTED_PROJECT_FILE_EXTENSIONS = [
	PROJECT_FILE_EXTENSION,
	...LEGACY_PROJECT_FILE_EXTENSIONS,
] as const;

function extensionOf(fileNameOrPath: string): string {
	const leaf = fileNameOrPath.split(/[\\/]/).pop() ?? "";
	const dot = leaf.lastIndexOf(".");
	return dot >= 0 ? leaf.slice(dot + 1).toLowerCase() : "";
}

export function isSupportedProjectFile(fileNameOrPath: string): boolean {
	const extension = extensionOf(fileNameOrPath);
	return SUPPORTED_PROJECT_FILE_EXTENSIONS.some((candidate) => candidate === extension);
}

export function hasCanonicalProjectExtension(fileNameOrPath: string): boolean {
	return extensionOf(fileNameOrPath) === PROJECT_FILE_EXTENSION;
}

export function withCanonicalProjectExtension(fileNameOrPath: string): string {
	if (hasCanonicalProjectExtension(fileNameOrPath)) return fileNameOrPath;
	if (isSupportedProjectFile(fileNameOrPath)) {
		return fileNameOrPath.slice(0, fileNameOrPath.lastIndexOf(".")) + `.${PROJECT_FILE_EXTENSION}`;
	}
	return `${fileNameOrPath}.${PROJECT_FILE_EXTENSION}`;
}
