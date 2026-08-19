import type { NativeMacRecordingRequest } from "../../src/lib/nativeMacRecording";

type NativeMacSource = NativeMacRecordingRequest["source"];

const uniqueSorted = (values: number[]) => [...new Set(values)].sort((a, b) => a - b);

/**
 * Exclude both current recorder windows and the recorder process. ScreenCaptureKit
 * applies the process rule to private windows that OpenScreen creates later.
 */
export function addNativeMacDisplayPrivacyExclusions(
	source: NativeMacSource,
	options: { windowIds: number[]; processId: number },
): NativeMacSource {
	if (source.type !== "display") return source;
	return {
		...source,
		excludedWindowIds: uniqueSorted([...(source.excludedWindowIds ?? []), ...options.windowIds]),
		excludedProcessIds: uniqueSorted([...(source.excludedProcessIds ?? []), options.processId]),
	};
}
