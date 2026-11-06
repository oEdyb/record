import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecorderHandle } from "@/hooks/recorderHandle";
import { NativeMacWebcamClipLedger } from "./webcamSidecars";

const evidenceRoot = path.join(os.homedir(), ".cache", "klippt-work", "camera-close-boundaries");
afterEach(() => vi.restoreAllMocks());

function deferred() {
	let resolve: () => void = () => undefined;
	let reject: (error: Error) => void = () => undefined;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

async function fixture(name: string) {
	await fs.mkdir(evidenceRoot, { recursive: true });
	const root = await fs.mkdtemp(path.join(evidenceRoot, `camera-${name}-`));
	const fileName = `${name}.mp4`;
	const file = path.join(root, fileName);
	await fs.writeFile(file, "exact-camera-original");
	const liveFile = await fs.open(file, "a");
	const recorder: RecorderHandle = {
		fileName,
		recorder: { state: "inactive" } as MediaRecorder,
		recordedBlobPromise: Promise.resolve(new Blob()),
		isStreaming: () => true,
		release: vi.fn(async () => liveFile.close()),
		discard: vi.fn(async () => {
			await liveFile.close();
			await fs.rename(file, `${file}.discarded`);
		}),
	};
	return {
		file,
		recorder,
		liveFile,
		clip: { index: 0, durationMs: 1000, screenVideoPath: path.join(root, "screen.mp4") },
	};
}

async function evidence(name: string, value: unknown) {
	await fs.writeFile(
		path.join(evidenceRoot, `${name}.json`),
		`${JSON.stringify(value, null, 2)}\n`,
	);
	console.log(name, JSON.stringify(value));
}

describe("row10 independent camera ownership follow-up", () => {
	it("C1: repeating saved acknowledgement after a failed attached close must retain close ownership", async () => {
		const f = await fixture("C1");
		const ledger = new NativeMacWebcamClipLedger();
		const closing = deferred();
		vi.mocked(f.recorder.release).mockImplementationOnce(() => closing.promise);
		ledger.queue({ recorder: f.recorder, clip: f.clip, webcamOffsetMs: 0 });
		const { webcams } = await ledger.collectKept(new Set([0]));
		const released = ledger.releaseUnclaimed().then(
			() => "fulfilled",
			() => "rejected",
		);
		await vi.waitFor(() => expect(f.recorder.release).toHaveBeenCalledOnce());
		ledger.markSaved(webcams);
		closing.reject(new Error("injected close failure"));
		expect(await released).toBe("rejected");
		const clearAfterFailure = ledger.clear();
		ledger.markSaved(webcams);
		await ledger.releaseUnclaimed();
		await f.liveFile.write("; writer still open").catch(() => undefined);
		const clearAfterRepeatedAck = ledger.clear();
		const releases = vi.mocked(f.recorder.release).mock.calls.length;
		await evidence("C1-repeated-ack-after-close-failure", {
			clearAfterFailure,
			clearAfterRepeatedAck,
			releases,
			bytes: await fs.readFile(f.file, "utf8"),
		});
		await f.liveFile.close().catch(() => undefined);
		expect(clearAfterFailure).toBe(false);
		expect(
			releases,
			"markSaved must not convert attached-unclosed to attached and suppress retry",
		).toBe(2);
	});

	it("C2: a later take's discard keeps earlier camera bytes when its saved acknowledgement arrives during release", async () => {
		const f = await fixture("C2-old");
		const fresh = await fixture("C2-new");
		const ledger = new NativeMacWebcamClipLedger();
		const closing = deferred();
		vi.mocked(f.recorder.release).mockImplementationOnce(() => closing.promise);
		ledger.queue({ recorder: f.recorder, clip: f.clip, webcamOffsetMs: 0 });
		const { webcams } = await ledger.collectKept(new Set([0]));
		const released = ledger.releaseUnclaimed();
		await vi.waitFor(() => expect(f.recorder.release).toHaveBeenCalledOnce());
		const beganDuringRelease = ledger.beginTake();
		ledger.markSaved(webcams);
		closing.resolve();
		await released;
		if (beganDuringRelease) {
			ledger.queue({ recorder: fresh.recorder, clip: fresh.clip, webcamOffsetMs: 0 });
			await ledger.discardUnclaimed();
		}
		const cleared = ledger.clear();
		const bytes = await fs.readFile(f.file, "utf8");
		await evidence("C2-late-attachment-take-boundary", {
			beganDuringRelease,
			cleared,
			oldDiscards: vi.mocked(f.recorder.discard).mock.calls.length,
			freshDiscards: vi.mocked(fresh.recorder.discard).mock.calls.length,
			bytes,
		});
		await f.liveFile.close().catch(() => undefined);
		await fresh.liveFile.close().catch(() => undefined);
		expect(vi.mocked(f.recorder.discard)).not.toHaveBeenCalled();
		expect(bytes).toBe("exact-camera-original");
	});

	it("C3: another failed old close must not prevent discard of the current take", async () => {
		const old = await fixture("C3-old");
		const fresh = await fixture("C3-new");
		const ledger = new NativeMacWebcamClipLedger();
		vi.mocked(old.recorder.release).mockRejectedValue(new Error("old close still failing"));
		ledger.queue({ recorder: old.recorder, clip: old.clip, webcamOffsetMs: 0 });
		await ledger.collectKept(new Set([0]));
		await expect(ledger.releaseUnclaimed()).rejects.toThrow("old close still failing");
		expect(ledger.beginTake()).toBe(true);
		ledger.queue({ recorder: fresh.recorder, clip: fresh.clip, webcamOffsetMs: 0 });
		await ledger.collectKept(new Set([0]));
		const outcome = await ledger.discardUnclaimed().then(
			() => "fulfilled",
			() => "rejected",
		);
		const clear = ledger.clear();
		await evidence("C3-old-failure-blocks-new-discard", {
			outcome,
			clear,
			oldReleases: vi.mocked(old.recorder.release).mock.calls.length,
			oldDiscards: vi.mocked(old.recorder.discard).mock.calls.length,
			newDiscards: vi.mocked(fresh.recorder.discard).mock.calls.length,
			oldBytes: await fs.readFile(old.file, "utf8"),
			newFileExists: await fs.stat(fresh.file).then(
				() => true,
				() => false,
			),
		});
		await old.liveFile.close().catch(() => undefined);
		await fresh.liveFile.close().catch(() => undefined);
		expect(old.recorder.discard).not.toHaveBeenCalled();
		expect(clear).toBe(false);
		expect(
			fresh.recorder.discard,
			"current take cleanup must not be skipped by an unrelated old failed close",
		).toHaveBeenCalledOnce();
	});

	it("C4: a late saved camera remains protected when release fails and later cleanup retries", async () => {
		const f = await fixture("C4");
		const ledger = new NativeMacWebcamClipLedger();
		const closing = deferred();
		vi.mocked(f.recorder.release).mockImplementationOnce(() => closing.promise);
		ledger.queue({ recorder: f.recorder, clip: f.clip, webcamOffsetMs: 0 });
		const { webcams } = await ledger.collectKept(new Set([0]));
		const released = ledger.releaseUnclaimed().then(
			() => "fulfilled",
			() => "rejected",
		);
		await vi.waitFor(() => expect(f.recorder.release).toHaveBeenCalledOnce());
		ledger.markSaved(webcams);
		closing.reject(new Error("first close fails"));
		expect(await released).toBe("rejected");
		expect(ledger.clear()).toBe(false);
		await ledger.discardUnclaimed();
		expect(f.recorder.discard).not.toHaveBeenCalled();
		expect(f.recorder.release).toHaveBeenCalledTimes(2);
		expect(await fs.readFile(f.file, "utf8")).toBe("exact-camera-original");
		expect(ledger.clear()).toBe(true);
	});

	it("C5: multiple retained close failures still allow current discard and report failure", async () => {
		const first = await fixture("C5-first");
		const second = await fixture("C5-second");
		const fresh = await fixture("C5-new");
		const ledger = new NativeMacWebcamClipLedger();
		vi.mocked(first.recorder.release).mockRejectedValue(new Error("first close failed"));
		vi.mocked(second.recorder.release).mockRejectedValue(new Error("second close failed"));
		ledger.queue({ recorder: first.recorder, clip: first.clip, webcamOffsetMs: 0 });
		ledger.queue({
			recorder: second.recorder,
			clip: { ...second.clip, index: 1 },
			webcamOffsetMs: 0,
		});
		await ledger.collectKept(new Set([0, 1]));
		await expect(ledger.releaseUnclaimed()).rejects.toThrow();
		expect(ledger.beginTake()).toBe(true);
		ledger.queue({ recorder: fresh.recorder, clip: fresh.clip, webcamOffsetMs: 0 });
		await expect(ledger.discardUnclaimed()).rejects.toThrow();
		const observed = {
			clear: ledger.clear(),
			firstDiscards: vi.mocked(first.recorder.discard).mock.calls.length,
			secondDiscards: vi.mocked(second.recorder.discard).mock.calls.length,
			freshDiscards: vi.mocked(fresh.recorder.discard).mock.calls.length,
		};
		await evidence("C5-multiple-retained-close-failures", observed);
		await first.liveFile.close();
		await second.liveFile.close();
		expect(observed).toEqual({
			clear: false,
			firstDiscards: 0,
			secondDiscards: 0,
			freshDiscards: 1,
		});
	});
});
