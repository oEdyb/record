import { describe, expect, it } from "vitest";
import { ownedCameraPreviewId, previewOutsideCapture } from "./niriCameraPreviewPolicy";

function fixture() {
	return {
		pid: 42,
		pipeWireNodeId: 91,
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
			"DP-1": { name: "DP-1", logical: { x: 0, y: 0, width: 1280, height: 800, scale: 2 } },
			"DP-2": { name: "DP-2", logical: { x: 1280, y: 0, width: 1920, height: 1080, scale: 1 } },
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
					window_offset_in_tile: [2, 2],
					window_size: [312, 186],
				},
			},
		],
	};
}

describe("Niri second-monitor camera preview policy", () => {
	it("allows only a complete preview on a distinct uncaptured logical output", () => {
		expect(previewOutsideCapture(fixture())).toBe(true);
		const value = fixture();
		value.outputs["DP-1"].logical.scale = 1.25;
		value.outputs["DP-2"].logical.scale = 2;
		expect(previewOutsideCapture(value)).toBe(true);
	});

	it("supports negative output origins and fractional logical positions", () => {
		const value = fixture();
		value.outputs["DP-2"].logical.x = -1920;
		value.outputs["DP-2"].logical.y = -200;
		value.windows[0].layout.tile_pos_in_workspace_view = [14.5, 20.25];
		expect(previewOutsideCapture(value)).toBe(true);
	});

	it("hides on the recorded output, a disabled output, or a single-monitor desktop", () => {
		const value = fixture();
		value.workspaces[0].output = "DP-1";
		expect(previewOutsideCapture(value)).toBe(false);
		expect(
			previewOutsideCapture({
				...fixture(),
				outputs: { ...fixture().outputs, "DP-2": { name: "DP-2", logical: null } },
			}),
		).toBe(false);
		expect(
			previewOutsideCapture({ ...fixture(), outputs: { "DP-1": fixture().outputs["DP-1"] } }),
		).toBe(false);
	});

	it("rejects a preview straddling or leaving its output, including its tile offset", () => {
		for (const position of [
			[-3, 24],
			[1607, 24],
			[24, 893],
		]) {
			const value = fixture();
			value.windows[0].layout.tile_pos_in_workspace_view = position;
			expect(previewOutsideCapture(value)).toBe(false);
		}
		const value = fixture();
		value.windows[0].layout.window_offset_in_tile = [-40, 0];
		expect(previewOutsideCapture(value)).toBe(false);
	});

	it("does not allow a monitor whose global rectangle overlaps the preview", () => {
		const value = fixture();
		value.outputs["DP-1"].logical.width = 1400;
		expect(previewOutsideCapture(value)).toBe(false);
	});

	it("hides when another cast captures the preview output or the preview window", () => {
		const value = fixture();
		value.casts.push({
			...value.casts[0],
			stream_id: 2,
			pw_node_id: 92,
			target: { Output: { name: "DP-2" } },
		});
		expect(previewOutsideCapture(value)).toBe(false);
		expect(
			previewOutsideCapture({
				...fixture(),
				casts: [
					...fixture().casts,
					{ ...fixture().casts[0], stream_id: 2, pw_node_id: 92, target: { Window: { id: 8 } } },
				],
			}),
		).toBe(false);
	});

	it("permits an unrelated captured application window", () => {
		expect(
			previewOutsideCapture({
				...fixture(),
				casts: [
					...fixture().casts,
					{ ...fixture().casts[0], stream_id: 2, pw_node_id: 92, target: { Window: { id: 99 } } },
				],
			}),
		).toBe(true);
	});

	it("requires exactly one matching PipeWire monitor cast and stable known targets", () => {
		const value = fixture();
		expect(previewOutsideCapture({ ...value, casts: [] })).toBe(false);
		expect(previewOutsideCapture({ ...value, pipeWireNodeId: 92 })).toBe(false);
		expect(previewOutsideCapture({ ...value, casts: [...value.casts, ...value.casts] })).toBe(
			false,
		);
		expect(
			previewOutsideCapture({ ...value, casts: [{ ...value.casts[0], kind: "WlrScreencopy" }] }),
		).toBe(false);
		expect(
			previewOutsideCapture({
				...value,
				casts: [{ ...value.casts[0], target: { Window: { id: 99 } } }],
			}),
		).toBe(false);
		expect(
			previewOutsideCapture({ ...value, casts: [{ ...value.casts[0], is_dynamic_target: true }] }),
		).toBe(false);
		expect(
			previewOutsideCapture({
				...value,
				casts: [...value.casts, { ...value.casts[0], stream_id: 2, target: { Nothing: {} } }],
			}),
		).toBe(false);
	});

	it("requires an unambiguous owned floating preview on an active workspace", () => {
		for (const changed of [
			{ pid: 99 },
			{ title: "Klippt" },
			{ app_id: "another.app" },
			{ is_floating: false },
			{ workspace_id: null },
		]) {
			const value = fixture();
			expect(
				previewOutsideCapture({ ...value, windows: [{ ...value.windows[0], ...changed }] }),
			).toBe(false);
		}
		const value = fixture();
		expect(
			previewOutsideCapture({
				...value,
				windows: [...value.windows, { ...value.windows[0], id: 9 }],
			}),
		).toBe(false);
		expect(previewOutsideCapture({ ...value, workspaces: [] })).toBe(false);
		expect(
			previewOutsideCapture({
				...value,
				workspaces: [{ ...value.workspaces[0], is_active: false }],
			}),
		).toBe(false);
		expect(
			previewOutsideCapture({ ...value, workspaces: [...value.workspaces, ...value.workspaces] }),
		).toBe(false);
	});

	it("rejects malformed, nonfinite, missing and unsafe snapshot data", () => {
		const value = fixture();
		for (const changed of [
			{ pid: Number.NaN },
			{ pid: 0 },
			{ pipeWireNodeId: -1 },
			{ pipeWireNodeId: 0x1_0000_0000 },
			{ outputs: null },
			{ windows: null },
			{ casts: null },
			{ workspaces: null },
			{
				outputs: {
					...value.outputs,
					"DP-2": { name: "wrong", logical: value.outputs["DP-2"].logical },
				},
			},
		])
			expect(previewOutsideCapture({ ...value, ...changed })).toBe(false);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const candidate = fixture();
			candidate.windows[0].layout.tile_pos_in_workspace_view[0] = bad;
			expect(previewOutsideCapture(candidate)).toBe(false);
		}
		expect(
			previewOutsideCapture({
				...value,
				outputs: {
					...value.outputs,
					"DP-2": { name: "DP-2", logical: { x: 1e308, y: 0, width: 1e308, height: 1080 } },
				},
			}),
		).toBe(false);
		expect(
			previewOutsideCapture({ ...value, windows: [{ ...value.windows[0], layout: {} }] }),
		).toBe(false);
		expect(
			previewOutsideCapture({
				...value,
				windows: [{ ...value.windows[0], id: Number.MAX_SAFE_INTEGER + 1 }],
			}),
		).toBe(false);
		expect(
			previewOutsideCapture({
				...value,
				casts: [{ ...value.casts[0], target: { Output: { name: "missing" } } }],
			}),
		).toBe(false);
	});
});

describe("owned camera preview identity", () => {
	it("returns only a unique valid window owned by this process", () => {
		const value = fixture();
		expect(ownedCameraPreviewId(value.windows, 42)).toBe(8);
		expect(ownedCameraPreviewId(value.windows, 99)).toBeNull();
		expect(ownedCameraPreviewId([...value.windows, { ...value.windows[0], id: 9 }], 42)).toBeNull();
		expect(ownedCameraPreviewId(null, 42)).toBeNull();
		expect(ownedCameraPreviewId(value.windows, Number.POSITIVE_INFINITY)).toBeNull();
	});
});
