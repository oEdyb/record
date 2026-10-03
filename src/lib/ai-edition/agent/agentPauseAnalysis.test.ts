import { beforeEach, describe, expect, it } from "vitest";
import { createEmptyDocument } from "../schema";
import { DEFAULT_PAUSE_POLICY } from "../timeline/pause-analysis";
import { requestAgentPauseAnalysis, resetAgentPauseAnalysis } from "./agentPauseAnalysis";

const document = createEmptyDocument({
	title: "T",
	projectId: "p",
	createdAt: "2026-09-17T00:00:00.000Z",
});

function deferred() {
	let resolve!: (value: Parameters<typeof settle>[0]) => void;
	let reject!: (error: Error) => void;
	const settle = (value: {
		suggestions: [];
		analyzedClipCount: number;
		missingTranscript: boolean;
		missingMicrophone: boolean;
		missingSpeechActivity: boolean;
		usedMixedAudio: boolean;
	}) => value;
	const promise = new Promise<ReturnType<typeof settle>>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const emptyResult = {
	suggestions: [] as [],
	analyzedClipCount: 2,
	missingTranscript: false,
	missingMicrophone: false,
	missingSpeechActivity: false,
	usedMixedAudio: false,
};

beforeEach(() => resetAgentPauseAnalysis());

describe("agent pause analysis polling", () => {
	it("starts one run per revision and policy and reports when it is ready", async () => {
		const gate = deferred();
		let calls = 0;
		const analyze = () => {
			calls += 1;
			return gate.promise;
		};
		const first = requestAgentPauseAnalysis(document, "1", DEFAULT_PAUSE_POLICY, analyze);
		expect(first.status).toBe("analyzing");
		expect(requestAgentPauseAnalysis(document, "1", DEFAULT_PAUSE_POLICY, analyze).status).toBe(
			"analyzing",
		);
		expect(calls).toBe(1);
		gate.resolve(emptyResult);
		await gate.promise;
		const ready = requestAgentPauseAnalysis(document, "1", DEFAULT_PAUSE_POLICY, analyze);
		expect(ready).toMatchObject({ status: "ready", analyzedClipCount: 2 });
		expect(calls).toBe(1);
	});

	it("restarts for a new revision or policy and reports failures", async () => {
		const failing = deferred();
		let calls = 0;
		const analyze = () => {
			calls += 1;
			return failing.promise;
		};
		requestAgentPauseAnalysis(document, "1", DEFAULT_PAUSE_POLICY, analyze);
		requestAgentPauseAnalysis(document, "2", DEFAULT_PAUSE_POLICY, analyze);
		expect(calls).toBe(2);
		failing.reject(new Error("no microphone"));
		await failing.promise.catch(() => undefined);
		expect(requestAgentPauseAnalysis(document, "2", DEFAULT_PAUSE_POLICY, analyze)).toMatchObject({
			status: "error",
			error: "no microphone",
		});
		requestAgentPauseAnalysis(
			document,
			"2",
			{ ...DEFAULT_PAUSE_POLICY, mode: "audio-level" },
			analyze,
		);
		expect(calls).toBe(3);
	});
});
