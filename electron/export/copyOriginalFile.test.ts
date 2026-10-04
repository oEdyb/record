import { execFile } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyOriginalFile } from "./copyOriginalFile";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let root: string;
let source: string;
let destination: string;
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "original-copy-"));
	source = path.join(root, "original.mov");
	destination = path.join(root, "copy.mov");
	await fs.writeFile(source, "original media");
	Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
	vi.mocked(execFile).mockReset();
});
afterEach(async () => {
	Object.defineProperty(process, "platform", platform);
	vi.restoreAllMocks();
	await fs.rm(root, { recursive: true, force: true });
});

it("uses native cloning with no-overwrite and propagates copy failures", async () => {
	vi.mocked(execFile).mockImplementation(() => {
		throw new Error("native copy failed");
	});
	await expect(copyOriginalFile(source, destination)).rejects.toThrow("native copy failed");
	expect(execFile).toHaveBeenCalledWith(
		"/bin/cp",
		["-c", "-n", source, destination],
		expect.any(Function),
	);
	expect(await fs.readFile(source, "utf8")).toBe("original media");
});

it.each(["file", "directory", "symlink"])("rejects an existing %s destination", async (kind) => {
	if (kind === "directory") await fs.mkdir(destination);
	else if (kind === "symlink") await fs.symlink(path.join(root, "missing"), destination);
	else await fs.writeFile(destination, "keep this");
	await expect(copyOriginalFile(source, destination)).rejects.toThrow("already exists");
	expect(execFile).not.toHaveBeenCalled();
	if (kind === "file") expect(await fs.readFile(destination, "utf8")).toBe("keep this");
});

it("keeps an exclusive independent copy on other platforms", async () => {
	Object.defineProperty(process, "platform", { value: "linux", configurable: true });
	const copy = vi.spyOn(fs, "copyFile");
	await copyOriginalFile(source, destination);
	expect(copy).toHaveBeenCalledWith(
		source,
		destination,
		constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
	);
	expect(await fs.readFile(destination, "utf8")).toBe("original media");
	await fs.writeFile(destination, "changed copy");
	expect(await fs.readFile(source, "utf8")).toBe("original media");
	await expect(copyOriginalFile(source, destination)).rejects.toThrow();
	expect(await fs.readFile(destination, "utf8")).toBe("changed copy");
	expect(execFile).not.toHaveBeenCalled();
});

it("rejects relative paths before invoking a command", async () => {
	await expect(copyOriginalFile("-source", destination)).rejects.toThrow("absolute");
	expect(execFile).not.toHaveBeenCalled();
});
