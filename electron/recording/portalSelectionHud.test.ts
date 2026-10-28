import { describe, expect, it, vi } from "vitest";
import {
	cancelPortalHudSelection,
	supersedePortalHudSelection,
	withHiddenPortalHud,
} from "./portalSelectionHud";

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
	const promise = new Promise<T>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

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

it("restores compositor placement before returning the selected source", async () => {
	const window = hudWindow();
	const order: string[] = [];
	const restore = vi.fn(async () => {
		order.push("placed");
	});
	const pending = withHiddenPortalHud(
		() => window,
		async () => {
			order.push("selected");
			return "grant";
		},
		async () => restore,
	);
	await expect(pending).resolves.toBe("grant");
	expect(order).toEqual(["selected", "placed"]);
	expect(window.showInactive).toHaveBeenCalledOnce();
});

it("cancels before preparation when placement lookup is still pending", async () => {
	const window = hudWindow();
	const lookup = deferred<undefined>();
	const select = vi.fn(async () => "grant");
	const pending = withHiddenPortalHud(
		() => window,
		select,
		() => lookup.promise,
	);
	const rejected = expect(pending).rejects.toThrow("Source selection cancelled");
	cancelPortalHudSelection(window);
	lookup.resolve(undefined);
	await rejected;
	expect(select).not.toHaveBeenCalled();
	expect(window.hide).not.toHaveBeenCalled();
	expect(window.showInactive).not.toHaveBeenCalled();
});

it("does not restore an old picker over a replacement recording", async () => {
	const window = hudWindow();
	const grant = deferred<string>();
	const restore = vi.fn(async () => undefined);
	const pending = withHiddenPortalHud(
		() => window,
		() => grant.promise,
		async () => restore,
	);
	const rejected = expect(pending).rejects.toThrow("Source selection cancelled");
	await vi.waitFor(() => expect(window.hide).toHaveBeenCalledOnce());
	supersedePortalHudSelection(window);
	grant.resolve("old grant");
	await rejected;
	expect(window.showInactive).not.toHaveBeenCalled();
	expect(restore).not.toHaveBeenCalled();
});

it("exposes in-flight placement and revokes later placement mutations", async () => {
	const window = hudWindow();
	const entered = deferred<void>();
	const finish = deferred<void>();
	const move = vi.fn();
	const pending = withHiddenPortalHud(
		() => window,
		async () => "grant",
		async () => async (mayRestore) => {
			entered.resolve();
			await finish.promise;
			if (mayRestore()) move();
		},
	);
	const rejected = expect(pending).rejects.toThrow("Source selection cancelled");
	await entered.promise;
	const restoring = supersedePortalHudSelection(window);
	expect(restoring).toBeInstanceOf(Promise);
	const successor = withHiddenPortalHud(
		() => window,
		async () => "replacement",
	);
	const successorRejected = expect(successor).rejects.toThrow("Source selection cancelled");
	expect(supersedePortalHudSelection(window)).toBe(restoring);
	expect(supersedePortalHudSelection(window)).toBe(restoring);
	finish.resolve();
	await restoring;
	await rejected;
	await successorRejected;
	expect(move).not.toHaveBeenCalled();
});
