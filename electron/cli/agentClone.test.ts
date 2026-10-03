// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyDocument } from "../../src/lib/ai-edition/schema";
import { cloneAgentProject } from "./agentClone";

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("agent clone", () => {
	it("writes a fresh project ID into the projects folder and leaves the source untouched", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "klippt-clone-"));
		dirs.push(dir);
		const source = path.join(dir, "Source.klippt");
		const original = JSON.stringify(
			createEmptyDocument({ title: "Original", projectId: "proj_original" }),
		);
		await writeFile(source, original);
		const projects = path.join(dir, "projects");
		const result = await cloneAgentProject(source, projects, "Copy");
		expect(result.project_id).toMatch(/^proj_/);
		expect(result.project_id).not.toBe("proj_original");
		expect(result.path).toBe(path.join(projects, `${result.project_id}.klippt`));
		const written = JSON.parse(await readFile(result.path, "utf8"));
		expect(written.project).toMatchObject({ id: result.project_id, title: "Copy" });
		expect(await readFile(source, "utf8")).toBe(original);
		expect(result.next_actions[0].command).toContain(result.project_id);
	});
});
