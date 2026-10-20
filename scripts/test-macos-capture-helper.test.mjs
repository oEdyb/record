import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	isolatedCaptureTestManifest,
	runCaptureHelperTests,
} from "./test-macos-capture-helper.mjs";

const approvedManifest = fs.readFileSync(
	fileURLToPath(new URL("../electron/native/screencapturekit/Package.swift", import.meta.url)),
	"utf8",
);
let directory;
let packageDir;
let temporaryRoot;

beforeEach(() => {
	directory = fs.mkdtempSync(path.join(os.tmpdir(), "klippt-native-test-runner-"));
	packageDir = path.join(directory, "original");
	temporaryRoot = path.join(directory, "temporary");
	fs.mkdirSync(temporaryRoot);
	for (const name of ["Sources", "Tests", "Support", ".build"]) {
		fs.mkdirSync(path.join(packageDir, name), { recursive: true });
		fs.writeFileSync(path.join(packageDir, name, "sentinel.swift"), `original ${name}`);
	}
	fs.writeFileSync(path.join(packageDir, "Package.swift"), approvedManifest);
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function childProcess() {
	const child = new EventEmitter();
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
}

describe("isolated macOS capture helper tests", () => {
	it("preserves the approved tools, platform and executable targets while adding tests only to a copy", () => {
		const isolated = isolatedCaptureTestManifest(approvedManifest);
		expect(isolated.replace(/,\n\t\t\.testTarget\([\s\S]*?\n\t\t\)/, "")).toBe(approvedManifest);
		expect(isolated).toContain('dependencies: ["OpenScreenScreenCaptureKitHelper"]');
		expect(isolated).toContain('path: "Tests/OpenScreenScreenCaptureKitHelperTests"');
		expect(fs.readFileSync(path.join(packageDir, "Package.swift"), "utf8")).toBe(approvedManifest);
	});

	it.each([
		[
			"tools version",
			(base) => base.replace("swift-tools-version: 5.9", "swift-tools-version: 6.0"),
		],
		["platform", (base) => base.replace(".macOS(.v13)", ".macOS(.v14)")],
		[
			"helper target",
			(base) => base.replace('path: "Sources/OpenScreenScreenCaptureKitHelper"', 'path: "Other"'),
		],
		["closing target anchor", (base) => `${base}\n`],
		[
			"ambiguous helper target",
			(base) =>
				base.replace(
					"\t]\n)\n",
					`\t\t.executableTarget(\n\t\t\tname: "OpenScreenScreenCaptureKitHelper",\n\t\t\tpath: "Sources/OpenScreenScreenCaptureKitHelper",\n\t\t\tlinkerSettings: embeddedInfoPlist("screencapturekit-helper")\n\t\t)\n\t]\n)\n`,
				),
		],
		["existing test target", (base) => base.replace("\ttargets: [", "\ttargets: [.testTarget(")],
	])("rejects an unsupported %s before creating a temporary package or spawning Swift", async (_name, modify) => {
		fs.writeFileSync(path.join(packageDir, "Package.swift"), modify(approvedManifest));
		const spawnImpl = vi.fn();
		await expect(runCaptureHelperTests({ packageDir, temporaryRoot, spawnImpl })).rejects.toThrow(
			"Unsupported capture helper Package.swift",
		);
		expect(spawnImpl).not.toHaveBeenCalled();
		expect(fs.readdirSync(temporaryRoot)).toEqual([]);
	});

	it("runs only copied sources with an owned scratch path and removes them after successful close", async () => {
		const child = childProcess();
		const spawnImpl = vi.fn(() => child);
		const output = vi.fn();
		const running = runCaptureHelperTests({
			packageDir,
			temporaryRoot,
			spawnImpl,
			onOutput: output,
		});
		const [command, args, options] = spawnImpl.mock.calls[0];
		const isolatedPackage = args[4];
		expect(command).toBe("swift");
		expect(args).toEqual([
			"test",
			"--jobs",
			"2",
			"--package-path",
			isolatedPackage,
			"--scratch-path",
			path.join(isolatedPackage, ".build"),
		]);
		expect(options).toEqual({
			cwd: isolatedPackage,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		expect(path.dirname(isolatedPackage)).toBe(temporaryRoot);
		expect(fs.existsSync(path.join(isolatedPackage, ".build"))).toBe(false);
		for (const name of ["Sources", "Tests", "Support"]) {
			expect(fs.readFileSync(path.join(isolatedPackage, name, "sentinel.swift"), "utf8")).toBe(
				`original ${name}`,
			);
		}
		child.stdout.emit("data", Buffer.from("Native tests passed\n"));
		child.stderr.emit("data", Buffer.from("Build complete\n"));
		expect(output).toHaveBeenCalledTimes(2);
		child.emit("close", 0, null);
		await running;
		expect(fs.readdirSync(temporaryRoot)).toEqual([]);
		expect(fs.readFileSync(path.join(packageDir, "Package.swift"), "utf8")).toBe(approvedManifest);
		expect(fs.readFileSync(path.join(packageDir, ".build/sentinel.swift"), "utf8")).toBe(
			"original .build",
		);
	});

	it("cleans its copied package when preparing sources fails before Swift starts", async () => {
		fs.rmSync(path.join(packageDir, "Tests"), { recursive: true });
		const spawnImpl = vi.fn();
		await expect(runCaptureHelperTests({ packageDir, temporaryRoot, spawnImpl })).rejects.toThrow();
		expect(spawnImpl).not.toHaveBeenCalled();
		expect(fs.readdirSync(temporaryRoot)).toEqual([]);
	});

	it("rejects test failures and cleans up after the process closes", async () => {
		const child = childProcess();
		const running = runCaptureHelperTests({ packageDir, temporaryRoot, spawnImpl: () => child });
		child.emit("close", 1, null);
		await expect(running).rejects.toThrow("Swift capture tests failed (exit 1)");
		expect(fs.readdirSync(temporaryRoot)).toEqual([]);
	});

	it("retains the scratch package after spawn error until close confirms no output work remains", async () => {
		const child = childProcess();
		const running = runCaptureHelperTests({ packageDir, temporaryRoot, spawnImpl: () => child });
		child.emit("error", new Error("Swift was not found"));
		expect(fs.readdirSync(temporaryRoot)).toHaveLength(1);
		child.emit("close", -2, null);
		await expect(running).rejects.toThrow("Swift was not found");
		expect(fs.readdirSync(temporaryRoot)).toEqual([]);
	});

	it("kills canceled Swift work and waits for close before removing the scratch package", async () => {
		const child = childProcess();
		const controller = new AbortController();
		const running = runCaptureHelperTests({
			packageDir,
			temporaryRoot,
			signal: controller.signal,
			spawnImpl: () => child,
		});
		controller.abort(new Error("Canceled native tests"));
		expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		expect(fs.readdirSync(temporaryRoot)).toHaveLength(1);
		child.emit("close", null, "SIGKILL");
		await expect(running).rejects.toThrow("Canceled native tests");
		expect(fs.readdirSync(temporaryRoot)).toEqual([]);
	});

	it("does not prepare or spawn any work for an already canceled request", async () => {
		const controller = new AbortController();
		controller.abort(new Error("Already canceled"));
		const spawnImpl = vi.fn();
		await expect(
			runCaptureHelperTests({ packageDir, temporaryRoot, signal: controller.signal, spawnImpl }),
		).rejects.toThrow("Already canceled");
		expect(spawnImpl).not.toHaveBeenCalled();
		expect(fs.readdirSync(temporaryRoot)).toEqual([]);
	});
});
