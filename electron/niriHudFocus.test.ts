import { afterEach, beforeEach, expect, it, vi } from "vitest";

const replies = vi.hoisted(() => ({
	values: [] as string[],
	calls: [] as string[][],
	writes: [] as string[],
}));
vi.mock("node:child_process", () => ({
	execFile: (
		_command: string,
		args: string[],
		_options: unknown,
		done: (error: Error | null, value: string) => void,
	) => {
		replies.calls.push(args);
		done(null, replies.values.shift() ?? "");
	},
}));

vi.mock("node:net", async () => {
	const { EventEmitter } = await import("node:events");
	return {
		createConnection: () => {
			const socket = Object.assign(new EventEmitter(), {
				destroy: vi.fn(),
				setTimeout: vi.fn(),
				write: (value: string) => {
					replies.writes.push(value);
					queueMicrotask(() => socket.emit("data", Buffer.from('{"Ok":"Handled"}\n')));
				},
			});
			queueMicrotask(() => socket.emit("connect"));
			return socket;
		},
	};
});

import { activateNiriHud, rememberNiriHudPlacement } from "./niriHudFocus";

beforeEach(() => {
	replies.values = [];
	replies.calls = [];
	replies.writes = [];
	vi.stubEnv("NIRI_SOCKET", "/tmp/private-niri-test.sock");
});
afterEach(() => vi.unstubAllEnvs());

it("activates only this process's floating recorder", async () => {
	const recorder = {
		id: 7,
		pid: 42,
		app_id: "co.dyberg.klippt",
		title: "Klippt",
		is_floating: true,
	};
	replies.values = [JSON.stringify([recorder, { ...recorder, id: 8, pid: 99 }]), ""];
	await activateNiriHud(42);
	expect(replies.calls).toEqual([
		["msg", "-j", "windows"],
		["msg", "action", "focus-window", "--id", "7"],
	]);
});

it("does not invoke another compositor outside Niri", async () => {
	vi.stubEnv("NIRI_SOCKET", "");
	await activateNiriHud(42);
	expect(replies.calls).toEqual([]);
});

it("rejects ambiguous owned windows without focusing anything", async () => {
	const recorder = {
		id: 7,
		pid: 42,
		app_id: "co.dyberg.klippt",
		title: "Klippt",
		is_floating: true,
	};
	replies.values = [JSON.stringify([recorder, { ...recorder, id: 8 }])];
	await expect(activateNiriHud(42)).rejects.toThrow("multiple windows");
	expect(replies.calls).toEqual([["msg", "-j", "windows"]]);
});

it("restores a remapped recorder to its original monitor and floating position", async () => {
	const recorder = {
		id: 7,
		pid: 42,
		app_id: "co.dyberg.klippt",
		title: "Klippt",
		is_floating: true,
		workspace_id: 9,
		layout: { tile_pos_in_workspace_view: [-10, 765] },
	};
	replies.values = [JSON.stringify([recorder]), JSON.stringify([{ id: 9, output: "DP-3" }])];
	const restore = await rememberNiriHudPlacement(42);
	expect(restore).toBeDefined();
	replies.values = [JSON.stringify([{ ...recorder, id: 17 }]), "", ""];
	await restore?.(() => true);
	expect(replies.calls.slice(-2)).toEqual([
		["msg", "-j", "windows"],
		["msg", "action", "move-window-to-monitor", "--id", "17", "DP-3"],
	]);
	expect(JSON.parse(replies.writes[0])).toEqual({
		Action: { MoveFloatingWindow: { id: 17, x: { SetFixed: -10 }, y: { SetFixed: 765 } } },
	});
});
