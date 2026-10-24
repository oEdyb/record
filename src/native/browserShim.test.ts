// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentSchema } from "../lib/ai-edition/schema";
import { installBrowserShims } from "./browserShim";
import { nativeBridgeClient } from "./client";

describe("browser shim latest project", () => {
	beforeEach(() => {
		window.localStorage.clear();
		window.history.replaceState({}, "", "/?browser");
		installBrowserShims();
	});

	afterEach(() => {
		delete (window as unknown as { electronAPI?: unknown }).electronAPI;
		window.localStorage.clear();
		window.history.replaceState({}, "", "/");
	});

	it("returns a successful empty result for an empty library", async () => {
		await expect(nativeBridgeClient.aiEdition.getLatest()).resolves.toEqual({ success: true });
	});

	it("returns the newest project without changing library listing", async () => {
		const older = await nativeBridgeClient.aiEdition.create("Older");
		const newer = await nativeBridgeClient.aiEdition.create("Newer");
		const olderId = documentSchema.parse(older.document).project.id;
		const newerId = documentSchema.parse(newer.document).project.id;

		await expect(nativeBridgeClient.aiEdition.getLatest()).resolves.toMatchObject({
			success: true,
			document: newer.document,
		});
		await expect(nativeBridgeClient.aiEdition.listProjects()).resolves.toMatchObject([
			{ id: newerId },
			{ id: olderId },
		]);
	});
});
