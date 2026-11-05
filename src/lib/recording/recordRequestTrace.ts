let activeToken: number | undefined;

export function receiveRecordRequest(token: number | undefined) {
	activeToken = token;
}

export function traceRecordRequest(
	stage: string,
	flags: Record<string, boolean | number | null> = {},
) {
	if (activeToken !== undefined)
		window.electronAPI?.traceRecordRequest?.({ token: activeToken, stage, flags });
}
