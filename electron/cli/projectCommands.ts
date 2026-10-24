// The two CLI commands that only touch the project file and its media:
// `openscreen pack` and `openscreen info`. They live outside cliMain.ts so they
// carry no `electron` import and stay unit-testable — the caller passes the
// writer, so nothing here knows about process.stdout either.

import fs from "node:fs/promises";
import path from "node:path";

/** Writes one already-newline-terminated chunk of CLI output. */
export type CliWriter = (text: string) => void;

export interface PackedProjectData {
	version?: number;
	schemaVersion?: number;
	media?: { screenVideoPath?: string; webcamVideoPath?: string; cursorCaptureMode?: string };
	videoPath?: string;
	assets?: Array<{ id?: string; kind?: string; originalPath?: string }>;
	editor?: Record<string, unknown>;
}

function primaryScreenVideoPath(data: PackedProjectData): string | null {
	return (
		data.media?.screenVideoPath ??
		data.videoPath ??
		data.assets?.find((asset) => asset.kind === "video" && typeof asset.originalPath === "string")
			?.originalPath ??
		null
	);
}

const isFile = (candidate: string): Promise<boolean> =>
	fs
		.stat(candidate)
		.then((stats) => stats.isFile())
		.catch(() => false);

/** Copies a project and everything it references into one portable folder. */
export async function runPackCommand(
	projectPath: string,
	outDir: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const emit = (message: string) => {
		if (!json) out(`${message}\n`);
	};

	const raw = await fs.readFile(projectPath, "utf8");
	const data = JSON.parse(raw) as PackedProjectData;
	const media = data.media ?? (data.videoPath ? { screenVideoPath: data.videoPath } : undefined);
	const screenVideoPath = primaryScreenVideoPath(data);
	if (!screenVideoPath) {
		throw new Error("Project file does not reference a screen video");
	}

	const projectDir = path.dirname(path.resolve(projectPath));
	const resolveSource = async (mediaPath: string): Promise<string> => {
		if (await isFile(mediaPath)) return mediaPath;
		// Moved project: the stored absolute path is stale but the media travelled
		// with the project file. Same rule as the loader's sibling fallback.
		const sibling = path.join(projectDir, path.basename(mediaPath));
		if (await isFile(sibling)) return sibling;
		throw new Error(`Referenced media not found: ${mediaPath}`);
	};

	await fs.mkdir(outDir, { recursive: true });

	const copied: string[] = [];
	const copiedBySource = new Map<string, string>();
	const copyIn = async (sourcePath: string): Promise<string> => {
		const key = path.resolve(sourcePath);
		const existing = copiedBySource.get(key);
		if (existing) return existing;
		const ext = path.extname(sourcePath);
		const stem = path.basename(sourcePath, ext);
		let destination = path.join(outDir, stem + ext);
		// Screen and webcam can share a basename across directories; don't overwrite.
		for (let n = 1; copied.includes(destination); n++) {
			destination = path.join(outDir, `${stem}-${n}${ext}`);
		}
		if (key !== path.resolve(destination)) {
			await fs.copyFile(sourcePath, destination);
		}
		copiedBySource.set(key, destination);
		copied.push(destination);
		return destination;
	};

	const screenSource = await resolveSource(screenVideoPath);
	const newScreenPath = await copyIn(screenSource);

	let newWebcamPath: string | undefined;
	if (media?.webcamVideoPath) {
		newWebcamPath = await copyIn(await resolveSource(media.webcamVideoPath));
	}

	const assets = data.assets
		? await Promise.all(
				data.assets.map(async (asset) => {
					if (!asset.originalPath) return asset;
					const source = await resolveSource(asset.originalPath);
					return { ...asset, originalPath: await copyIn(source) };
				}),
			)
		: undefined;

	// Cursor telemetry sidecar sits at "<video path>.cursor.json".
	const cursorSidecar = `${screenSource}.cursor.json`;
	let hasCursorData = await isFile(cursorSidecar);
	if (hasCursorData) {
		await copyIn(cursorSidecar);
	}
	for (const asset of data.assets ?? []) {
		if (asset.kind !== "video" || !asset.originalPath) continue;
		const source = await resolveSource(asset.originalPath);
		const sidecar = `${source}.cursor.json`;
		if (await isFile(sidecar)) {
			hasCursorData = true;
			await copyIn(sidecar);
		}
	}

	const packedProject: PackedProjectData = {
		...data,
		...(assets ? { assets } : {}),
		media: {
			...media,
			screenVideoPath: newScreenPath,
			...(newWebcamPath ? { webcamVideoPath: newWebcamPath } : {}),
		},
	};
	delete packedProject.videoPath;
	const packedProjectPath = path.join(outDir, path.basename(projectPath));
	await fs.writeFile(packedProjectPath, JSON.stringify(packedProject, null, 2), "utf8");

	if (json) {
		out(
			`${JSON.stringify({
				event: "done",
				success: true,
				projectPath: packedProjectPath,
				files: [packedProjectPath, ...copied],
				cursorData: hasCursorData,
			})}\n`,
		);
	} else {
		emit(`Packed project → ${packedProjectPath}`);
		for (const file of copied) {
			emit(`  + ${path.basename(file)}`);
		}
		if (!hasCursorData) {
			emit("  (no cursor telemetry sidecar found)");
		}
		emit(
			"The folder is self-contained: if the stored paths go stale after moving it, the loader falls back to files next to the project.",
		);
	}
	return 0;
}

/** Prints what a project references and whether its media is still reachable. */
export async function runInfoCommand(
	projectPath: string,
	json: boolean,
	out: CliWriter,
): Promise<number> {
	const raw = await fs.readFile(projectPath, "utf8");
	const data = JSON.parse(raw) as PackedProjectData;
	const editor = data.editor ?? {};
	const count = (key: string) =>
		Array.isArray(editor[key]) ? (editor[key] as unknown[]).length : 0;
	const screenVideoPath = primaryScreenVideoPath(data);
	const mediaExists = screenVideoPath
		? await fs
				.access(screenVideoPath)
				.then(() => true)
				.catch(() => false)
		: false;

	const summary = {
		projectPath,
		version: data.version ?? data.schemaVersion ?? null,
		screenVideoPath,
		screenVideoExists: mediaExists,
		webcamVideoPath: data.media?.webcamVideoPath ?? null,
		cursorCaptureMode: data.media?.cursorCaptureMode ?? null,
		exportFormat: (editor.exportFormat as string) ?? null,
		exportQuality: (editor.exportQuality as string) ?? null,
		aspectRatio: (editor.aspectRatio as string) ?? null,
		zoomRegions: count("zoomRegions"),
		trimRegions: count("trimRegions"),
		speedRegions: count("speedRegions"),
		annotationRegions: count("annotationRegions"),
	};

	if (json) {
		out(`${JSON.stringify(summary)}\n`);
	} else {
		out(
			[
				`Project:  ${summary.projectPath} (version ${summary.version ?? "?"})`,
				`Video:    ${summary.screenVideoPath ?? "(none)"}${mediaExists ? "" : "  [MISSING]"}`,
				`Webcam:   ${summary.webcamVideoPath ?? "(none)"}`,
				`Cursor:   ${summary.cursorCaptureMode ?? "(unknown)"}`,
				`Export:   ${summary.exportFormat ?? "?"} / ${summary.exportQuality ?? "?"} / ${summary.aspectRatio ?? "?"}`,
				`Timeline: ${summary.zoomRegions} zooms, ${summary.trimRegions} trims, ${summary.speedRegions} speed regions, ${summary.annotationRegions} annotations`,
			].join("\n") + "\n",
		);
	}
	return summary.screenVideoPath && !mediaExists ? 1 : 0;
}
