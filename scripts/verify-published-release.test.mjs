import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { nativeFfmpegEvidenceFileNames } from "./native-ffmpeg-source.mjs";
import { stageUpdateRelease } from "./stage-update-release.mjs";
import { verifyPublishedRelease } from "./verify-published-release.mjs";
import { loadWebDemuxerPolicy, sourceOfferFileNames } from "./web-demuxer-source.mjs";

const version = "2.0.0";
const fileNames = [
	`Klippt-macOS-Apple-Silicon-${version}.dmg`,
	`Klippt-macOS-Intel-${version}.dmg`,
	`Klippt.Setup.${version}.exe`,
	`Klippt-Linux-${version}.AppImage`,
	`Klippt-Mac-arm64-${version}.zip`,
	`Klippt-Mac-x64-${version}.zip`,
];
const temporaryDirectories = [];
const servers = [];
const sourceEvidence = [
	...sourceOfferFileNames(loadWebDemuxerPolicy()),
	...["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"].flatMap(
		nativeFfmpegEvidenceFileNames,
	),
];

async function fixture() {
	const root = await mkdtemp(path.join(os.tmpdir(), "klippt-public-release-"));
	temporaryDirectories.push(root);
	const source = path.join(root, "source");
	const staged = path.join(root, "staged");
	await mkdir(source);
	for (const fileName of fileNames) await writeFile(path.join(source, fileName), fileName);
	for (const fileName of sourceEvidence) await writeFile(path.join(source, fileName), fileName);
	const descriptor = (fileName) => ({
		url: fileName,
		size: Buffer.byteLength(fileName),
		sha512: createHash("sha512").update(fileName).digest("base64"),
	});
	await writeFile(
		path.join(source, "latest.yml"),
		stringify({ files: [descriptor(fileNames[2])] }),
	);
	await writeFile(
		path.join(source, "latest-mac.yml"),
		stringify({ files: [descriptor(fileNames[4]), descriptor(fileNames[5])] }),
	);
	await writeFile(
		path.join(source, "latest-linux.yml"),
		stringify({ files: [descriptor(fileNames[3])] }),
	);
	stageUpdateRelease(source, version, staged, "0123456789abcdef0123456789abcdef01234567");
	let tampered;
	const server = createServer(async (request, response) => {
		const fileName = decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1));
		try {
			const body = await readFile(path.join(staged, fileName));
			response.writeHead(200);
			response.end(fileName === tampered ? Buffer.from("wrong") : body);
		} catch {
			response.writeHead(404);
			response.end();
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	servers.push(server);
	const address = server.address();
	return {
		staged,
		baseUrl: `http://127.0.0.1:${address.port}`,
		tamper(fileName) {
			tampered = fileName;
		},
	};
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
	);
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("public release verification", () => {
	it("checks immutable artifacts before feeds and every file after feeds", async () => {
		const test = await fixture();
		await expect(
			verifyPublishedRelease({ root: test.staged, baseUrl: test.baseUrl, immutableOnly: true }),
		).resolves.toHaveProperty(fileNames[0]);
		await expect(
			verifyPublishedRelease({
				root: test.staged,
				baseUrl: test.baseUrl,
				expectedSourceSha: "0123456789abcdef0123456789abcdef01234567",
			}),
		).resolves.toHaveProperty("latest.json");
	});

	it("rejects a missing or changed public artifact", async () => {
		const test = await fixture();
		test.tamper(fileNames[2]);
		await expect(
			verifyPublishedRelease({ root: test.staged, baseUrl: test.baseUrl, timeoutMs: 1_000 }),
		).rejects.toThrow(/Public release mismatch/);
	});
});
