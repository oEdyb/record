import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NiriCameraPreviewGuard } from "./niriCameraPreviewGuard";

function setup() {
	const unsafe = vi.fn();
	const close = vi.fn();
	let changed: (event: unknown) => void = () => undefined;
	let failed: () => void = () => undefined;
	const values = {
		casts: [
			{
				stream_id: 1,
				pw_node_id: 91,
				kind: "PipeWire",
				target: { Output: { name: "DP-1" } },
				is_dynamic_target: false,
			},
		],
		outputs: {
			"DP-1": { name: "DP-1", logical: { x: 0, y: 0, width: 1280, height: 800 } },
			"DP-2": { name: "DP-2", logical: { x: 1280, y: 0, width: 1280, height: 800 } },
		},
		workspaces: [{ id: 7, output: "DP-2", is_active: true }],
		windows: [
			{
				id: 8,
				pid: 42,
				app_id: "co.dyberg.klippt",
				title: "Klippt Camera",
				is_floating: true,
				workspace_id: 7,
				layout: {
					tile_pos_in_workspace_view: [24, 24],
					window_offset_in_tile: [0, 0],
					window_size: [312, 186],
				},
			},
		],
	};
	const query = vi.fn(async (command: keyof typeof values): Promise<unknown> => values[command]);
	const watch = vi.fn((onChanged: (event: unknown) => void, onFailed: () => void) => {
		changed = onChanged;
		failed = onFailed;
		return { ready: Promise.resolve(), close };
	});
	const guard = new NiriCameraPreviewGuard(unsafe, { query, watch }, 42);
	return {
		guard,
		unsafe,
		close,
		query,
		watch,
		values,
		event: (event: unknown) => changed(event),
		fail: () => failed(),
	};
}

beforeEach(() => vi.stubEnv("NIRI_SOCKET", "/tmp/private-niri-test.sock"));
afterEach(() => vi.unstubAllEnvs());

describe("Niri preview capture eligibility lifetime", () => {
	it("retains an already visible preview on the uncaptured monitor", async () => {
		const { guard, unsafe, query } = setup();
		await expect(guard.begin(91)).resolves.toBe(true);
		expect(query).toHaveBeenCalledTimes(4);
		expect(unsafe).not.toHaveBeenCalled();
		guard.end();
	});

	it("retains the preview when its unchanged cast becomes active", async () => {
		const { guard, unsafe, event, values } = setup();
		await expect(guard.begin(91)).resolves.toBe(true);
		event({ CastStartedOrChanged: { cast: { ...values.casts[0], is_active: true } } });
		expect(unsafe).not.toHaveBeenCalled();
		event({
			CastStartedOrChanged: { cast: { ...values.casts[0], target: { Output: { name: "DP-2" } } } },
		});
		expect(unsafe).toHaveBeenCalledOnce();
		guard.end();
	});

	it.each([
		{ stream_id: 2 },
		{ pw_node_id: 92 },
		{ is_dynamic_target: true },
		{ target: { Window: { id: 8 } } },
	])("revokes on a changed cast footprint %j", async (change) => {
		const { guard, unsafe, event, values } = setup();
		await guard.begin(91);
		event({ CastStartedOrChanged: { cast: { ...values.casts[0], ...change } } });
		expect(unsafe).toHaveBeenCalledOnce();
		guard.end();
	});

	it.each([undefined, 92])("hides when the granted node %s cannot be proven", async (nodeId) => {
		const { guard } = setup();
		await expect(guard.begin(nodeId)).resolves.toBe(false);
		guard.end();
	});

	it("hides on compositor changes and never readmits during the same clip", async () => {
		const { guard, unsafe, event, query } = setup();
		await expect(guard.begin(91)).resolves.toBe(true);
		event({ WindowLayoutsChanged: { changes: [[99, {}]] } });
		expect(unsafe).not.toHaveBeenCalled();
		event({ WindowLayoutsChanged: { changes: [[8, {}]] } });
		event({ CastStartedOrChanged: {} });
		expect(unsafe).toHaveBeenCalledOnce();
		expect(query).toHaveBeenCalledTimes(4);
		guard.end();
	});

	it("revokes admission on monitor loss or IPC failure", async () => {
		const { guard, unsafe, fail } = setup();
		await expect(guard.begin(91)).resolves.toBe(true);
		guard.invalidate();
		fail();
		expect(unsafe).toHaveBeenCalledOnce();
		guard.end();
	});

	it("cannot admit a snapshot after its event connection fails", async () => {
		const { guard, fail, query } = setup();
		query.mockImplementation(async () => {
			fail();
			return [];
		});
		await expect(guard.begin(91)).resolves.toBe(false);
		guard.end();
	});

	it("ignores a stopped watch's callbacks during replacement capture", async () => {
		const { guard, unsafe, watch, event } = setup();
		await guard.begin(91);
		const oldChanged = watch.mock.calls[0][0];
		await guard.begin(91);
		oldChanged({ CastStopped: {} });
		expect(unsafe).not.toHaveBeenCalled();
		event({ CastStopped: {} });
		expect(unsafe).toHaveBeenCalledOnce();
		guard.end();
	});

	it("falls back to hiding outside Niri without starting a watch", async () => {
		vi.stubEnv("NIRI_SOCKET", "");
		const { guard, watch } = setup();
		await expect(guard.begin(91)).resolves.toBe(false);
		expect(watch).not.toHaveBeenCalled();
	});
});
