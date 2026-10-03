import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { loadAgentDocument } from "./agentInspection";

/** Copy a saved project under a fresh ID. Media stays where it is; the original is never written. */
export async function cloneAgentProject(
	projectPath: string,
	projectsDirectory: string,
	title?: string,
) {
	const loaded = await loadAgentDocument(projectPath);
	const now = new Date().toISOString();
	const projectId = `proj_${randomUUID()}`;
	const document = documentSchema.parse({
		...loaded.document,
		project: {
			...loaded.document.project,
			id: projectId,
			title: title ?? `${loaded.document.project.title} (agent copy)`,
			createdAt: now,
			updatedAt: now,
		},
	});
	await fs.mkdir(projectsDirectory, { recursive: true });
	const target = path.join(projectsDirectory, `${projectId}.klippt`);
	await fs.writeFile(target, JSON.stringify(document, null, 2), { flag: "wx" });
	return {
		project_id: projectId,
		path: target,
		title: document.project.title,
		source: path.resolve(projectPath),
		source_snapshot: loaded.snapshot,
		next_actions: [{ command: `klippt agent open --project_id ${projectId}` }],
	};
}
