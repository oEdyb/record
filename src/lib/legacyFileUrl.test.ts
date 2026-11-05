import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { fromLegacyFileUrl } from "./legacyFileUrl";

it("opens the actual legacy file whose name contains URL delimiters", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "legacy-media-"));
	const file = path.join(directory, "part#1?camera.mp4");
	await writeFile(file, "original media");
	expect(await readFile(fromLegacyFileUrl(`file://${file}`), "utf8")).toBe("original media");
	expect(
		await readFile(
			fromLegacyFileUrl(
				new URL(`file://${file.replaceAll("#", "%23").replaceAll("?", "%3F")}`).href,
			),
			"utf8",
		),
	).toBe("original media");
});
