import { describe, expect, it, vi } from "vitest";
import { installWebContentsSecurityGuards, isTrustedRendererUrl } from "./security";

const config = { devServerUrl: "http://localhost:5173" };

describe("isTrustedRendererUrl", () => {
	it("accepts the exact development origin", () => {
		expect(isTrustedRendererUrl("http://localhost:5173/?windowType=editor", config)).toBe(true);
	});

	it("rejects a lookalike development host", () => {
		expect(isTrustedRendererUrl("http://localhost:5173.attacker.test/", config)).toBe(false);
	});

	it("accepts the packaged protocol entry and rejects file URLs", () => {
		expect(isTrustedRendererUrl("klippt://app/index.html?windowType=editor", config)).toBe(true);
		expect(isTrustedRendererUrl("file:///tmp/untrusted.html", config)).toBe(false);
	});
});

describe("installWebContentsSecurityGuards", () => {
	it("blocks external navigation, popups, and webviews", () => {
		const listeners = new Map<string, (...args: unknown[]) => void>();
		const contents = {
			on: vi.fn((name: string, listener: (...args: unknown[]) => void) =>
				listeners.set(name, listener),
			),
			setWindowOpenHandler: vi.fn(),
		};
		const app = {
			on: vi.fn((_name: string, listener: (...args: unknown[]) => void) => listener({}, contents)),
		};
		installWebContentsSecurityGuards(app as never, config);
		const navigationEvent = { preventDefault: vi.fn() };
		listeners.get("will-navigate")?.(navigationEvent, "https://attacker.test/");
		const webviewEvent = { preventDefault: vi.fn() };
		listeners.get("will-attach-webview")?.(webviewEvent);

		expect(navigationEvent.preventDefault).toHaveBeenCalledOnce();
		expect(webviewEvent.preventDefault).toHaveBeenCalledOnce();
		expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
	});
});
