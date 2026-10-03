import fs from "node:fs/promises";
import path from "node:path";
import { contactSheet } from "./agentAssets";
import { loadAgentDocument } from "./agentInspection";
import { type AgentPreviewLaunch, renderAgentPreview } from "./agentPreview";
import {
	editedToExportTime,
	parseTimeInput,
	resolveEditedSeconds,
	TIME_BASE_LABELS,
	type TimeInput,
} from "./agentTimeBase";

// The export-clock conversion lives in agentTimeBase; keep the old import path working.
export { editedToExportTime as editedFrameTime } from "./agentTimeBase";

export async function renderAgentFrames(
	options: {
		projectPath: string;
		/** Numbers are edited seconds (documented default); TimeInput carries an explicit base. */
		at: (number | TimeInput)[];
		out?: string;
		cacheDirectory: string;
		launch: AgentPreviewLaunch;
		ffmpeg?: string;
		sheet: boolean;
	},
	render = renderAgentPreview,
) {
	if (!options.at.length || options.at.length > 24)
		throw new Error("FRAME_LIMIT: Supply 1 through 24 times.");
	if (options.out && !path.isAbsolute(options.out))
		throw new Error("FRAME_OUTPUT_INVALID: Use an absolute path.");
	if (!options.sheet && options.out && path.extname(options.out).toLowerCase() !== ".png")
		throw new Error("FRAME_OUTPUT_INVALID: Use a PNG filename.");
	const loaded = await loadAgentDocument(options.projectPath);
	// --at converts the EDITOR clock (edited by default, e/r/s suffixes allowed)
	// into export-clock render times; preview --time IS the export clock.
	const editedTimes = options.at.map((at) =>
		resolveEditedSeconds(loaded.document, parseTimeInput(at, "edited")),
	);
	const times = editedTimes.map((at) => editedToExportTime(loaded.document, at));
	const directory = options.sheet && options.out ? options.out : options.cacheDirectory;
	await fs.mkdir(directory, { recursive: true });
	const frames = [];
	for (const [i, time] of times.entries()) {
		const start = performance.now();
		const result = await render({
			projectPath: options.projectPath,
			snapshot: loaded.snapshot.sha256,
			outputDirectory: directory,
			time,
			launch: options.launch,
		});
		const target = !options.sheet && options.out ? options.out : result.frame_path;
		if (target !== result.frame_path)
			await fs.copyFile(result.frame_path, target, fs.constants.COPYFILE_EXCL);
		frames.push({
			at: editedTimes[i],
			exportTimeSec: time,
			path: target,
			elapsedMs: Math.round(performance.now() - start),
			manifest: result.manifest_path,
		});
	}
	const sheet = options.sheet
		? await contactSheet(
				frames.map((f) => f.path),
				directory,
				options.ffmpeg ?? "",
			)
		: undefined;
	return {
		snapshot: loaded.snapshot.sha256,
		frames,
		...(sheet ? { contactSheet: sheet } : {}),
		warmFrameTargetMs: 1000,
		time_bases: {
			at: TIME_BASE_LABELS.edited,
			exportTimeSec: TIME_BASE_LABELS.output,
		},
	};
}
