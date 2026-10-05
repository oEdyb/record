import type { CliDoneResult } from "../../src/lib/cliContracts";
import { writeJsonDurably } from "../filesystem/durableJson";
import type { CliCommand } from "./args";

export interface CliCompletionDependencies {
	consumeRecordingSession(): Promise<void>;
	writeProjectFile?(filePath: string, projectData: unknown): Promise<void>;
}

/**
 * Writes a project as one durable replacement. The recovery journal can be
 * removed only after this function resolves.
 */
export async function writeProjectFileDurably(
	filePath: string,
	projectData: unknown,
): Promise<void> {
	await writeJsonDurably(filePath, projectData, { followFinalSymlink: true });
}

/**
 * Commits all durable CLI output before it consumes recording recovery state.
 * A failed commit or journal cleanup returns a retryable CLI failure.
 */
export async function finalizeCliResult(
	command: CliCommand,
	result: CliDoneResult,
	dependencies: CliCompletionDependencies,
): Promise<CliDoneResult> {
	if (!result.success) return { ...result };
	const writeProjectFile = dependencies.writeProjectFile ?? writeProjectFileDurably;
	const finalized = { ...result };

	try {
		if (command.kind === "record" && command.projectOut) {
			if (result.projectData === undefined) {
				throw new Error("recording finished without the requested project data");
			}
			await writeProjectFile(command.projectOut, result.projectData);
			finalized.projectPath = command.projectOut;
		}
		if (command.kind === "captions") {
			if (result.projectData === undefined) {
				throw new Error("captioning finished without updated project data");
			}
			await writeProjectFile(command.projectPath, result.projectData);
		}
		if (command.kind === "record") {
			await dependencies.consumeRecordingSession();
		}
		return finalized;
	} catch (error) {
		return {
			...finalized,
			success: false,
			error: `Run succeeded but finalizing durable output failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}
