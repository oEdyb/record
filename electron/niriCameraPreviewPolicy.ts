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
	casts: z.array(cast),
	outputs: z.record(z.string(), output),
	workspaces: z.array(workspace),
	windows,
});

type Window = z.infer<typeof window>;
type Snapshot = z.infer<typeof snapshot>;
type Rectangle = z.infer<typeof rectangle>;

function ownedPreview(values: Window[], pid: number): Window | undefined {
	const matches = values.filter(
		(value) =>
			value.pid === pid &&
			value.app_id === "co.dyberg.klippt" &&
			value.title === "Klippt Camera" &&
			value.is_floating,
	);
	return matches.length === 1 ? matches[0] : undefined;
}

export function ownedCameraPreviewId(value: unknown, pid: number): number | null {
	const parsed = windows.safeParse(value);
	if (!parsed.success || !processId.safeParse(pid).success) return null;
	return ownedPreview(parsed.data, pid)?.id ?? null;
}

function intersects(first: Rectangle, second: Rectangle): boolean {
	return (
		first.x < second.x + second.width &&
		first.x + first.width > second.x &&
		first.y < second.y + second.height &&
		first.y + first.height > second.y
	);
}

function contains(outer: Rectangle, inner: Rectangle): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.width <= outer.x + outer.width &&
		inner.y + inner.height <= outer.y + outer.height
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
	return bounds && contains(origin, bounds) ? { name, bounds } : null;
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

export function previewOutsideCapture(input: {
	pid: number;
	pipeWireNodeId: number;
	casts: unknown;
	outputs: unknown;
	workspaces: unknown;
	windows: unknown;
}): boolean {
	const parsed = snapshot.safeParse(input);
	if (!parsed.success) return false;
	const state = parsed.data;
	const preview = ownedPreview(state.windows, state.pid);
	if (!preview) return false;
	const location = previewLocation(state, preview);
	if (!location) return false;
	return (
		matchesMonitorCast(state) &&
		unambiguousLocation(state, location) &&
		castsAvoidPreview(state, preview, location.name)
	);
}
