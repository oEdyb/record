import { execFile } from "node:child_process";
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
