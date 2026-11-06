import type { NativeLinuxSourceSelectionResult } from "../../src/lib/nativeLinuxRecording";
import type { NativeMacRecordingFailure } from "../../src/lib/nativeMacRecording";
import type {
	NativeMacCaptureHelper,
	NativeMacRecordingStopResult,
} from "./nativeMacRecordingService";

type Phase =
	| {
			kind:
				| "prepared"
				| "recording"
				| "paused"
				| "cancelled"
				| "preparing-resume"
				| "configuring-resume"
				| "resuming";
	  }
	| { kind: "failed"; failure: NativeMacRecordingFailure };
type Take =
	| { kind: "idle" }
	| {
			kind: "starting";
			intent: "prepare" | "record";
			metadata: "open" | "closed";
	  }
	| {
			kind: "starting-helper";
			intent: "prepare" | "record";
			helper: NativeMacCaptureHelper;
			metadata: "open" | "closed";
	  }
	| { kind: "owned"; helper: NativeMacCaptureHelper; phase: Phase; metadata: "open" | "closed" };
type Selection = {
	operation: Promise<NativeLinuxSourceSelectionResult>;
	cancellation: AbortController;
};
type State =
	| Take
	| { kind: "selecting"; take: Take; selection: Selection }
	| {
			kind: "stopping";
			take: Take;
			operation: Promise<NativeMacRecordingStopResult>;
			selection?: Selection;
			collected?: NativeMacRecordingStopResult;
	  }
	| { kind: "awaiting-hud"; result: NativeMacRecordingStopResult };
type Event =
	| { type: "start"; prepare: boolean }
	| { type: "helper"; helper: NativeMacCaptureHelper }
	| {
			type:
				| "prepared"
				| "arm"
				| "ready"
				| "paused"
				| "resumed"
				| "cancel-prepare"
				| "reset"
				| "seal"
				| "collect"
				| "prepare-resume"
				| "configure-resume"
				| "resume-requested";
	  }
	| { type: "fatal"; failure: NativeMacRecordingFailure }
	| { type: "select"; selection: Selection }
	| { type: "selected"; operation: Promise<NativeLinuxSourceSelectionResult> }
	| { type: "stop"; operation: Promise<NativeMacRecordingStopResult> }
	| { type: "stopped"; operation: Promise<NativeMacRecordingStopResult> }
	| { type: "publish"; result: NativeMacRecordingStopResult };

export class NativeRecordingLifecycle {
	private state: State = { kind: "idle" };
	getSnapshot() {
		return this.state;
	}
	private get take(): Take {
		const s = this.state;
		return s.kind === "stopping" || s.kind === "selecting"
			? s.take
			: s.kind === "awaiting-hud"
				? { kind: "idle" }
				: s;
	}
	get helper() {
		const take = this.take;
		return take.kind === "idle" || take.kind === "starting" ? null : take.helper;
	}
	get preparing() {
		const take = this.take;
		return (
			(take.kind === "starting" || take.kind === "starting-helper") && take.intent === "prepare"
		);
	}
	get prepared() {
		const take = this.take;
		return take.kind === "owned" && take.phase.kind === "prepared";
	}
	get paused() {
		const take = this.take;
		return (
			take.kind === "owned" &&
			["paused", "failed", "preparing-resume", "configuring-resume", "resuming"].includes(
				take.phase.kind,
			)
		);
	}
	get resumeDispatched() {
		const take = this.take;
		return (
			take.kind === "owned" && (take.phase.kind === "resuming" || take.phase.kind === "recording")
		);
	}
	get configuring() {
		const take = this.take;
		return (
			take.kind === "owned" &&
			(take.phase.kind === "preparing-resume" || take.phase.kind === "configuring-resume")
		);
	}

	get failure() {
		const take = this.take;
		return take.kind === "owned" && take.phase.kind === "failed" ? take.phase.failure : null;
	}
	get acceptsOriginals() {
		const take = this.take;
		return take.kind !== "idle" && take.metadata === "open";
	}
	get stop() {
		return this.state.kind === "stopping" ? this.state.operation : null;
	}
	get appStopped() {
		return this.state.kind === "awaiting-hud"
			? this.state.result
			: this.state.kind === "stopping"
				? (this.state.collected ?? null)
				: null;
	}
	get selection() {
		const s = this.state;
		return s.kind === "selecting"
			? s.selection
			: s.kind === "stopping"
				? (s.selection ?? null)
				: null;
	}
	transition(event: Event): boolean {
		const s = this.state;
		const take = this.take;
		let next: State;
		const replace = (value: Take): State =>
			s.kind === "stopping" || s.kind === "selecting" ? { ...s, take: value } : value;
		const reject = () => {
			console.warn("[native-recording-lifecycle] Illegal transition", {
				state: s.kind,
				phase: take.kind === "owned" ? take.phase.kind : take.kind,
				event: event.type,
			});
			return false;
		};
		switch (event.type) {
			case "start":
				if (
					s.kind === "stopping" ||
					s.kind === "selecting" ||
					(take.kind !== "idle" && !(take.kind === "owned" && !take.helper.isRunning()))
				)
					return reject();
				next = {
					kind: "starting",
					intent: event.prepare ? "prepare" : "record",
					metadata: "open",
				};
				break;
			case "helper":
				if (take.kind !== "starting") return reject();
				next = replace({ ...take, kind: "starting-helper", helper: event.helper });
				break;
			case "prepared":
			case "ready":
				if (take.kind !== "starting-helper") return reject();
				next = replace({
					kind: "owned",
					helper: take.helper,
					metadata: take.metadata,
					phase: { kind: event.type === "prepared" ? "prepared" : "recording" },
				});
				break;
			case "arm":
				if (take.kind !== "owned" || take.phase.kind !== "prepared") return reject();
				next = replace({
					kind: "starting-helper",
					intent: "record",
					helper: take.helper,
					metadata: take.metadata,
				});
				break;
			case "prepare-resume":
			case "configure-resume":
			case "resume-requested":
				if (
					take.kind !== "owned" ||
					!(
						take.phase.kind === "paused" ||
						(event.type === "resume-requested" && take.phase.kind === "configuring-resume")
					)
				)
					return reject();
				next = replace({
					...take,
					phase: {
						kind:
							event.type === "prepare-resume"
								? "preparing-resume"
								: event.type === "configure-resume"
									? "configuring-resume"
									: "resuming",
					},
				});
				break;

			case "paused":
			case "resumed":
				if (
					take.kind !== "owned" ||
					![
						"recording",
						"paused",
						"failed",
						"preparing-resume",
						"configuring-resume",
						"resuming",
					].includes(take.phase.kind)
				)
					return reject();
				next = replace(
					take.phase.kind === "failed"
						? take
						: { ...take, phase: { kind: event.type === "paused" ? "paused" : "recording" } },
				);
				break;
			case "fatal":
				if (take.kind === "idle" || take.kind === "starting") return reject();
				next = replace({
					kind: "owned",
					helper: take.helper,
					metadata: take.metadata,
					phase: { kind: "failed", failure: event.failure },
				});
				break;
			case "cancel-prepare":
				if (take.kind === "starting") next = replace({ kind: "idle" });
				else if (take.kind === "starting-helper")
					next = replace({
						kind: "owned",
						helper: take.helper,
						metadata: take.metadata,
						phase: { kind: "cancelled" },
					});
				else if (take.kind === "owned" && take.phase.kind === "prepared")
					next = replace({ ...take, phase: { kind: "cancelled" } });
				else return reject();
				break;
			case "seal":
				if (take.kind === "idle") return reject();
				next = replace({ ...take, metadata: "closed" });
				break;
			case "reset":
				next = replace({ kind: "idle" });
				break;
			case "stop":
				if (s.kind === "stopping") return reject();
				next = {
					kind: "stopping",
					take,
					operation: event.operation,
					...(s.kind === "selecting" ? { selection: s.selection } : {}),
					...(s.kind === "awaiting-hud" ? { collected: s.result } : {}),
				};
				break;
			case "stopped":
				if (s.kind !== "stopping" || s.operation !== event.operation) return reject();
				next = s.take;
				break;
			case "publish":
				if (s.kind !== "idle" && s.kind !== "awaiting-hud") return reject();
				next = { kind: "awaiting-hud", result: event.result };
				break;
			case "collect":
				if (s.kind === "awaiting-hud") next = { kind: "idle" };
				else if (s.kind === "stopping" && s.collected) {
					const { collected: _, ...rest } = s;
					next = rest;
				} else return reject();
				break;
			case "select":
				if (s.kind === "selecting" || s.kind === "stopping" || s.kind === "awaiting-hud")
					return reject();
				next = { kind: "selecting", take, selection: event.selection };
				break;
			case "selected":
				if (s.kind === "selecting" && s.selection.operation === event.operation) next = s.take;
				else if (s.kind === "stopping" && s.selection?.operation === event.operation) {
					const { selection: _, ...rest } = s;
					next = rest;
				} else return reject();
				break;
		}
		this.state = next;
		return true;
	}
}
