import { afterEach, beforeEach, expect, it, vi } from "vitest";

const replies = vi.hoisted(() => ({ values: [] as string[], calls: [] as string[][] }));
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

import { activateNiriHud } from "./niriHudFocus";

beforeEach(() => {
	replies.values = [];
	replies.calls = [];
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
