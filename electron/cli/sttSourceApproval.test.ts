import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCliSttSourceResolver } from "./sttSourceApproval";

describe("createCliSttSourceResolver", () => {
	it("allows only a path approved by the loaded CLI project", async () => {
		const recordingsDir = path.join(path.sep, "user", "recordings");
		const nativePath = path.join(recordingsDir, "recording.mp4");
		const importedPath = path.join(path.sep, "project", "media.mp4");
		const approve = vi.fn((candidate: string) =>
			candidate === nativePath || candidate === importedPath ? candidate : null,
		);
		const resolve = createCliSttSourceResolver(recordingsDir, approve);

		await expect(resolve(nativePath)).resolves.toEqual({
			sourcePath: nativePath,
			forceNative: true,
		});
		await expect(resolve(importedPath)).resolves.toEqual({
			sourcePath: importedPath,
			forceNative: false,
		});
		await expect(resolve(path.join(path.sep, "private", "secret.mp4"))).resolves.toBeNull();
	});
});
