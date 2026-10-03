// @vitest-environment node
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { flushCliOutput } from "./cliOutputFlush";

describe("CLI output flushing", () => {
	it("waits for a large JSON reply and queued diagnostics before exit", async () => {
		const chunks: Buffer[] = [];
		const release: (() => void)[] = [];
		const stdout = new Writable({
			write(chunk, _encoding, callback) {
				chunks.push(Buffer.from(chunk));
				release.push(callback);
			},
		});
		let releaseDiagnostic: (() => void) | undefined;
		const stderr = new Writable({
			write(_chunk, _encoding, callback) {
				releaseDiagnostic = callback;
			},
		});
		const reply = `${JSON.stringify({ status: "completed", frame: "a".repeat(200_000) })}\n`;
		stdout.write(reply);
		stderr.write("diagnostic\n");
		let finished = false;
		const flushing = flushCliOutput(stdout, stderr).then(() => {
			finished = true;
		});
		await Promise.resolve();
		expect(finished).toBe(false);
		release.shift()?.();
		release.shift()?.();
		await Promise.resolve();
		expect(finished).toBe(false);
		releaseDiagnostic?.();
		releaseDiagnostic?.();
		await flushing;
		expect(finished).toBe(true);
		expect(Buffer.concat(chunks).toString()).toBe(reply);
		stdout.destroy();
		stderr.destroy();
	});

	it("finishes when a consumer closes its pipe", async () => {
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback();
			},
		});
		stdout.destroy();
		await expect(flushCliOutput(stdout)).resolves.toBeUndefined();
	});

	it("handles an EPIPE during the queued write", async () => {
		const stdout = new Writable({
			write(_chunk, _encoding, callback) {
				callback(Object.assign(new Error("consumer closed"), { code: "EPIPE" }));
			},
		});
		stdout.on("error", () => {});
		await expect(flushCliOutput(stdout)).resolves.toBeUndefined();
	});
});
