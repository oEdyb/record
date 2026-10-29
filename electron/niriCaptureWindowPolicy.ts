import { z } from "zod";

const id = z.number().int().nonnegative().safe();
const processId = z.number().int().positive().safe();
const nodeId = id.max(0xffff_ffff);
const coordinate = z.number().finite();
const dimension = coordinate.positive();
const position = z.tuple([coordinate, coordinate]);
const size = z.tuple([dimension, dimension]);
const rectangle = z
	.object({ x: coordinate, y: coordinate, width: dimension, height: dimension })
	.refine(
		(value) => Number.isFinite(value.x + value.width) && Number.isFinite(value.y + value.height),
	);
const output = z.object({ name: z.string().min(1), logical: rectangle.nullable() });
const workspace = z.object({ id, output: z.string().nullable(), is_active: z.boolean() });
const window = z.object({
	id,
	pid: processId.nullable(),
	app_id: z.string().nullable(),
	title: z.string().nullable(),
	is_floating: z.boolean(),
	workspace_id: id.nullable(),
	layout: z.object({
		tile_pos_in_workspace_view: position.nullable(),
		window_offset_in_tile: position,
		window_size: size,
	}),
});
const windows = z.array(window);
const target = z.union([
	z.object({ Output: z.object({ name: z.string().min(1) }) }).strict(),
	z.object({ Window: z.object({ id }) }).strict(),
	z.object({ Nothing: z.object({}).strict() }).strict(),
]);
const cast = z.object({
	stream_id: id,
	pw_node_id: nodeId.nullable(),
	kind: z.enum(["PipeWire", "WlrScreencopy"]),
	target,
	is_dynamic_target: z.boolean(),
});
const snapshot = z.object({
	pid: processId,
	pipeWireNodeId: nodeId,
	windowTitle: z.enum(["Klippt", "Klippt Camera", "Klippt Studio"]),
	casts: z.array(cast),
	outputs: z.record(z.string(), output),
	workspaces: z.array(workspace),
	windows,
});

type Window = z.infer<typeof window>;
type Snapshot = z.infer<typeof snapshot>;
type Rectangle = z.infer<typeof rectangle>;

function ownedPreview(values: Window[], pid: number, title: string): Window | undefined {
	const matches = values.filter(
		(value) =>
			value.pid === pid &&
			value.app_id === "co.dyberg.klippt" &&
			value.title === title &&
			value.is_floating,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export function ownedCaptureWindowId(value: unknown, pid: number, title: string): number | null {
	const parsed = windows.safeParse(value);
	if (!parsed.success || !processId.safeParse(pid).success) return null;
	return ownedPreview(parsed.data, pid, title)?.id ?? null;
}

function intersects(first: Rectangle, second: Rectangle): boolean {
	return (
		first.x < second.x + second.width &&
		first.x + first.width > second.x &&
		first.y < second.y + second.height &&
		first.y + first.height > second.y
	);
}

function previewRectangle(preview: Window, origin: Rectangle): Rectangle | null {
	const location = preview.layout.tile_pos_in_workspace_view;
	if (!location) return null;
	const [offsetX, offsetY] = preview.layout.window_offset_in_tile;
	const [width, height] = preview.layout.window_size;
	const value = rectangle.safeParse({
		x: origin.x + location[0] + offsetX,
		y: origin.y + location[1] + offsetY,
		width,
		height,
	});
	return value.success ? value.data : null;
}

function previewLocation(state: Snapshot, preview: Window) {
	const matches = state.workspaces.filter((value) => value.id === preview.workspace_id);
	if (matches.length !== 1 || !matches[0].is_active) return null;
	const name = matches[0].output;
	if (!name) return null;
	const origin = state.outputs[name]?.logical;
	if (!origin) return null;
	const bounds = previewRectangle(preview, origin);
	return bounds && intersects(origin, bounds) ? { name, bounds } : null;
}

function matchesMonitorCast(state: Snapshot): boolean {
	const matches = state.casts.filter(
		(value) => value.kind === "PipeWire" && value.pw_node_id === state.pipeWireNodeId,
	);
	return matches.length === 1 && "Output" in matches[0].target;
}

function unambiguousLocation(
	state: Snapshot,
	location: { name: string; bounds: Rectangle },
): boolean {
	return Object.entries(state.outputs).every(
		([name, value]) =>
			name === value.name &&
			(name === location.name ||
				value.logical === null ||
				!intersects(value.logical, location.bounds)),
	);
}

function castsAvoidPreview(state: Snapshot, preview: Window, outputName: string): boolean {
	if (new Set(state.casts.map((value) => value.stream_id)).size !== state.casts.length)
		return false;
	return state.casts.every((value) => {
		if (value.is_dynamic_target || "Nothing" in value.target) return false;
		if ("Window" in value.target) return value.target.Window.id !== preview.id;
		return Boolean(
			state.outputs[value.target.Output.name]?.logical && value.target.Output.name !== outputName,
		);
	});
}

export function readCaptureWindowSnapshot(input: unknown): Snapshot | null {
	const parsed = snapshot.safeParse(input);
	return parsed.success ? parsed.data : null;
}

export function windowOutsideCapture(input: unknown): boolean {
	const state = readCaptureWindowSnapshot(input);
	if (!state) return false;
	const preview = ownedPreview(state.windows, state.pid, state.windowTitle);
	if (!preview) return false;
	const location = previewLocation(state, preview);
	if (!location) return false;
	return (
		matchesMonitorCast(state) &&
		unambiguousLocation(state, location) &&
		castsAvoidPreview(state, preview, location.name)
	);
}

const captureEvent = z.union([
	z.object({ WindowsChanged: z.object({ windows }) }).strict(),
	z.object({ WindowOpenedOrChanged: z.object({ window }) }).strict(),
	z.object({ WindowClosed: z.object({ id }) }).strict(),
	z
		.object({
			WindowLayoutsChanged: z.object({ changes: z.array(z.tuple([id, window.shape.layout])) }),
		})
		.strict(),
	z.object({ WorkspacesChanged: z.object({ workspaces: z.array(workspace) }) }).strict(),
	z.object({ WorkspaceActivated: z.object({ id, focused: z.boolean() }) }).strict(),
	z.object({ CastsChanged: z.object({ casts: z.array(cast) }) }).strict(),
	z.object({ CastStartedOrChanged: z.object({ cast }) }).strict(),
	z.object({ CastStopped: z.object({ stream_id: id }) }).strict(),
	z.object({ OverviewOpenedOrClosed: z.object({ is_open: z.boolean() }) }).strict(),
]);
type CaptureEvent = z.infer<typeof captureEvent>;

function updateWindows(state: Snapshot, event: CaptureEvent): Snapshot | undefined {
	if ("WindowsChanged" in event) return { ...state, windows: event.WindowsChanged.windows };
	if ("WindowOpenedOrChanged" in event) {
		const next = event.WindowOpenedOrChanged.window;
		return { ...state, windows: [...state.windows.filter((value) => value.id !== next.id), next] };
	}
	if ("WindowClosed" in event)
		return {
			...state,
			windows: state.windows.filter((value) => value.id !== event.WindowClosed.id),
		};
	if ("WindowLayoutsChanged" in event) {
		const layouts = new Map(event.WindowLayoutsChanged.changes);
		return {
			...state,
			windows: state.windows.map((value) => ({
				...value,
				layout: layouts.get(value.id) ?? value.layout,
			})),
		};
	}
}

function updateWorkspaces(state: Snapshot, event: CaptureEvent): Snapshot | undefined {
	if ("WorkspacesChanged" in event)
		return { ...state, workspaces: event.WorkspacesChanged.workspaces };
	if ("WorkspaceActivated" in event) {
		const active = state.workspaces.find((value) => value.id === event.WorkspaceActivated.id);
		if (!active?.output) return { ...state, workspaces: [] };
		return {
			...state,
			workspaces: state.workspaces.map((value) =>
				value.output === active.output ? { ...value, is_active: value.id === active.id } : value,
			),
		};
	}
}

function updateCasts(state: Snapshot, event: CaptureEvent): Snapshot | undefined {
	if ("CastsChanged" in event) return { ...state, casts: event.CastsChanged.casts };
	if ("CastStartedOrChanged" in event) {
		const next = event.CastStartedOrChanged.cast;
		return {
			...state,
			casts: [...state.casts.filter((value) => value.stream_id !== next.stream_id), next],
		};
	}
	if ("CastStopped" in event)
		return {
			...state,
			casts: state.casts.filter((value) => value.stream_id !== event.CastStopped.stream_id),
		};
}

export function updateCaptureWindowSnapshot(input: unknown, value: unknown): Snapshot | null {
	const parsed = snapshot.safeParse(input);
	if (!parsed.success || !value || typeof value !== "object") return null;
	const state = parsed.data;
	const ignored = [
		"WindowFocusChanged",
		"WindowFocusTimestampChanged",
		"WindowUrgencyChanged",
		"WorkspaceUrgencyChanged",
		"WorkspaceActiveWindowChanged",
		"KeyboardLayoutsChanged",
		"KeyboardLayoutSwitched",
		"ScreenshotCaptured",
	];
	const keys = Object.keys(value);
	if (keys.length === 1 && ignored.includes(keys[0])) return state;
	const event = captureEvent.safeParse(value);
	if (!event.success) return null;
	if ("OverviewOpenedOrClosed" in event.data)
		return event.data.OverviewOpenedOrClosed.is_open ? null : state;
	return (
		updateWindows(state, event.data) ??
		updateWorkspaces(state, event.data) ??
		updateCasts(state, event.data) ??
		null
	);
}
