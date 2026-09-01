import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	createHelperManifest,
	HELPER_MANIFEST_NAME,
	readCmakeUpstreams,
	refreshHelperManifest,
	verifyBuiltUpstreams,
	verifyHelperManifest,
} from "./helper-provenance.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const upstreamSha = "89abcdef0123456789abcdef0123456789abcdef";
const temporaryDirectories = [];

async function fixture() {
	const directory = await mkdtemp(path.join(os.tmpdir(), "klippt-helper-provenance-"));
	temporaryDirectories.push(directory);
	await writeFile(path.join(directory, "whisper-stt-server"), "helper", { mode: 0o755 });
	await writeFile(path.join(directory, "libwhisper.dylib"), "sidecar");
	if (process.platform !== "win32") {
		await symlink("libwhisper.dylib", path.join(directory, "libwhisper.1.dylib"));
	}
	await createHelperManifest({
		directory,
		helper: "whisper-stt",
		sourceSha,
		workflowRunId: "12345",
		target: "darwin-arm64",
		upstream: [
			{
				name: "whisper.cpp",
				repository: "https://github.com/ggml-org/whisper.cpp.git",
				revision: upstreamSha,
			},
		],
		toolchains: { cmake: "cmake version 4.1.1", node: "v22.22.1" },
	});
	return directory;
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("native helper provenance", () => {
	it("derives immutable upstream revisions from the helper's CMake source", () => {
		expect(
			readCmakeUpstreams(path.join(REPO_ROOT, "electron/native/whisper-stt/CMakeLists.txt")),
		).toEqual([
			{
				name: "cpp-httplib",
				repository: "https://github.com/yhirose/cpp-httplib.git",
				revision: "5c1a34e766817cf0865ca8bc5af5edeb0f9b2df4",
			},
			{
				name: "nlohmann-json",
				repository: "https://github.com/nlohmann/json.git",
				revision: "9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03",
			},
			{
				name: "whisper.cpp",
				repository: "https://github.com/ggml-org/whisper.cpp.git",
				revision: "f049fff95a089aa9969deb009cdd4892b3e74916",
			},
		]);
	});

	it("creates and verifies a deterministic exact-file manifest", async () => {
		const directory = await fixture();
		const first = await readFile(path.join(directory, HELPER_MANIFEST_NAME), "utf8");
		await expect(
			verifyHelperManifest({
				directory,
				expectedSourceSha: sourceSha,
				expectedWorkflowRunId: "12345",
				expectedTarget: "darwin-arm64",
			}),
		).resolves.toMatchObject({
			helper: "whisper-stt",
			source: { commit: sourceSha, workflowRunId: "12345" },
		});
		await createHelperManifest({
			directory,
			helper: "whisper-stt",
			sourceSha,
			workflowRunId: "12345",
			target: "darwin-arm64",
			upstream: [
				{
					name: "whisper.cpp",
					repository: "https://github.com/ggml-org/whisper.cpp.git",
					revision: upstreamSha,
				},
			],
			toolchains: { cmake: "cmake version 4.1.1", node: "v22.22.1" },
		});
		expect(await readFile(path.join(directory, HELPER_MANIFEST_NAME), "utf8")).toBe(first);
	});

	it("rejects the wrong source, workflow, or target", async () => {
		const directory = await fixture();
		await expect(
			verifyHelperManifest({ directory, expectedSourceSha: "a".repeat(40) }),
		).rejects.toThrow(/source mismatch/);
		await expect(verifyHelperManifest({ directory, expectedWorkflowRunId: "999" })).rejects.toThrow(
			/workflow mismatch/,
		);
		await expect(verifyHelperManifest({ directory, expectedTarget: "darwin-x64" })).rejects.toThrow(
			/target mismatch/,
		);
	});

	it("rejects modified, missing, and unlisted files", async () => {
		const directory = await fixture();
		await writeFile(path.join(directory, "whisper-stt-server"), "changed");
		await expect(verifyHelperManifest({ directory })).rejects.toThrow(/size mismatch/);

		const clean = await fixture();
		await rm(path.join(clean, "libwhisper.dylib"));
		await expect(verifyHelperManifest({ directory: clean })).rejects.toThrow(/Missing/);

		const extra = await fixture();
		await writeFile(path.join(extra, "unlisted.dll"), "extra");
		await expect(verifyHelperManifest({ directory: extra })).rejects.toThrow(/absent/);
	});

	it("rejects a changed symlink target even when it resolves to the same file", async () => {
		if (process.platform === "win32") return;
		const directory = await fixture();
		const link = path.join(directory, "libwhisper.1.dylib");
		await rm(link);
		await symlink("./libwhisper.dylib", link);
		await expect(verifyHelperManifest({ directory })).rejects.toThrow(/symlink target mismatch/);
	});

	it("refreshes a manifest after a portable staging copy changes link topology", async () => {
		if (process.platform === "win32") return;
		const directory = await fixture();
		const link = path.join(directory, "libwhisper.1.dylib");
		await rm(link);
		await writeFile(link, "sidecar");
		await refreshHelperManifest(directory);
		await expect(verifyHelperManifest({ directory })).resolves.toBeDefined();
		const manifest = JSON.parse(await readFile(path.join(directory, HELPER_MANIFEST_NAME), "utf8"));
		expect(manifest.files.find((file) => file.path === "libwhisper.1.dylib")).not.toHaveProperty(
			"symlinkTarget",
		);
	});

	it("keeps the same Darwin content identity when only the code signature changes", async () => {
		if (process.platform !== "darwin") return;
		const directory = await mkdtemp(path.join(os.tmpdir(), "klippt-helper-signature-"));
		temporaryDirectories.push(directory);
		const helper = path.join(directory, "whisper-stt-server");
		await copyFile("/bin/echo", helper);
		execFileSync("/usr/bin/codesign", [
			"--force",
			"--sign",
			"-",
			"--identifier",
			"app.klippt.first",
			helper,
		]);
		await createHelperManifest({
			directory,
			helper: "whisper-stt",
			sourceSha,
			workflowRunId: "12345",
			target: "darwin-arm64",
			upstream: [
				{
					name: "whisper.cpp",
					repository: "https://github.com/ggml-org/whisper.cpp.git",
					revision: upstreamSha,
				},
			],
			toolchains: { cmake: "cmake version 4.1.1" },
		});
		execFileSync("/usr/bin/codesign", [
			"--force",
			"--sign",
			"-",
			"--identifier",
			"app.klippt.second",
			helper,
		]);
		await expect(verifyHelperManifest({ directory })).resolves.toBeDefined();
		const manifest = JSON.parse(await readFile(path.join(directory, HELPER_MANIFEST_NAME), "utf8"));
		expect(manifest.files[0]).toMatchObject({
			contentIdentity: "mach-o-without-code-signature",
			contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
		});
	});

	it("ignores hardened-signing growth in the Mach-O link-edit segment", async () => {
		if (process.platform !== "darwin") return;
		const directory = await mkdtemp(path.join(os.tmpdir(), "klippt-helper-linkedit-"));
		temporaryDirectories.push(directory);
		const helper = path.join(directory, "whisper-stt-server");
		const entitlements = path.join(directory, "distribution.entitlements");
		await copyFile("/bin/echo", helper);
		execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", helper]);
		await writeFile(
			entitlements,
			`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>`,
		);
		await createHelperManifest({
			directory,
			helper: "whisper-stt",
			sourceSha,
			workflowRunId: "12345",
			target: "darwin-arm64",
			upstream: [
				{
					name: "whisper.cpp",
					repository: "https://github.com/ggml-org/whisper.cpp.git",
					revision: upstreamSha,
				},
			],
			toolchains: { cmake: "cmake version 4.1.1" },
		});
		execFileSync("/usr/bin/codesign", [
			"--force",
			"--sign",
			"-",
			"--options",
			"runtime",
			"--entitlements",
			entitlements,
			helper,
		]);
		await expect(verifyHelperManifest({ directory })).resolves.toBeDefined();
	});

	it("rejects a Darwin helper whose code changed before it was re-signed", async () => {
		if (process.platform !== "darwin") return;
		const directory = await mkdtemp(path.join(os.tmpdir(), "klippt-helper-code-tamper-"));
		temporaryDirectories.push(directory);
		const helper = path.join(directory, "whisper-stt-server");
		await copyFile("/bin/echo", helper);
		execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", helper]);
		await createHelperManifest({
			directory,
			helper: "whisper-stt",
			sourceSha,
			workflowRunId: "12345",
			target: "darwin-arm64",
			upstream: [
				{
					name: "whisper.cpp",
					repository: "https://github.com/ggml-org/whisper.cpp.git",
					revision: upstreamSha,
				},
			],
			toolchains: { cmake: "cmake version 4.1.1" },
		});
		const bytes = await readFile(helper);
		const marker = Buffer.from("POSIXLY_CORRECT");
		const markerOffset = bytes.indexOf(marker);
		expect(markerOffset).toBeGreaterThan(0);
		bytes[markerOffset] = "Q".charCodeAt(0);
		await writeFile(helper, bytes);
		execFileSync("/usr/bin/codesign", ["--force", "--sign", "-", helper]);
		await expect(verifyHelperManifest({ directory })).rejects.toThrow(/hash mismatch/);
	});

	it("attests the actual FetchContent checkout instead of only its declaration", async () => {
		const buildRoot = await mkdtemp(path.join(os.tmpdir(), "klippt-helper-build-"));
		temporaryDirectories.push(buildRoot);
		const checkout = path.join(buildRoot, "_deps", "whisper-src");
		await import("node:fs/promises").then(({ mkdir }) => mkdir(checkout, { recursive: true }));
		execFileSync("git", ["init", "-q"], { cwd: checkout });
		execFileSync("git", ["config", "user.name", "Klippt test"], { cwd: checkout });
		execFileSync("git", ["config", "user.email", "test@klippt.app"], { cwd: checkout });
		execFileSync(
			"git",
			["remote", "add", "origin", "https://github.com/ggml-org/whisper.cpp.git"],
			{
				cwd: checkout,
			},
		);
		await writeFile(path.join(checkout, "README"), "first");
		execFileSync("git", ["add", "README"], { cwd: checkout });
		execFileSync("git", ["commit", "-qm", "fixture"], { cwd: checkout });
		const revision = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: checkout,
			encoding: "utf8",
		}).trim();
		const upstream = [
			{
				name: "whisper.cpp",
				repository: "https://github.com/ggml-org/whisper.cpp.git",
				revision,
			},
		];
		await expect(verifyBuiltUpstreams(buildRoot, upstream)).resolves.toBeUndefined();
		await writeFile(path.join(checkout, "README"), "second");
		execFileSync("git", ["commit", "-qam", "changed"], { cwd: checkout });
		await expect(verifyBuiltUpstreams(buildRoot, upstream)).rejects.toThrow(/revision mismatch/);
	});
});
