import { execFile } from "node:child_process";

const STUDIO_TITLE = "Klippt Studio";

function niri(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("niri", ["msg", ...args], { timeout: 1000, maxBuffer: 1_048_576 }, (error, stdout) =>
			error ? reject(error) : resolve(stdout),
		);
	});
}

async function niriJson(what: "casts" | "windows" | "workspaces" | "outputs"): Promise<unknown> {
	return JSON.parse(await niri(["-j", what]));
}

type Placement = {
	windowId: number;
	studioOutput: string;
	recordedOutput: string;
	others: string[];
};

/** Where the Studio and the recorded screen are, read from niri. Null when unsure. */
export async function readStudioPlacement(pipeWireNodeId: number): Promise<Placement | null> {
	const [casts, windows, workspaces, outputs] = await Promise.all([
		niriJson("casts"),
		niriJson("windows"),
		niriJson("workspaces"),
		niriJson("outputs"),
	]);
	if (!Array.isArray(casts) || !Array.isArray(windows) || !Array.isArray(workspaces)) return null;
	const cast = casts.find(
		(value) => value?.kind === "PipeWire" && value.pw_node_id === pipeWireNodeId,
	);
	const recordedOutput = cast?.target?.Output?.name;
	const studio = windows.filter(
		(value) =>
			value?.pid === process.pid &&
			value.app_id === "co.dyberg.klippt" &&
			value.title === STUDIO_TITLE,
	);
	if (typeof recordedOutput !== "string" || studio.length !== 1) return null;
	const studioOutput = workspaces.find((value) => value?.id === studio[0].workspace_id)?.output;
	if (typeof studioOutput !== "string" || !outputs || typeof outputs !== "object") return null;
	const others = Object.entries(outputs as Record<string, { logical?: unknown }>)
		.filter(([name, value]) => name !== recordedOutput && value?.logical)
		.map(([name]) => name);
	return { windowId: studio[0].id, studioOutput, recordedOutput, others };
}

export async function moveStudioToOutput(windowId: number, output: string): Promise<void> {
	await niri(["action", "move-window-to-monitor", "--id", String(windowId), output]);
}

/**
 * The Studio sits on the screen about to be recorded: move it to another screen.
 * Resolves to the output it left, so it can go back, or null when it did not move.
 */
export async function moveStudioOffCapture(
	pipeWireNodeId: number | undefined,
): Promise<string | null> {
	if (!process.env.NIRI_SOCKET || pipeWireNodeId === undefined) return null;
	try {
		const placement = await readStudioPlacement(pipeWireNodeId);
		if (!placement || placement.studioOutput !== placement.recordedOutput) return null;
		const target = placement.others[0];
		if (!target) return null;
		await moveStudioToOutput(placement.windowId, target);
		console.info(`[studio] moved off ${placement.studioOutput} to ${target} for recording`);
		return placement.studioOutput;
	} catch (error) {
		console.warn("[studio] could not move off the recorded screen:", error);
		return null;
	}
}

/** Back to where the creator had it, once capture pauses. */
export async function returnStudioTo(output: string): Promise<void> {
	if (!process.env.NIRI_SOCKET) return;
	try {
		const windows = await niriJson("windows");
		const studio = Array.isArray(windows)
			? windows.filter((value) => value?.pid === process.pid && value.title === STUDIO_TITLE)
			: [];
		if (studio.length === 1) await moveStudioToOutput(studio[0].id, output);
	} catch (error) {
		console.warn("[studio] could not move back:", error);
	}
}
