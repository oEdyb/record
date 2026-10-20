const REMOTE_METHOD_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

/** The sentence a main-process handler threw, without Electron's IPC wrapper. */
export function ipcErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(REMOTE_METHOD_PREFIX, "").trim();
}
