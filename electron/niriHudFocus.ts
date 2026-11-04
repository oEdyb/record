import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { z } from "zod";

const windows = z.array(
	z.object({
		id: z.number().int().nonnegative(),
		pid: z.number().int().nullable(),
		app_id: z.string().nullable(),
		title: z.string().nullable(),
		is_floating: z.boolean(),
	}),
);

function niri(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("niri", args, { timeout: 1000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

export async function activateNiriHud(pid: number): Promise<void> {
	if (!process.env.NIRI_SOCKET) return;
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const owned = windows
			.parse(JSON.parse(await niri(["msg", "-j", "windows"])))
			.filter(
				(window) =>
					window.pid === pid &&
					window.app_id === "co.dyberg.klippt" &&
					window.title === "Klippt" &&
					window.is_floating,
			);
		if (owned.length === 1) {
			await niri(["msg", "action", "focus-window", "--id", String(owned[0].id)]);
			return;
		}
		if (owned.length > 1) throw new Error("Recorder activation matched multiple windows.");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("Niri did not expose the restored recorder window.");
}

const placementWindows = z.array(
	windows.element.extend({
		workspace_id: z.number().int().nonnegative().nullable(),
		layout: z.object({
			tile_pos_in_workspace_view: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
		}),
	}),
);
const workspaces = z.array(
	z.object({ id: z.number().int().nonnegative(), output: z.string().nullable() }),
);

function moveFloatingWindow(id: number, x: number, y: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(process.env.NIRI_SOCKET ?? "");
		let response = "";
		let handled = false;
		const finish = (error?: Error) => {
			socket.destroy();
			if (error) reject(error);
			else resolve();
		};
		socket.once("connect", () =>
			socket.write(
				`${JSON.stringify({ Action: { MoveFloatingWindow: { id, x: { SetFixed: x }, y: { SetFixed: y } } } })}\n`,
			),
		);
		socket.setTimeout(1000, () => finish(new Error("Niri recorder placement timed out.")));
		socket.on("error", finish);
		socket.on("close", () => {
			if (!handled) reject(new Error("Niri recorder placement disconnected."));
		});
		socket.on("data", (data: Buffer) => {
			response += data.toString();
			if (response.length > 65_536)
				return finish(new Error("Niri recorder placement reply exceeded its limit."));
			if (!response.includes("\n")) return;
			try {
				const result: unknown = JSON.parse(response.split("\n")[0]);
				if (!result || typeof result !== "object" || !("Ok" in result) || result.Ok !== "Handled")
					return finish(new Error("Niri rejected recorder placement."));
				handled = true;
				finish();
			} catch {
				finish(new Error("Niri returned invalid recorder placement data."));
			}
		});
	});
}

export async function rememberNiriHudPlacement(
	pid: number,
	windowTitle = "Klippt",
): Promise<((mayRestore: () => boolean) => Promise<void>) | undefined> {
	if (!process.env.NIRI_SOCKET) return;
	const owned = placementWindows
		.parse(JSON.parse(await niri(["msg", "-j", "windows"])))
		.filter(
			(value) =>
				value.pid === pid &&
				value.app_id === "co.dyberg.klippt" &&
				value.title === windowTitle &&
				value.is_floating,
		);
	if (owned.length !== 1 || !owned[0].layout.tile_pos_in_workspace_view) return;
	const position = owned[0].layout.tile_pos_in_workspace_view;
	const workspace = workspaces
		.parse(JSON.parse(await niri(["msg", "-j", "workspaces"])))
		.find((value) => value.id === owned[0].workspace_id);
	if (!workspace?.output) return;
	const output = workspace.output;
	return async (mayRestore) => {
		for (let attempt = 0; attempt < 8; attempt += 1) {
			if (!mayRestore()) return;
			const restored = windows
				.parse(JSON.parse(await niri(["msg", "-j", "windows"])))
				.filter(
					(value) =>
						value.pid === pid &&
						value.app_id === "co.dyberg.klippt" &&
						value.title === windowTitle &&
						value.is_floating,
				);
			if (restored.length > 1) throw new Error("Recorder placement matched multiple windows.");
			if (restored.length === 1) {
				const id = String(restored[0].id);
				if (!mayRestore()) return;
				await niri(["msg", "action", "move-window-to-monitor", "--id", id, output]);
				if (!mayRestore()) return;
				await moveFloatingWindow(restored[0].id, position[0], position[1]);
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error("Niri did not expose the recorder for placement restoration.");
	};
}
