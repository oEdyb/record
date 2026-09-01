import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { net } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toKlipptMediaUrl } from "../src/lib/localMediaUrl";

vi.mock("electron", () => ({
	net: { fetch: vi.fn() },
	protocol: { handle: vi.fn(), registerSchemesAsPrivileged: vi.fn() },
}));

import { createKlipptProtocolHandler, parseByteRange } from "./localMediaProtocol";

describe("parseByteRange", () => {
	it("accepts bounded, open-ended, and suffix byte ranges", () => {
		expect(parseByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
		expect(parseByteRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 });
		expect(parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
	});

	it("rejects multipart and out-of-bounds ranges", () => {
		expect(parseByteRange("bytes=0-1,4-5", 10)).toBe("invalid");
		expect(parseByteRange("bytes=10-", 10)).toBe("invalid");
	});
});

describe("klippt media protocol", () => {
	let tempRoot: string;
	let mediaPath: string;

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "klippt-protocol-test-"));
		mediaPath = path.join(tempRoot, "capture.mp4");
		await fs.writeFile(mediaPath, Buffer.from("0123456789"));
		mediaPath = await fs.realpath(mediaPath);
	});

	afterEach(async () => {
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	function handler(approved = true) {
		return createKlipptProtocolHandler({
			rendererDist: tempRoot,
			resourceRoot: tempRoot,
			resolveMediaPath: (candidate) => (approved && candidate === mediaPath ? candidate : null),
			allowedCorsOrigins: ["http://localhost:5173"],
		});
	}

	it("streams only an approved file and honors Chromium range requests", async () => {
		const response = await handler()(
			new Request(toKlipptMediaUrl(mediaPath), {
				headers: { Origin: "http://localhost:5173", Range: "bytes=2-5" },
			}),
		);

		expect(response.status).toBe(206);
		expect(response.headers.get("accept-ranges")).toBe("bytes");
		expect(response.headers.get("content-range")).toBe("bytes 2-5/10");
		expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(await response.text()).toBe("2345");
	});

	it("does not serve a real file unless the main-process resolver approves it", async () => {
		const response = await handler(false)(new Request(toKlipptMediaUrl(mediaPath)));
		expect(response.status).toBe(403);
	});

	it("rejects untrusted CORS preflights and non-read methods", async () => {
		const preflight = await handler()(
			new Request(toKlipptMediaUrl(mediaPath), {
				method: "OPTIONS",
				headers: { Origin: "https://attacker.example" },
			}),
		);
		const post = await handler()(new Request(toKlipptMediaUrl(mediaPath), { method: "POST" }));
		expect(preflight.status).toBe(403);
		expect(post.status).toBe(403);
	});

	it("does not let resource URLs escape the configured resource root", async () => {
		const response = await handler()(new Request("klippt://app/__resources__/..%2Foutside.txt"));
		expect(response.status).toBe(404);
		expect(net.fetch).not.toHaveBeenCalled();
	});
});
