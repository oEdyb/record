import { execFileSync } from "node:child_process";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createHelperManifest } from "./helper-provenance.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceSha = "0123456789abcdef0123456789abcdef01234567";
const temporaryDirectories = [];

async function fixture(runHeadSha = sourceSha) {
	const root = await mkdtemp(path.join(os.tmpdir(), "klippt-stage-whisper-"));
	temporaryDirectories.push(root);
	await mkdir(path.join(root, "scripts"));
	await mkdir(path.join(root, "fake-bin"));
	await copyFile(
		path.join(REPO_ROOT, "scripts", "stage-whisper-stt.sh"),
		path.join(root, "scripts", "stage-whisper-stt.sh"),
	);
	await copyFile(
		path.join(REPO_ROOT, "scripts", "helper-provenance.mjs"),
		path.join(root, "scripts", "helper-provenance.mjs"),
	);

	const bagName = "whisper-stt-darwin-arm64";
	const artifactRoot = path.join(root, "artifact");
	const bag = path.join(artifactRoot, bagName);
	await mkdir(bag, { recursive: true });
	const helper = path.join(bag, "whisper-stt-server");
	await writeFile(helper, "#!/bin/sh\necho '[whisper-stt] boot: fixture' >&2\nexit 1\n");
	await chmod(helper, 0o755);
	await writeFile(path.join(bag, "libwhisper.dylib"), "sidecar");
	if (process.platform !== "win32") {
		await symlink("libwhisper.dylib", path.join(bag, "libwhisper.1.dylib"));
	}
	await createHelperManifest({
		directory: bag,
		helper: "whisper-stt",
		sourceSha,
		workflowRunId: "777",
		target: "darwin-arm64",
		upstream: [
			{
				name: "whisper.cpp",
				repository: "https://github.com/ggml-org/whisper.cpp.git",
				revision: "f049fff95a089aa9969deb009cdd4892b3e74916",
			},
		],
		toolchains: { cmake: "fixture" },
	});
	const archive = path.join(root, `${bagName}.tar.gz`);
	execFileSync("tar", ["-czf", archive, bagName], { cwd: artifactRoot });

	const fakeGh = path.join(root, "fake-bin", "gh");
	await writeFile(
		fakeGh,
		`#!/bin/sh
set -eu
if [ "$1" = api ]; then
  printf '%s\\n' "$FAKE_RUN_HEAD_SHA"
  exit 0
fi
if [ "$1" = run ] && [ "$2" = download ]; then
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --dir ]; then
      shift
      cp "$FAKE_ARCHIVE" "$1/"
      exit 0
    fi
    shift
  done
fi
exit 2
`,
	);
	await chmod(fakeGh, 0o755);
	return { root, archive, runHeadSha };
}

function runStage(test) {
	return execFileSync("/bin/bash", ["scripts/stage-whisper-stt.sh", "darwin-arm64"], {
		cwd: test.root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			CI: "true",
			FAKE_ARCHIVE: test.archive,
			FAKE_RUN_HEAD_SHA: test.runHeadSha,
			GITHUB_REPOSITORY: "oEdyb/record",
			KLIPPT_HELPER_RUN_ID: "777",
			KLIPPT_SOURCE_SHA: sourceSha,
			PATH: `${path.join(test.root, "fake-bin")}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
		},
	});
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("Whisper helper staging", () => {
	it("downloads and verifies the same-run helper before staging it", async () => {
		const test = await fixture();
		expect(runStage(test)).toContain("Staged whisper-stt-server");
		await expect(
			import("node:fs/promises").then(({ stat }) =>
				stat(path.join(test.root, "electron/native/bin/darwin-arm64/klippt-helper-manifest.json")),
			),
		).resolves.toBeDefined();
		if (process.platform !== "win32") {
			const staged = path.join(test.root, "electron/native/bin/darwin-arm64/libwhisper.1.dylib");
			expect((await lstat(staged)).isSymbolicLink()).toBe(false);
			const manifest = JSON.parse(
				await readFile(
					path.join(test.root, "electron/native/bin/darwin-arm64/klippt-helper-manifest.json"),
					"utf8",
				),
			);
			expect(manifest.files.find((file) => file.path === "libwhisper.1.dylib")).not.toHaveProperty(
				"symlinkTarget",
			);
		}
	});

	it("rejects a helper workflow from another source commit", async () => {
		const test = await fixture("a".repeat(40));
		expect(() => runStage(test)).toThrow(/does not match release/);
	});
});
