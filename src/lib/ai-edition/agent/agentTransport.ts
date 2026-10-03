export interface AgentTransportVideo {
	src: string;
	currentTimeSec: number;
	paused: boolean;
	readyState: number;
}

export interface AgentTransportSnapshot {
	currentTimeSec: number;
	playing: boolean;
	videoTimeSec: number | null;
	videoPaused: boolean | null;
	/** False when the shell still holds a video element that left the page. */
	videoConnected?: boolean | null;
	/** Every live <video> element, so a stale or orphaned one shows up. */
	videos?: AgentTransportVideo[];
}

export interface AgentNativeFrameEvidence {
	timeBase: "source";
	viewId: number;
	clipIndex: number;
	sourceTimeSec: number;
	generation: number;
}

export interface AgentTransportHandlers {
	seek: (rawSec: number) => void;
	/** Real pointer events on a `data-testid` element, x as a fraction of the timeline canvas. */
	click: (testId: string, fraction: number) => void;
	/** A real wheel event on a `data-testid` element (Ctrl zooms, Shift or deltaX pans). */
	wheel: (testId: string, fraction: number, deltaX: number, deltaY: number, ctrl: boolean) => void;
	/** A small JPEG data URL of the composited preview, or null when there is no canvas. */
	frame: () => string | null;
	frameEvidence?: () => AgentNativeFrameEvidence | null;
	/** Resolves true once the preview canvas shows a frame composed under the latest
	 *  seek/transport anchor, false when the budget expires. Without it a frame
	 *  sample captures whatever is painted — which, right after a seek, is still
	 *  the PRE-seek frame while the sample already claims the new time. */
	awaitFrameSettled?: (budgetMs: number) => Promise<boolean>;
	play: () => void;
	pause: () => void;
	snapshot: () => AgentTransportSnapshot;
}

export type AgentTransportStep =
	| { op: "play" }
	| { op: "pause" }
	| { op: "seek"; sec: number }
	| { op: "click"; testId: string; fraction: number }
	| {
			op: "wheel";
			testId: string;
			fraction: number;
			deltaX?: number;
			deltaY?: number;
			ctrl?: boolean;
	  }
	| { op: "wait"; ms: number }
	| { op: "sample"; label?: string; frame?: boolean }
	| { op: "probe"; ms: number };

export interface AgentTransportSample extends AgentTransportSnapshot {
	label: string;
	atMs: number;
	frame?: string | null;
	/** Present on frame samples when the settle handshake exists: true = the
	 *  canvas shows a frame composed under the latest anchor; false = the wait
	 *  expired and the pixels may predate the requested instant. */
	frameSettled?: boolean;
	nativeFrame?: AgentNativeFrameEvidence | null;
}

export interface AgentTransportProbe {
	start: () => void;
	stop: () => void;
	report: () => unknown;
}

export interface AgentTransportResult {
	samples: AgentTransportSample[];
	probe: unknown | null;
}

export const MAX_TRANSPORT_STEPS = 50;
export const MAX_TRANSPORT_WAIT_MS = 60_000;
/** Bounded settle wait before a frame sample; long enough for a cross-clip
 *  seek (decoder swap measured at ~120 ms, cold stills at ~6 s of process
 *  boot, not decode), short enough to keep a 50-step run responsive. */
export const FRAME_SETTLE_BUDGET_MS = 3_000;

let handlers: AgentTransportHandlers | null = null;

/** The editor shell registers the same play/seek paths its own controls use. */
export function registerAgentTransport(next: AgentTransportHandlers): () => void {
	handlers = next;
	return () => {
		if (handlers === next) handlers = null;
	};
}

export function getAgentTransport(): AgentTransportHandlers | null {
	return handlers;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Drive the editor like a user would and record what the transport reports
 * after each step. `probe` wraps the UI frame probe so a run can measure
 * playback smoothness with real numbers instead of a feeling.
 */
export async function runAgentTransport(
	steps: AgentTransportStep[],
	transport: AgentTransportHandlers,
	probe: AgentTransportProbe | null = null,
	now: () => number = () => performance.now(),
): Promise<AgentTransportResult> {
	if (steps.length > MAX_TRANSPORT_STEPS) throw new Error("TRANSPORT_TOO_LONG: at most 50 steps");
	const totalWait = steps.reduce(
		(sum, step) => sum + (step.op === "wait" || step.op === "probe" ? step.ms : 0),
		0,
	);
	if (totalWait > MAX_TRANSPORT_WAIT_MS)
		throw new Error("TRANSPORT_TOO_LONG: at most 60 s of waiting per run");
	const startedAt = now();
	const samples: AgentTransportSample[] = [];
	let report: unknown | null = null;
	const sample = async (label: string, withFrame = false) => {
		let frameSettled: boolean | undefined;
		if (withFrame && transport.awaitFrameSettled) {
			frameSettled = await transport.awaitFrameSettled(FRAME_SETTLE_BUDGET_MS);
		}
		samples.push({
			label,
			atMs: Math.round(now() - startedAt),
			...transport.snapshot(),
			...(withFrame
				? {
						frame: transport.frame(),
						...(transport.frameEvidence ? { nativeFrame: transport.frameEvidence() } : {}),
						...(frameSettled !== undefined ? { frameSettled } : {}),
					}
				: {}),
		});
	};
	for (const step of steps) {
		switch (step.op) {
			case "play":
				transport.play();
				break;
			case "pause":
				transport.pause();
				break;
			case "seek":
				transport.seek(step.sec);
				break;
			case "click":
				transport.click(step.testId, step.fraction);
				break;
			case "wait":
				await wait(step.ms);
				break;
			case "sample":
				await sample(step.label ?? `sample-${samples.length + 1}`, step.frame === true);
				break;
			case "wheel":
				transport.wheel(
					step.testId,
					step.fraction,
					step.deltaX ?? 0,
					step.deltaY ?? 0,
					step.ctrl === true,
				);
				break;
			case "probe":
				if (!probe) throw new Error("PROBE_UNAVAILABLE: the UI frame probe is not installed");
				probe.start();
				await wait(step.ms);
				probe.stop();
				report = probe.report();
				break;
		}
	}
	await sample("end");
	return { samples, probe: report };
}
