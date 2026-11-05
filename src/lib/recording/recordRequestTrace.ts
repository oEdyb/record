let activeToken: number | undefined;

export function receiveRecordRequest(token: number | undefined): boolean {
	if (token === undefined) return activeToken === undefined;
	if (!Number.isSafeInteger(token) || token <= 0) return false;
	if (activeToken !== undefined && activeToken !== token) {
		window.electronAPI?.traceRecordRequest?.({
			token,
			stage: "renderer-guard",
			flags: { starting: true },
		});
		return false;
	}
	activeToken = token;
	return true;
}

export function traceRecordRequest(
	stage: string,
	flags: Record<string, boolean | number | null> = {},
) {
	if (activeToken === undefined) return;
	window.electronAPI?.traceRecordRequest?.({ token: activeToken, stage, flags });
	if (
		[
			"writer-started",
			"windows-writer-started",
			"browser-writer-started",
			"renderer-guard",
			"prepare-failed",
			"writer-failed",
			"selector-rejected",
			"permission-required",
		].includes(stage) ||
		(stage === "cleanup" && !flags.captureStarted) ||
		(stage === "selector-result" && !flags.portalOwnsSelection) ||
		(stage === "hook-entry" &&
			(flags.pending || flags.recording || flags.sourceSelectionInFlight || flags.writerPending))
	)
		activeToken = undefined;
}
