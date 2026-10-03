import fs from "node:fs/promises";
import path from "node:path";
import { resolveFinalSymlink, writeJsonDurably } from "./durableJson";

/** Resolve existing ancestors too, including a symlinked parent of a new file. */
async function resolvedDestination(candidate: string): Promise<string> {
	try {
		return await fs.realpath(candidate);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = path.dirname(candidate);
		if (parent === candidate) throw error;
		return path.join(await resolvedDestination(parent), path.basename(candidate));
	}
}
function inside(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}
/** The legacy Save/Save As path owns standalone files, never managed projects.
 * Refusing the whole managed directory prevents an adoption race between checking
 * a marker and replacing a file. The app owner protects these directories from
 * concurrent path replacement; this is not a hostile-filesystem sandbox.
 */
export async function writeUnmanagedProjectFile(
	filePath: string,
	projectData: unknown,
	managedDirectory: string,
): Promise<void> {
	const [destination, managed] = await Promise.all([
		resolvedDestination(await resolveFinalSymlink(path.resolve(filePath))),
		resolvedDestination(path.resolve(managedDirectory)),
	]);
	if (inside(managed, destination))
		throw new Error(
			"Managed projects must be saved through the editor transaction service. Choose another location for Save As.",
		);
	if (projectData && typeof projectData === "object" && "_klipptTransactions" in projectData)
		throw new Error(
			"A transaction-aware project needs an explicit project-copy operation; Save As cannot copy its mutation identity.",
		);
	try {
		const stats = await fs.stat(destination);
		if (!stats.isFile() || stats.size > 32 * 1024 * 1024)
			throw new Error(
				"Existing destination cannot be safely inspected. Choose a new Save As path.",
			);
		const existing: unknown = JSON.parse(await fs.readFile(destination, "utf8"));
		if (existing && typeof existing === "object" && "_klipptTransactions" in existing)
			throw new Error(
				"Transaction-aware project overwrite refused. Its revision and receipts must remain intact.",
			);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	// Use the resolved target. Do not follow a newly substituted final symlink.
	await writeJsonDurably(destination, projectData);
}
