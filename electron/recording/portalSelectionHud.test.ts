import { describe, expect, it, vi } from "vitest";
import { withHiddenPortalHud } from "./portalSelectionHud";

function hudWindow() {
	return {
		isDestroyed: vi.fn(() => false),
		isVisible: vi.fn(() => true),
		hide: vi.fn(),
		showInactive: vi.fn(),
	};
}

describe("portal selection HUD visibility", () => {
	it("hides before awaiting the picker and restores without focus after the grant", async () => {
		const window = hudWindow();
		let grant: ((source: string) => void) | undefined;
		const pending = withHiddenPortalHud(
			() => window,
			() => {
				expect(window.hide).toHaveBeenCalledOnce();
				return new Promise<string>((resolve) => {
					grant = resolve;
				});
			},
		);
		expect(window.showInactive).not.toHaveBeenCalled();
		grant?.("portal source");
		await expect(pending).resolves.toBe("portal source");
		expect(window.showInactive).toHaveBeenCalledOnce();
	});

	it("restores after the picker returns a cancellation", async () => {
		const window = hudWindow();
		const cancelled = { success: false, error: "Source selection cancelled." };
		await expect(
			withHiddenPortalHud(
				() => window,
				async () => cancelled,
			),
		).resolves.toBe(cancelled);
		expect(window.hide).toHaveBeenCalledOnce();
		expect(window.showInactive).toHaveBeenCalledOnce();
	});

	it("restores after source selection throws", async () => {
		const window = hudWindow();
		await expect(
			withHiddenPortalHud(
				() => window,
				async () => {
					throw new Error("Portal disconnected");
				},
			),
		).rejects.toThrow("Portal disconnected");
		expect(window.hide).toHaveBeenCalledOnce();
		expect(window.showInactive).toHaveBeenCalledOnce();
	});

	it("does not hide or restore a HUD that was already hidden", async () => {
		const window = hudWindow();
		window.isVisible.mockReturnValue(false);
		await expect(
			withHiddenPortalHud(
				() => window,
				async () => "selected",
			),
		).resolves.toBe("selected");
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.showInactive).not.toHaveBeenCalled();
	});

	it("does not touch an already destroyed HUD", async () => {
		const window = hudWindow();
		window.isDestroyed.mockReturnValue(true);
		await withHiddenPortalHud(
			() => window,
			async () => undefined,
		);
		expect(window.hide).not.toHaveBeenCalled();
		expect(window.showInactive).not.toHaveBeenCalled();
	});

	it("does not restore a HUD destroyed during selection", async () => {
		const window = hudWindow();
		await withHiddenPortalHud(
			() => window,
			async () => {
				window.isDestroyed.mockReturnValue(true);
			},
		);
		expect(window.hide).toHaveBeenCalledOnce();
		expect(window.showInactive).not.toHaveBeenCalled();
	});

	it("does not show a replaced HUD or its replacement", async () => {
		const original = hudWindow();
		const replacement = hudWindow();
		let current = original;
		await withHiddenPortalHud(
			() => current,
			async () => {
				current = replacement;
			},
		);
		expect(original.hide).toHaveBeenCalledOnce();
		expect(original.showInactive).not.toHaveBeenCalled();
		expect(replacement.showInactive).not.toHaveBeenCalled();
	});

	it("allows selection when there is no HUD", async () => {
		await expect(
			withHiddenPortalHud(
				() => null,
				async () => "selected",
			),
		).resolves.toBe("selected");
	});
});
