import path from "node:path";

/** Pure path policy, shared without importing the main-process startup module. */
export function recordingsDirectory(userDataPath: string): string {
	return path.join(userDataPath, "recordings");
}
