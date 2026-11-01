import { describe, expect, it } from "vitest";
import { ownedCaptureWindowId, windowOutsideCapture } from "./niriCaptureWindowPolicy";

function fixture() {
	return {
		pid: 42,
		pipeWireNodeId: 91,
		windowTitle: "Klippt Camera",
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
		expect(windowOutsideCapture(fixture())).toBe(true);
		const value = fixture();
		value.outputs["DP-1"].logical.scale = 1.25;
		value.outputs["DP-2"].logical.scale = 2;
		expect(windowOutsideCapture(value)).toBe(true);
	});

	it("supports negative output origins and fractional logical positions", () => {
		const value = fixture();
		value.outputs["DP-2"].logical.x = -1920;
		value.outputs["DP-2"].logical.y = -200;
		value.windows[0].layout.tile_pos_in_workspace_view = [14.5, 20.25];
		expect(windowOutsideCapture(value)).toBe(true);
	});

	it("hides on the recorded output, a disabled output, or a single-monitor desktop", () => {
		const value = fixture();
		value.workspaces[0].output = "DP-1";
		expect(windowOutsideCapture(value)).toBe(false);
		expect(
			windowOutsideCapture({
				...fixture(),
				outputs: { ...fixture().outputs, "DP-2": { name: "DP-2", logical: null } },
			}),
		).toBe(false);
		expect(
			windowOutsideCapture({ ...fixture(), outputs: { "DP-1": fixture().outputs["DP-1"] } }),
		).toBe(false);
	});

	it("rejects visible overlap with another output but permits compositor-clipped edges", () => {
		const value = fixture();
		value.windows[0].layout.tile_pos_in_workspace_view = [-3, 24];
		expect(windowOutsideCapture(value)).toBe(false);
		value.windows[0].layout.tile_pos_in_workspace_view = [24, 1000];
		expect(windowOutsideCapture(value)).toBe(true);
		value.windows[0].layout.tile_pos_in_workspace_view = [24, 1200];
		expect(windowOutsideCapture(value)).toBe(false);
	});

	it("evaluates the pill independently of the preview using actual compositor bounds", () => {
		const value = fixture();
		const pill = {
			...value.windows[0],
			id: 9,
			title: "Klippt",
			layout: {
				...value.windows[0].layout,
				window_size: [472, 680],
				tile_pos_in_workspace_view: [342, 405],
			},
		};
		const input = { ...value, windows: [...value.windows, pill], windowTitle: "Klippt" };
		expect(windowOutsideCapture(input)).toBe(true);
		pill.workspace_id = 99;
		expect(windowOutsideCapture(input)).toBe(false);
		expect(windowOutsideCapture({ ...input, windowTitle: "Klippt Camera" })).toBe(true);
	});

	it("does not allow a monitor whose global rectangle overlaps the preview", () => {
		const value = fixture();
		value.outputs["DP-1"].logical.width = 1400;
		expect(windowOutsideCapture(value)).toBe(false);
	});

	it("hides when another cast captures the preview output or the preview window", () => {
		const value = fixture();
		value.casts.push({
			...value.casts[0],
			stream_id: 2,
			pw_node_id: 92,
			target: { Output: { name: "DP-2" } },
		});
		expect(windowOutsideCapture(value)).toBe(false);
		expect(
			windowOutsideCapture({
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
			windowOutsideCapture({
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
		expect(windowOutsideCapture({ ...value, casts: [] })).toBe(false);
		expect(windowOutsideCapture({ ...value, pipeWireNodeId: 92 })).toBe(false);
		expect(windowOutsideCapture({ ...value, casts: [...value.casts, ...value.casts] })).toBe(false);
		expect(
			windowOutsideCapture({ ...value, casts: [{ ...value.casts[0], kind: "WlrScreencopy" }] }),
		).toBe(false);
		expect(
			windowOutsideCapture({
				...value,
				casts: [{ ...value.casts[0], target: { Window: { id: 99 } } }],
			}),
		).toBe(false);
		expect(
			windowOutsideCapture({ ...value, casts: [{ ...value.casts[0], is_dynamic_target: true }] }),
		).toBe(false);
		expect(
			windowOutsideCapture({
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
				windowOutsideCapture({ ...value, windows: [{ ...value.windows[0], ...changed }] }),
			).toBe(false);
		}
		const value = fixture();
		expect(
			windowOutsideCapture({
				...value,
				windows: [...value.windows, { ...value.windows[0], id: 9 }],
			}),
		).toBe(false);
		expect(windowOutsideCapture({ ...value, workspaces: [] })).toBe(false);
		expect(
			windowOutsideCapture({
				...value,
				workspaces: [{ ...value.workspaces[0], is_active: false }],
			}),
		).toBe(false);
		expect(
			windowOutsideCapture({ ...value, workspaces: [...value.workspaces, ...value.workspaces] }),
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
			expect(windowOutsideCapture({ ...value, ...changed })).toBe(false);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const candidate = fixture();
			candidate.windows[0].layout.tile_pos_in_workspace_view[0] = bad;
			expect(windowOutsideCapture(candidate)).toBe(false);
		}
		expect(
			windowOutsideCapture({
				...value,
				outputs: {
					...value.outputs,
					"DP-2": { name: "DP-2", logical: { x: 1e308, y: 0, width: 1e308, height: 1080 } },
				},
			}),
		).toBe(false);
		expect(windowOutsideCapture({ ...value, windows: [{ ...value.windows[0], layout: {} }] })).toBe(
			false,
		);
		expect(
			windowOutsideCapture({
				...value,
				windows: [{ ...value.windows[0], id: Number.MAX_SAFE_INTEGER + 1 }],
			}),
		).toBe(false);
		expect(
			windowOutsideCapture({
				...value,
				casts: [{ ...value.casts[0], target: { Output: { name: "missing" } } }],
			}),
		).toBe(false);
	});
});

describe("owned camera preview identity", () => {
	it("returns only a unique valid window owned by this process", () => {
		const value = fixture();
		expect(ownedCaptureWindowId(value.windows, 42, "Klippt Camera")).toBe(8);
		expect(ownedCaptureWindowId(value.windows, 99, "Klippt Camera")).toBeNull();
		expect(
			ownedCaptureWindowId([...value.windows, { ...value.windows[0], id: 9 }], 42, "Klippt Camera"),
		).toBeNull();
		expect(ownedCaptureWindowId(null, 42, "Klippt Camera")).toBeNull();
		expect(
			ownedCaptureWindowId(value.windows, Number.POSITIVE_INFINITY, "Klippt Camera"),
		).toBeNull();
	});
});
