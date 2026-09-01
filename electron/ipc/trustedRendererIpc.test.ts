import { describe, expect, it, vi } from "vitest";
import {
	createTrustedRendererIpcMain,
	isTrustedDisplayMediaRequest,
	isTrustedIpcSender,
	isTrustedPermissionCheck,
	isTrustedPermissionRequest,
} from "./trustedRendererIpc";

const config = { devServerUrl: "http://localhost:5173" };

function eventFor(url: string, mainFrame = true) {
	const frame = { parent: mainFrame ? null : {}, url };
	return {
		sender: { mainFrame: frame },
		senderFrame: frame,
	};
}

describe("trusted renderer requests", () => {
	it("accepts packaged and exact development main frames", () => {
		expect(isTrustedIpcSender(eventFor("klippt://app/index.html") as never, config)).toBe(true);
		expect(
			isTrustedIpcSender(eventFor("http://localhost:5173/?windowType=editor") as never, config),
		).toBe(true);
	});

	it("rejects untrusted origins and child frames", () => {
		expect(isTrustedIpcSender(eventFor("https://attacker.test/") as never, config)).toBe(false);
		expect(isTrustedIpcSender(eventFor("file:///app/dist/index.html") as never, config)).toBe(
			false,
		);
		expect(isTrustedIpcSender(eventFor("klippt://app/index.html", false) as never, config)).toBe(
			false,
		);
	});

	it("rejects child-frame permission and display-capture requests", () => {
		const contents = { getURL: () => "klippt://app/index.html" };
		expect(
			isTrustedPermissionCheck(
				contents,
				"klippt://app",
				{ isMainFrame: false, requestingUrl: "klippt://app/index.html" },
				config,
			),
		).toBe(false);
		expect(
			isTrustedPermissionRequest(
				contents,
				{ isMainFrame: false, requestingUrl: "klippt://app/index.html" },
				config,
			),
		).toBe(false);
		expect(
			isTrustedDisplayMediaRequest(
				{
					frame: { parent: {}, url: "klippt://app/index.html" } as never,
					securityOrigin: "klippt://app",
				},
				config,
			),
		).toBe(false);
	});

	it("rejects permission checks when the owning web contents is untrusted", () => {
		expect(
			isTrustedPermissionCheck(
				{ getURL: () => "https://attacker.test/" },
				"klippt://app",
				{ isMainFrame: true, requestingUrl: "klippt://app/index.html" },
				config,
			),
		).toBe(false);
	});

	it("accepts trusted main-frame permissions and display capture", () => {
		const contents = { getURL: () => "klippt://app/index.html" };
		expect(
			isTrustedPermissionCheck(
				contents,
				"klippt://app",
				{ isMainFrame: true, requestingUrl: "klippt://app/index.html" },
				config,
			),
		).toBe(true);
		expect(
			isTrustedPermissionRequest(
				contents,
				{ isMainFrame: true, requestingUrl: "klippt://app/index.html" },
				config,
			),
		).toBe(true);
		expect(
			isTrustedDisplayMediaRequest(
				{
					frame: { parent: null, url: "klippt://app/index.html" } as never,
					securityOrigin: "klippt://app",
				},
				config,
			),
		).toBe(true);
	});
});

describe("createTrustedRendererIpcMain", () => {
	it("does not call a handler for an untrusted sender", async () => {
		let registered: ((event: unknown) => unknown) | undefined;
		const target = {
			handle: vi.fn((_channel, listener) => {
				registered = listener;
			}),
			on: vi.fn(),
			once: vi.fn(),
			removeListener: vi.fn(),
			removeAllListeners: vi.fn(),
			removeHandler: vi.fn(),
		};
		const listener = vi.fn();
		createTrustedRendererIpcMain(target as never, config).handle("secure", listener);

		await expect(() => registered?.(eventFor("https://attacker.test/"))).toThrow(
			"Untrusted IPC sender.",
		);
		expect(listener).not.toHaveBeenCalled();
	});

	it("drops untrusted event messages", () => {
		let registered: ((event: unknown) => unknown) | undefined;
		const target = {
			handle: vi.fn(),
			on: vi.fn((_channel, listener) => {
				registered = listener;
			}),
			once: vi.fn(),
			removeListener: vi.fn(),
			removeAllListeners: vi.fn(),
			removeHandler: vi.fn(),
		};
		const listener = vi.fn();
		createTrustedRendererIpcMain(target as never, config).on("secure-event", listener);

		registered?.(eventFor("https://attacker.test/"));
		expect(listener).not.toHaveBeenCalled();

		registered?.(eventFor("klippt://app/index.html"));
		expect(listener).toHaveBeenCalledOnce();
	});

	it("does not let an untrusted sender consume a one-shot listener", () => {
		let registered: ((event: unknown) => unknown) | undefined;
		const target = {
			handle: vi.fn(),
			on: vi.fn((_channel, listener) => {
				registered = listener;
			}),
			once: vi.fn(),
			removeListener: vi.fn(),
			removeAllListeners: vi.fn(),
			removeHandler: vi.fn(),
		};
		const listener = vi.fn();
		createTrustedRendererIpcMain(target as never, config).once("secure-once", listener);

		registered?.(eventFor("https://attacker.test/"));
		expect(listener).not.toHaveBeenCalled();
		expect(target.removeListener).not.toHaveBeenCalled();

		registered?.(eventFor("klippt://app/index.html"));
		expect(listener).toHaveBeenCalledOnce();
		expect(target.removeListener).toHaveBeenCalledOnce();
	});
});
