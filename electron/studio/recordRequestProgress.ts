const STAGES = new Set([
	"receipt",
	"renderer-guard",
	"route",
	"hook-entry",
	"click",
	"source-read",
	"start-entry",
	"native-start",
	"helper-available",
	"camera-ready",
	"start-requested",
	"writer-started",
	"windows-writer-started",
	"browser-writer-started",
	"writer-failed",
	"prepare-failed",
	"cleanup",
	"selector-result",
	"selector-rejected",
	"permission-required",
]);
const FLAGS = new Set([
	"recording",
	"starting",
	"saving",
	"hasSelectedSource",
	"sourceSelected",
	"pending",
	"sourceSelectionInFlight",
	"selectionInFlight",
	"nativeMacWriter",
	"nativeWindowsWriter",
	"browserWriter",
	"writerPending",
	"recordingId",
	"captureStarted",
	"opened",
	"portalOwnsSelection",
]);

export function parseRecordRequestProgress(raw: unknown) {
	if (!raw || typeof raw !== "object") return null;
	const value = raw as Record<string, unknown>;
	if (
		typeof value.token !== "number" ||
		!Number.isSafeInteger(value.token) ||
		value.token <= 0 ||
		typeof value.stage !== "string" ||
		!STAGES.has(value.stage)
	)
		return null;
	const flags: Record<string, boolean | number | null> = {};
	if (value.flags && typeof value.flags === "object")
		for (const [key, flag] of Object.entries(value.flags))
			if (
				FLAGS.has(key) &&
				(flag === null ||
					typeof flag === "boolean" ||
					(typeof flag === "number" && Number.isFinite(flag)))
			)
				flags[key] = flag;
	return { token: value.token, stage: value.stage, flags };
}
